import { INestApplication } from '@nestjs/common';
import {
  PaymentMethodAccountingDestination,
  PrismaClient,
  RoleName,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Ticket C post-MVP, Bloque C2 — PaymentMethodsModule. Suite dedicada,
 * puramente de administración: nada aquí ejercita PaymentEngine/Payments
 * (eso llega en el Bloque C3). Los 9 baseline (5 activos + 4 legacy
 * inactivos, sembrados por el Bloque C1) NUNCA se mutan ni se borran desde
 * esta suite — todo custom method creado aquí usa un `code` único por
 * corrida y se elimina físicamente en `afterAll` por su ID exacto (nunca
 * `deleteMany({})` sobre toda la tabla).
 */
const SELLER_USERNAME = 'e2e_seller_payment_methods';
const SELLER_PASSWORD = 'SellerPaymentMethods123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_payment_methods';
const WAREHOUSE_PASSWORD = 'WarehousePaymentMethods123';
const MANAGEMENT_USERNAME = 'e2e_management_payment_methods';
const MANAGEMENT_PASSWORD = 'ManagementPaymentMethods123';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const DEFAULT_ACTIVE_CODES = ['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN'];
const LEGACY_INACTIVE_CODES = [
  'BANK_TRANSFER',
  'BANK_DEPOSIT',
  'DIGITAL_WALLET',
  'OTHER',
];
const ALL_BASELINE_CODES = [...DEFAULT_ACTIVE_CODES, ...LEGACY_INACTIVE_CODES];

/** Code único por corrida, corto (política: 2-30 caracteres). */
const CUSTOM_CODE = `E2E_PM_${Date.now() % 1000000}`;

interface SafePaymentMethodBody {
  id: string;
  code: string;
  name: string;
  active: boolean;
  requiresReference: boolean;
  affectsCashDrawer: boolean;
  accountingDestination: PaymentMethodAccountingDestination;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
}

describe('Payment Methods (e2e) — Ticket C, Bloque C2', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  /** ID propio del método personalizado creado por esta suite (cleanup exacto en afterAll). */
  let customMethodId: string | undefined;
  /** IDs propios de AuditLog generados por esta suite. */
  const ownedAuditLogIds: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_payment_methods@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_payment_methods@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_payment_methods@demosystem.test',
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
    try {
      // Auditoría propia primero (mismo orden que el resto del dominio: la
      // FK AuditLog.userId -> User es onDelete: SetNull, pero aquí no se
      // borra ningún User, así que el orden solo importa por prolijidad).
      if (ownedAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedAuditLogIds } },
        });
      }
      // Eliminación física del ÚNICO custom method propio de esta suite,
      // por su ID exacto — nunca deleteMany({}) sobre payment_methods,
      // nunca se toca ninguno de los 9 baseline.
      if (customMethodId !== undefined) {
        await prisma.paymentMethod.delete({
          where: { id: customMethodId },
        });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  async function trackLatestAuditRow(
    action: AuditAction,
    entityId: string,
  ): Promise<{ id: string; description: string; metadata: unknown }> {
    const row = await prisma.auditLog.findFirst({
      where: { action, entityId },
      orderBy: { createdAt: 'desc' },
    });
    if (row === null) {
      throw new Error(
        `Se esperaba una fila ${action} recién creada para ${entityId} y no se encontró ninguna`,
      );
    }
    ownedAuditLogIds.push(row.id);
    return row;
  }

  describe('autorización', () => {
    it('GET sin cookie responde 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/payment-methods',
      );
      expect(response.status).toBe(401);
    });

    it('WAREHOUSE: GET 403', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', warehouseCookie);
      expect(response.status).toBe(403);
    });

    it('SELLER: lista activa 200, includeInactive=true 403, POST 403, PATCH 403', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', sellerCookie);
      expect(list.status).toBe(200);

      const inactive = await request(app.getHttpServer())
        .get('/api/v1/payment-methods?includeInactive=true')
        .set('Cookie', sellerCookie);
      expect(inactive.status).toBe(403);

      const post = await request(app.getHttpServer())
        .post('/api/v1/payment-methods')
        .set('Cookie', sellerCookie)
        .send({
          code: 'SELLER_NOPE',
          name: 'No debería crearse',
          requiresReference: false,
          affectsCashDrawer: false,
          accountingDestination: 'BANK',
        });
      expect(post.status).toBe(403);

      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${NON_EXISTENT_UUID}`)
        .set('Cookie', sellerCookie)
        .send({ name: 'No debería aplicarse' });
      expect(patch.status).toBe(403);
    });

    it('MANAGEMENT: lista activa 200, includeInactive=true 403, POST 403, PATCH 403', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', managementCookie);
      expect(list.status).toBe(200);

      const inactive = await request(app.getHttpServer())
        .get('/api/v1/payment-methods?includeInactive=true')
        .set('Cookie', managementCookie);
      expect(inactive.status).toBe(403);

      const post = await request(app.getHttpServer())
        .post('/api/v1/payment-methods')
        .set('Cookie', managementCookie)
        .send({
          code: 'MGMT_NOPE',
          name: 'No debería crearse',
          requiresReference: false,
          affectsCashDrawer: false,
          accountingDestination: 'BANK',
        });
      expect(post.status).toBe(403);

      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${NON_EXISTENT_UUID}`)
        .set('Cookie', managementCookie)
        .send({ name: 'No debería aplicarse' });
      expect(patch.status).toBe(403);
    });
  });

  describe('GET /payment-methods — baseline (Bloque C1)', () => {
    it('lista activa: contiene los 5 métodos default activos, no contiene los 4 legacy inactivos', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      const body = response.body as SafePaymentMethodBody[];
      const codes = body.map((row) => row.code);

      for (const code of DEFAULT_ACTIVE_CODES) {
        expect(codes).toContain(code);
      }
      for (const code of LEGACY_INACTIVE_CODES) {
        expect(codes).not.toContain(code);
      }
      expect(body.every((row) => row.active)).toBe(true);
    });

    it('ADMIN + includeInactive=true: contiene las 9 filas baseline', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payment-methods?includeInactive=true')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      const body = response.body as SafePaymentMethodBody[];
      const codes = body.map((row) => row.code);

      for (const code of ALL_BASELINE_CODES) {
        expect(codes).toContain(code);
      }
      const cash = body.find((row) => row.code === 'CASH');
      expect(cash).toMatchObject({
        name: 'Efectivo',
        active: true,
        requiresReference: false,
        affectsCashDrawer: true,
        accountingDestination: 'CASH',
      });
      const bankTransfer = body.find((row) => row.code === 'BANK_TRANSFER');
      expect(bankTransfer).toMatchObject({ active: false });
    });

    it('orden: sortOrder ASC', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payment-methods?includeInactive=true')
        .set('Cookie', adminCookie);

      const body = response.body as SafePaymentMethodBody[];
      const sortOrders = body.map((row) => row.sortOrder);
      const sorted = [...sortOrders].sort((a, b) => a - b);
      expect(sortOrders).toEqual(sorted);
    });

    it('includeInactive con valor no booleano -> 400', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/payment-methods?includeInactive=maybe')
        .set('Cookie', adminCookie);
      expect(response.status).toBe(400);
    });
  });

  describe('POST /payment-methods — ADMIN', () => {
    it('crea un método personalizado, nace active=true, y audita PAYMENT_METHOD_CREATED', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/payment-methods')
        .set('Cookie', adminCookie)
        .send({
          code: `  ${CUSTOM_CODE.toLowerCase()}  `,
          name: '  Método E2E  ',
          requiresReference: true,
          affectsCashDrawer: false,
          accountingDestination: 'BANK',
          sortOrder: 500,
        });

      expect(response.status).toBe(201);
      const body = response.body as SafePaymentMethodBody;
      expect(body.code).toBe(CUSTOM_CODE);
      expect(body.name).toBe('Método E2E');
      expect(body.active).toBe(true);
      customMethodId = body.id;

      const auditRow = await trackLatestAuditRow(
        AuditAction.PAYMENT_METHOD_CREATED,
        body.id,
      );
      assertAuditRowHasNoSecrets(auditRow);

      const listResponse = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', sellerCookie);
      const codes = (listResponse.body as SafePaymentMethodBody[]).map(
        (row) => row.code,
      );
      expect(codes).toContain(CUSTOM_CODE);
    });

    it('duplicate code -> 409', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/payment-methods')
        .set('Cookie', adminCookie)
        .send({
          code: CUSTOM_CODE,
          name: 'Duplicado',
          requiresReference: false,
          affectsCashDrawer: false,
          accountingDestination: 'BANK',
        });
      expect(response.status).toBe(409);
    });

    it('code con formato inválido -> 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/payment-methods')
        .set('Cookie', adminCookie)
        .send({
          code: '1INVALID',
          name: 'Inválido',
          requiresReference: false,
          affectsCashDrawer: false,
          accountingDestination: 'BANK',
        });
      expect(response.status).toBe(400);
    });

    it('accountingDestination inválido -> 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/payment-methods')
        .set('Cookie', adminCookie)
        .send({
          code: 'E2E_BADDEST',
          name: 'Destino inválido',
          requiresReference: false,
          affectsCashDrawer: false,
          accountingDestination: 'WALLET',
        });
      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /payment-methods/:id — ADMIN', () => {
    it('actualiza name y audita PAYMENT_METHOD_UPDATED', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${customMethodId}`)
        .set('Cookie', adminCookie)
        .send({ name: 'Método E2E Renombrado' });

      expect(response.status).toBe(200);
      const body = response.body as SafePaymentMethodBody;
      expect(body.name).toBe('Método E2E Renombrado');
      expect(body.code).toBe(CUSTOM_CODE);

      const auditRow = await trackLatestAuditRow(
        AuditAction.PAYMENT_METHOD_UPDATED,
        customMethodId!,
      );
      const metadata = auditRow.metadata as { changedFields: string[] };
      expect(metadata.changedFields).toEqual(['name']);
    });

    it('code en el body -> 400 (ValidationPipe forbidNonWhitelisted), nunca lo modifica', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${customMethodId}`)
        .set('Cookie', adminCookie)
        .send({ code: 'HACKED_CODE', name: 'Intento con code' });

      expect(response.status).toBe(400);

      const current = await prisma.paymentMethod.findUniqueOrThrow({
        where: { id: customMethodId },
      });
      expect(current.code).toBe(CUSTOM_CODE);
    });

    it('PATCH no-op (mismos valores ya vigentes) -> 200, sin nueva fila de auditoría', async () => {
      const before = await request(app.getHttpServer())
        .get('/api/v1/payment-methods?includeInactive=true')
        .set('Cookie', adminCookie);
      const current = (before.body as SafePaymentMethodBody[]).find(
        (row) => row.id === customMethodId,
      )!;

      const auditCountBefore = await prisma.auditLog.count({
        where: { action: AuditAction.PAYMENT_METHOD_UPDATED },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${customMethodId}`)
        .set('Cookie', adminCookie)
        .send({ name: current.name, sortOrder: current.sortOrder });

      expect(response.status).toBe(200);
      const auditCountAfter = await prisma.auditLog.count({
        where: { action: AuditAction.PAYMENT_METHOD_UPDATED },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('desactiva: desaparece de la lista activa, sigue visible con includeInactive=true, audita DEACTIVATED', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${customMethodId}`)
        .set('Cookie', adminCookie)
        .send({ active: false });

      expect(response.status).toBe(200);
      expect((response.body as SafePaymentMethodBody).active).toBe(false);

      await trackLatestAuditRow(
        AuditAction.PAYMENT_METHOD_DEACTIVATED,
        customMethodId!,
      );

      const activeList = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', sellerCookie);
      expect(
        (activeList.body as SafePaymentMethodBody[]).map((row) => row.code),
      ).not.toContain(CUSTOM_CODE);

      const fullList = await request(app.getHttpServer())
        .get('/api/v1/payment-methods?includeInactive=true')
        .set('Cookie', adminCookie);
      expect(
        (fullList.body as SafePaymentMethodBody[]).map((row) => row.code),
      ).toContain(CUSTOM_CODE);
    });

    it('reactiva: vuelve a la lista activa, audita ACTIVATED', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${customMethodId}`)
        .set('Cookie', adminCookie)
        .send({ active: true });

      expect(response.status).toBe(200);
      expect((response.body as SafePaymentMethodBody).active).toBe(true);

      await trackLatestAuditRow(
        AuditAction.PAYMENT_METHOD_ACTIVATED,
        customMethodId!,
      );

      const activeList = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', sellerCookie);
      expect(
        (activeList.body as SafePaymentMethodBody[]).map((row) => row.code),
      ).toContain(CUSTOM_CODE);
    });

    it('id inexistente -> 404', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie)
        .send({ name: 'X' });
      expect(response.status).toBe(404);
    });

    it('body vacío -> 400', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${customMethodId}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(response.status).toBe(400);
    });
  });
});
