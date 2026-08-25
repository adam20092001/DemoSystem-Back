import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName } from '@prisma/client';
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

const SELLER_USERNAME = 'e2e_seller_configuration';
const SELLER_PASSWORD = 'SellerConfig123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_configuration';
const WAREHOUSE_PASSWORD = 'WarehouseConfig123';
const MANAGEMENT_USERNAME = 'e2e_management_configuration';
const MANAGEMENT_PASSWORD = 'ManagementConfig123';

interface SafeConfigurationBody {
  id: string;
  businessName: string;
  tradeName: string | null;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  taxRate: string;
  quoteValidityDays: number;
  maxDiscountPercent: string;
  createdAt: string;
  updatedAt: string;
}

describe('Configuration (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  /** Snapshot original de la fila singleton, capturado antes de cualquier PATCH de esta suite. */
  let baseline: SafeConfigurationBody;
  /**
   * IDs propios (AuditLog.id, NUNCA entityId) de las filas de auditoría
   * generadas por esta suite. `entityType: 'CompanySettings'` comparte
   * SIEMPRE el mismo `entityId` (la fila singleton es única y eterna), así
   * que a diferencia de Customer/Category/etc. (donde cada test crea su
   * propia fila con un ID nuevo) NO es seguro limpiar por entityId aquí:
   * eso borraría también auditoría real de administración ya existente o
   * futura sobre la misma fila. Se rastrea el `id` propio de cada fila de
   * AuditLog creada por esta suite y se borra exactamente esa lista al
   * final — nunca un deleteMany({}) global ni un filtro por entityId.
   */
  const ownedAuditLogIds: string[] = [];
  /** CONFIGURATION_UPDATED total antes de que esta suite mute nada, para probar residuo neto cero al final. */
  let configurationAuditBaselineCount: number;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_configuration@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_configuration@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_configuration@demosystem.test',
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

    configurationAuditBaselineCount = await prisma.auditLog.count({
      where: { action: AuditAction.CONFIGURATION_UPDATED },
    });

    const baselineResponse = await request(app.getHttpServer())
      .get('/api/v1/configuration')
      .set('Cookie', adminCookie);
    if (baselineResponse.status !== 200) {
      throw new Error(
        `No se pudo leer la configuración base: ${JSON.stringify(baselineResponse.body)}`,
      );
    }
    baseline = baselineResponse.body as SafeConfigurationBody;
  });

  afterAll(async () => {
    try {
      // Restaura exactamente los 8 campos editables del Bloque A a su valor
      // original. Como los tests de esta suite sí modificaron campos
      // reales, esto genera una fila CONFIGURATION_UPDATED más, que se
      // rastrea igual que las demás.
      const restoreResponse = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({
          businessName: baseline.businessName,
          tradeName: baseline.tradeName,
          taxId: baseline.taxId,
          address: baseline.address,
          phone: baseline.phone,
          email: baseline.email,
          currencyCode: baseline.currencyCode,
          currencySymbol: baseline.currencySymbol,
        });
      if (restoreResponse.status === 200) {
        await trackLatestConfigurationAuditRow();
      }

      // Limpieza exclusivamente por AuditLog.id propio (nunca por
      // entityId, nunca deleteMany({}), nunca un filtro global de
      // CONFIGURATION_UPDATED): la fila singleton es compartida con
      // cualquier auditoría real de administración pasada o futura.
      if (ownedAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedAuditLogIds } },
        });
      }

      // Prueba residuo neto cero: el conteo de CONFIGURATION_UPDATED tras
      // la limpieza debe coincidir exactamente con el capturado antes de
      // que esta suite tocara nada.
      const finalCount = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      if (finalCount !== configurationAuditBaselineCount) {
        throw new Error(
          `Residuo de auditoría CONFIGURATION_UPDATED no controlado: esperado ${configurationAuditBaselineCount}, encontrado ${finalCount}`,
        );
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  /**
   * Localiza la fila CONFIGURATION_UPDATED más reciente (única acción que
   * this suite genera) y agrega su `id` propio a ownedAuditLogIds. Se llama
   * inmediatamente después de un PATCH real (200 con cambios efectivos).
   */
  async function trackLatestConfigurationAuditRow(): Promise<{
    id: string;
    module: string;
    entityType: string;
    entityId: string | null;
    metadata: unknown;
  }> {
    const row = await prisma.auditLog.findFirst({
      where: { action: AuditAction.CONFIGURATION_UPDATED },
      orderBy: { createdAt: 'desc' },
    });
    if (row === null) {
      throw new Error(
        'Se esperaba una fila CONFIGURATION_UPDATED recién creada y no se encontró ninguna',
      );
    }
    ownedAuditLogIds.push(row.id);
    return row;
  }

  describe('autorización', () => {
    it('GET sin cookie responde 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/configuration',
      );
      expect(response.status).toBe(401);
    });

    it('PATCH sin cookie responde 401', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .send({ businessName: 'X' });
      expect(response.status).toBe(401);
    });

    it('GET: ADMIN y MANAGEMENT ven 200; SELLER y WAREHOUSE 403', async () => {
      const admin = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      expect(admin.status).toBe(200);

      const management = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', managementCookie);
      expect(management.status).toBe(200);

      const seller = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', sellerCookie);
      expect(seller.status).toBe(403);

      const warehouse = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', warehouseCookie);
      expect(warehouse.status).toBe(403);
    });

    it('PATCH: solo ADMIN puede (MANAGEMENT/SELLER/WAREHOUSE -> 403)', async () => {
      const management = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', managementCookie)
        .send({ businessName: baseline.businessName });
      expect(management.status).toBe(403);

      const seller = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', sellerCookie)
        .send({ businessName: baseline.businessName });
      expect(seller.status).toBe(403);

      const warehouse = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', warehouseCookie)
        .send({ businessName: baseline.businessName });
      expect(warehouse.status).toBe(403);
    });
  });

  describe('GET /configuration', () => {
    it('devuelve la fila singleton con los 4 campos del Bloque B/C visibles en modo lectura', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      const body = response.body as SafeConfigurationBody;
      expect(typeof body.id).toBe('string');
      expect(typeof body.businessName).toBe('string');
      expect(typeof body.currencyCode).toBe('string');
      expect(typeof body.currencySymbol).toBe('string');
      expect(typeof body.taxEnabled).toBe('boolean');
      expect(typeof body.taxRate).toBe('string');
      expect(typeof body.quoteValidityDays).toBe('number');
      expect(typeof body.maxDiscountPercent).toBe('string');
      expect(body).not.toHaveProperty('singleton');
    });

    it('dos GET consecutivos no generan ninguna fila de auditoría', async () => {
      const before = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });

      await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', managementCookie);

      const after = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      expect(after).toBe(before);
    });
  });

  describe('PATCH /configuration — validación', () => {
    it('body vacío -> 400', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({});
      expect(response.status).toBe(400);
    });

    it('businessName en blanco tras trim -> 400', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ businessName: '   ' });
      expect(response.status).toBe(400);
    });

    it('currencyCode con formato inválido -> 400', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ currencyCode: 'P1' });
      expect(response.status).toBe(400);
    });

    it('currencySymbol vacío -> 400', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ currencySymbol: '' });
      expect(response.status).toBe(400);
    });

    it('email con formato inválido -> 400', async () => {
      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ email: 'no-es-un-correo' });
      expect(response.status).toBe(400);
    });

    // quoteValidityDays/maxDiscountPercent se desbloquearon en el Bloque B
    // (Fase 10): su cobertura de "editable ahora, tax sigue bloqueado" vive
    // en test/configuration-commercial.e2e-spec.ts. Aquí solo permanecen
    // taxEnabled/taxRate, que siguen bloqueados hasta el Bloque C.
    it.each([
      ['taxEnabled', true],
      ['taxRate', '10.00'],
    ])(
      '%s en el body -> 400 (aún no editable hasta el Bloque C)',
      async (field, value) => {
        const response = await request(app.getHttpServer())
          .patch('/api/v1/configuration')
          .set('Cookie', adminCookie)
          .send({ [field]: value });
        expect(response.status).toBe(400);
      },
    );
  });

  describe('PATCH /configuration — actualización real', () => {
    it('actualiza campos de identidad/moneda y registra CONFIGURATION_UPDATED con changedFields/oldValues/newValues exactos', async () => {
      const before = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      const beforeBody = before.body as SafeConfigurationBody;

      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({
          businessName: 'Comercial E2E S.A.C.',
          tradeName: 'Comercial E2E',
          address: 'Av. de Prueba 456',
          currencyCode: 'usd',
          currencySymbol: '$',
        });

      expect(response.status).toBe(200);
      const body = response.body as SafeConfigurationBody;
      expect(body.businessName).toBe('Comercial E2E S.A.C.');
      expect(body.tradeName).toBe('Comercial E2E');
      expect(body.address).toBe('Av. de Prueba 456');
      // Normalizado a mayúsculas por el servicio.
      expect(body.currencyCode).toBe('USD');
      expect(body.currencySymbol).toBe('$');
      // Los campos del Bloque B/C nunca cambian por este PATCH.
      expect(body.taxEnabled).toBe(baseline.taxEnabled);
      expect(body.taxRate).toBe(baseline.taxRate);
      expect(body.quoteValidityDays).toBe(baseline.quoteValidityDays);
      expect(body.maxDiscountPercent).toBe(baseline.maxDiscountPercent);

      const auditRow = await trackLatestConfigurationAuditRow();
      expect(auditRow.module).toBe('CONFIGURATION');
      expect(auditRow.entityType).toBe('CompanySettings');
      expect(auditRow.entityId).toBe(body.id);

      const metadata = auditRow.metadata as {
        changedFields: string[];
        oldValues: Record<string, unknown>;
        newValues: Record<string, unknown>;
      };
      expect(metadata.changedFields.sort()).toEqual(
        [
          'businessName',
          'tradeName',
          'address',
          'currencyCode',
          'currencySymbol',
        ].sort(),
      );
      expect(metadata.oldValues).toEqual({
        businessName: beforeBody.businessName,
        tradeName: beforeBody.tradeName,
        address: beforeBody.address,
        currencyCode: beforeBody.currencyCode,
        currencySymbol: beforeBody.currencySymbol,
      });
      expect(metadata.newValues).toEqual({
        businessName: 'Comercial E2E S.A.C.',
        tradeName: 'Comercial E2E',
        address: 'Av. de Prueba 456',
        currencyCode: 'USD',
        currencySymbol: '$',
      });
      // Nunca el contrato anterior (updatedFields) ni campos fuera de lo aprobado.
      expect(metadata).not.toHaveProperty('updatedFields');
      const serialized = JSON.stringify(auditRow);
      for (const forbidden of [
        'singleton',
        'taxEnabled',
        'taxRate',
        'quoteValidityDays',
        'maxDiscountPercent',
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
      assertAuditRowHasNoSecrets(auditRow);
    });

    it('null limpia un campo opcional (tradeName) y audita newValues.tradeName=null', async () => {
      const before = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      const beforeBody = before.body as SafeConfigurationBody;

      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ tradeName: null });

      expect(response.status).toBe(200);
      const body = response.body as SafeConfigurationBody;
      expect(body.tradeName).toBeNull();

      const auditRow = await trackLatestConfigurationAuditRow();
      const metadata = auditRow.metadata as {
        changedFields: string[];
        oldValues: Record<string, unknown>;
        newValues: Record<string, unknown>;
      };
      expect(metadata.changedFields).toEqual(['tradeName']);
      expect(metadata.oldValues).toEqual({ tradeName: beforeBody.tradeName });
      expect(metadata.newValues).toEqual({ tradeName: null });
    });

    it('PATCH no-op (mismos valores ya vigentes) -> 200, sin nueva fila de auditoría', async () => {
      const current = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      const currentBody = current.body as SafeConfigurationBody;

      const before = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });

      const response = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({
          businessName: currentBody.businessName,
          currencyCode: currentBody.currencyCode.toLowerCase(),
        });

      expect(response.status).toBe(200);
      const after = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      expect(after).toBe(before);
    });
  });

  describe('invariante de singleton (constraint real de PostgreSQL)', () => {
    it('un INSERT directo de una segunda fila es rechazado por la base de datos', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "company_settings"
            ("id", "singleton", "business_name", "currency_code", "currency_symbol", "updated_at")
          VALUES
            (gen_random_uuid(), true, 'Segunda Fila', 'PEN', 'S/', CURRENT_TIMESTAMP)
        `,
      ).rejects.toThrow();

      const count = await prisma.companySettings.count();
      expect(count).toBe(1);
    });

    it('un INSERT directo con singleton=false también es rechazado (CHECK singleton = TRUE)', async () => {
      await expect(
        prisma.$executeRaw`
          INSERT INTO "company_settings"
            ("id", "singleton", "business_name", "currency_code", "currency_symbol", "updated_at")
          VALUES
            (gen_random_uuid(), false, 'Fila Falsa', 'PEN', 'S/', CURRENT_TIMESTAMP)
        `,
      ).rejects.toThrow();

      const count = await prisma.companySettings.count();
      expect(count).toBe(1);
    });
  });
});
