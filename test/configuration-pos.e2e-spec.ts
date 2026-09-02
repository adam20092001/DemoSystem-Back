import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Ticket A post-MVP — GET /api/v1/configuration/pos. Suite dedicada (no se
 * extiende configuration.e2e-spec.ts): este endpoint es puramente aditivo,
 * de solo lectura, y sin efecto de auditoría — no comparte la limpieza de
 * AuditLog ni el baseline PATCH de esa suite. Reutiliza fixtures
 * SELLER/WAREHOUSE/MANAGEMENT propias (usernames exclusivos de este
 * archivo, nunca los de configuration.e2e-spec.ts) vía el mismo
 * upsertFixtureUser() compartido — idempotente, así que rerender esta
 * suite nunca duplica usuarios ni deja residuo que limpiar (no crea
 * ninguna fila propia de negocio: ni AuditLog, ni Payment, ni nada mutable).
 */
const SELLER_USERNAME = 'e2e_seller_configuration_pos';
const SELLER_PASSWORD = 'SellerConfigPos123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_configuration_pos';
const WAREHOUSE_PASSWORD = 'WarehouseConfigPos123';
const MANAGEMENT_USERNAME = 'e2e_management_configuration_pos';
const MANAGEMENT_PASSWORD = 'ManagementConfigPos123';

const APPROVED_POS_FIELDS = [
  'businessName',
  'tradeName',
  'taxId',
  'address',
  'currencyCode',
  'currencySymbol',
  'taxEnabled',
  'taxRate',
  'maxDiscountPercent',
];

const FORBIDDEN_ADMIN_ONLY_FIELDS = [
  'id',
  'phone',
  'email',
  'quoteValidityDays',
  'createdAt',
  'updatedAt',
];

interface SafePosConfigurationBody {
  businessName: string;
  tradeName: string | null;
  taxId: string | null;
  address: string | null;
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  taxRate: string;
  maxDiscountPercent: string;
}

describe('Configuration POS (e2e) — Ticket A post-MVP', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_configuration_pos@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_configuration_pos@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_configuration_pos@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });

    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(
        `No se pudo autenticar al admin de prueba: ${JSON.stringify(adminLogin.body)}`,
      );
    }
    adminCookie = adminLogin.cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
  });

  afterAll(async () => {
    // Endpoint puramente de lectura, sin auditoría ni mutación: no hay
    // ningún residuo propio de esta suite que limpiar (a diferencia de
    // configuration.e2e-spec.ts, que sí genera CONFIGURATION_UPDATED).
    await app.close();
    await prisma.$disconnect();
  });

  it('sin cookie responde 401', async () => {
    const response = await request(app.getHttpServer()).get(
      '/api/v1/configuration/pos',
    );
    expect(response.status).toBe(401);
  });

  it('ADMIN: 200', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/configuration/pos')
      .set('Cookie', adminCookie);
    expect(response.status).toBe(200);
  });

  it('MANAGEMENT: 200', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/configuration/pos')
      .set('Cookie', managementCookie);
    expect(response.status).toBe(200);
  });

  it('SELLER: 200 (a diferencia de GET /configuration, que le responde 403)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/configuration/pos')
      .set('Cookie', sellerCookie);
    expect(response.status).toBe(200);
  });

  it('WAREHOUSE: 403', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/configuration/pos')
      .set('Cookie', warehouseCookie);
    expect(response.status).toBe(403);
  });

  it('la respuesta contiene EXACTAMENTE los 9 campos aprobados, ni uno más ni uno menos', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/configuration/pos')
      .set('Cookie', sellerCookie);

    expect(response.status).toBe(200);
    const keys = Object.keys(response.body as Record<string, unknown>).sort();
    expect(keys).toEqual([...APPROVED_POS_FIELDS].sort());

    for (const forbidden of FORBIDDEN_ADMIN_ONLY_FIELDS) {
      expect(response.body).not.toHaveProperty(forbidden);
    }
  });

  it('tipos/valores coinciden exactamente con GET /configuration para los campos compartidos', async () => {
    const adminFullResponse = await request(app.getHttpServer())
      .get('/api/v1/configuration')
      .set('Cookie', adminCookie);
    expect(adminFullResponse.status).toBe(200);
    const fullBody = adminFullResponse.body as Record<string, unknown>;

    const posResponse = await request(app.getHttpServer())
      .get('/api/v1/configuration/pos')
      .set('Cookie', sellerCookie);
    expect(posResponse.status).toBe(200);
    const posBody = posResponse.body as SafePosConfigurationBody;

    expect(posBody.businessName).toBe(fullBody.businessName);
    expect(posBody.tradeName).toBe(fullBody.tradeName);
    expect(posBody.taxId).toBe(fullBody.taxId);
    expect(posBody.address).toBe(fullBody.address);
    expect(posBody.currencyCode).toBe(fullBody.currencyCode);
    expect(posBody.currencySymbol).toBe(fullBody.currencySymbol);
    expect(posBody.taxEnabled).toBe(fullBody.taxEnabled);
    expect(posBody.taxRate).toBe(fullBody.taxRate);
    expect(posBody.maxDiscountPercent).toBe(fullBody.maxDiscountPercent);

    expect(typeof posBody.businessName).toBe('string');
    expect(typeof posBody.currencyCode).toBe('string');
    expect(typeof posBody.currencySymbol).toBe('string');
    expect(typeof posBody.taxEnabled).toBe('boolean');
    expect(typeof posBody.taxRate).toBe('string');
    expect(typeof posBody.maxDiscountPercent).toBe('string');
  });

  it('regresión: SELLER sigue recibiendo 403 en PATCH /configuration (sin permiso de mutación administrativa)', async () => {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/configuration')
      .set('Cookie', sellerCookie)
      .send({ businessName: 'Intento no autorizado' });
    expect(response.status).toBe(403);
  });

  it('regresión: SELLER sigue recibiendo 403 en GET /configuration (surface administrativo sin cambios)', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/configuration')
      .set('Cookie', sellerCookie);
    expect(response.status).toBe(403);
  });

  it('regresión: ADMIN/MANAGEMENT conservan 200 en GET /configuration (surface administrativo sin cambios)', async () => {
    const admin = await request(app.getHttpServer())
      .get('/api/v1/configuration')
      .set('Cookie', adminCookie);
    expect(admin.status).toBe(200);

    const management = await request(app.getHttpServer())
      .get('/api/v1/configuration')
      .set('Cookie', managementCookie);
    expect(management.status).toBe(200);
  });
});
