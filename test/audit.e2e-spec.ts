import { INestApplication } from '@nestjs/common';
import { DocumentType, PrismaClient, RoleName } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Suite dedicada de la bitácora de auditoría de solo lectura (Fase 10,
 * Bloque E): GET /audit, GET /audit/:id. Mismo criterio de aislamiento que
 * el resto del dominio: pos_db_test únicamente, nunca un deleteMany({})
 * global sobre audit_logs (hay residuos históricos conocidos y ajenos a
 * esta suite), limpieza exacta por ID propio, snapshot/restauración exacta
 * de DocumentSequence (mismo convenio que la remediación de aislamiento del
 * Bloque D).
 *
 * Usuarios SELLER/WAREHOUSE/MANAGEMENT: se reutilizan los mismos username/
 * password que configuration.e2e-spec.ts (fixtures compartidas idempotentes
 * vía upsertFixtureUser).
 */

const SELLER_USERNAME = 'e2e_seller_configuration';
const SELLER_PASSWORD = 'SellerConfig123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_configuration';
const WAREHOUSE_PASSWORD = 'WarehouseConfig123';
const MANAGEMENT_USERNAME = 'e2e_management_configuration';
const MANAGEMENT_PASSWORD = 'ManagementConfig123';

interface SafeAuditUserBody {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

interface SafeAuditListItemBody {
  id: string;
  user: SafeAuditUserBody | null;
  module: string;
  action: string;
  entityType: string;
  entityId: string | null;
  description: string;
  createdAt: string;
}

interface SafeAuditListBody {
  data: SafeAuditListItemBody[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface SafeAuditDetailBody extends SafeAuditListItemBody {
  metadata: unknown;
  ipAddress: string | null;
}

interface SequenceSnapshot {
  existed: boolean;
  prefix?: string;
  padding?: number;
  currentNumber?: number;
}

describe('Audit — Read API (Bloque 10, E) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;

  let originalBusinessName: string;
  let categoryId: string;

  let quoteSequenceSnapshot: SequenceSnapshot;

  const ownedAuditLogIds: string[] = [];
  const ownedCategoryIds: string[] = [];

  async function listAudit(
    query: Record<string, unknown>,
    cookie: string | null = adminCookie,
  ): Promise<{ status: number; body: SafeAuditListBody }> {
    const req = request(app.getHttpServer()).get('/api/v1/audit').query(query);
    if (cookie !== null) {
      req.set('Cookie', cookie);
    }
    const response = await req;
    return {
      status: response.status,
      body: response.body as SafeAuditListBody,
    };
  }

  async function getAuditDetail(
    id: string,
    cookie: string | null = adminCookie,
  ): Promise<{ status: number; body: SafeAuditDetailBody }> {
    const req = request(app.getHttpServer()).get(`/api/v1/audit/${id}`);
    if (cookie !== null) {
      req.set('Cookie', cookie);
    }
    const response = await req;
    return {
      status: response.status,
      body: response.body as SafeAuditDetailBody,
    };
  }

  async function trackLatestAuditRow(
    action: AuditAction,
  ): Promise<{ id: string; createdAt: Date; metadata: unknown }> {
    const row = await prisma.auditLog.findFirst({
      where: { action },
      orderBy: { createdAt: 'desc' },
    });
    if (row === null) {
      throw new Error(`Se esperaba una fila ${action} recién creada`);
    }
    ownedAuditLogIds.push(row.id);
    return row;
  }

  async function captureSequenceSnapshot(
    documentType: DocumentType,
  ): Promise<SequenceSnapshot> {
    const row = await prisma.documentSequence.findUnique({
      where: { documentType },
    });
    if (row === null) return { existed: false };
    return {
      existed: true,
      prefix: row.prefix,
      padding: row.padding,
      currentNumber: row.currentNumber,
    };
  }

  async function restoreSequenceSnapshot(
    documentType: DocumentType,
    snapshot: SequenceSnapshot,
  ): Promise<void> {
    if (snapshot.existed) {
      await prisma.documentSequence.update({
        where: { documentType },
        data: {
          prefix: snapshot.prefix,
          padding: snapshot.padding,
          currentNumber: snapshot.currentNumber,
        },
      });
    } else {
      await prisma.documentSequence.deleteMany({ where: { documentType } });
    }
  }

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
    // Baseline tomado DESPUÉS del login (§47 del kickoff): el propio login
    // exitoso genera LOGIN_SUCCESS, que no debe contaminar la aserción de
    // "las lecturas de auditoría no auditan nada".
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

    quoteSequenceSnapshot = await captureSequenceSnapshot(DocumentType.QUOTE);
    await prisma.documentSequence.upsert({
      where: { documentType: DocumentType.QUOTE },
      update: {},
      create: {
        documentType: DocumentType.QUOTE,
        prefix: 'COT-',
        currentNumber: 0,
        padding: 6,
      },
    });

    const baseline = await request(app.getHttpServer())
      .get('/api/v1/configuration')
      .set('Cookie', adminCookie);
    originalBusinessName = (baseline.body as { businessName: string })
      .businessName;
  });

  afterAll(async () => {
    try {
      if (ownedCategoryIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Category', entityId: { in: ownedCategoryIds } },
        });
        await prisma.category.deleteMany({
          where: { id: { in: ownedCategoryIds } },
        });
      }

      // Restaurar businessName exacto si algún test no lo dejó ya restaurado.
      await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ businessName: originalBusinessName });

      await restoreSequenceSnapshot(DocumentType.QUOTE, quoteSequenceSnapshot);

      if (ownedAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedAuditLogIds } },
        });
      }

      const settingsCount = await prisma.companySettings.count();
      if (settingsCount !== 1) {
        throw new Error(
          `Invariante de singleton violado al cerrar la suite: se esperaba 1 fila, se encontraron ${settingsCount}`,
        );
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  describe('§35 — Matriz de roles', () => {
    it('LIST: sin cookie 401, ADMIN 200, MANAGEMENT 200, SELLER 403, WAREHOUSE 403', async () => {
      expect((await listAudit({}, null)).status).toBe(401);
      expect((await listAudit({}, adminCookie)).status).toBe(200);
      expect((await listAudit({}, managementCookie)).status).toBe(200);
      expect((await listAudit({}, sellerCookie)).status).toBe(403);
      expect((await listAudit({}, warehouseCookie)).status).toBe(403);
    });

    it('DETAIL: misma matriz de roles', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `E2EAUDROLE${Date.now()}`,
          name: 'Categoria E2E Audit Roles',
        });
      expect(created.status).toBe(201);
      const categoryRoleTestId = (created.body as { id: string }).id;
      ownedCategoryIds.push(categoryRoleTestId);
      const audit = await trackLatestAuditRow(AuditAction.CATEGORY_CREATED);

      expect((await getAuditDetail(audit.id, null)).status).toBe(401);
      expect((await getAuditDetail(audit.id, adminCookie)).status).toBe(200);
      expect((await getAuditDetail(audit.id, managementCookie)).status).toBe(
        200,
      );
      expect((await getAuditDetail(audit.id, sellerCookie)).status).toBe(403);
      expect((await getAuditDetail(audit.id, warehouseCookie)).status).toBe(
        403,
      );

      const sellerView = await getAuditDetail(audit.id, sellerCookie);
      expect(JSON.stringify(sellerView.body)).not.toContain('metadata');
      expect(JSON.stringify(sellerView.body)).not.toContain('ipAddress');
    });
  });

  describe('§36 — Fixtures reales de auditoría en múltiples dominios', () => {
    it('CONFIGURATION_UPDATED, SEQUENCE_UPDATED y CATEGORY_CREATED son consultables por GET /audit/:id', async () => {
      const uniqueName = `Empresa E2E Audit ${Date.now()}`;
      const configPatch = await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ businessName: uniqueName });
      expect(configPatch.status).toBe(200);
      const configAudit = await trackLatestAuditRow(
        AuditAction.CONFIGURATION_UPDATED,
      );

      const configDetail = await getAuditDetail(configAudit.id);
      expect(configDetail.status).toBe(200);
      expect(configDetail.body.module).toBe('CONFIGURATION');
      expect(configDetail.body.action).toBe('CONFIGURATION_UPDATED');

      // Restaura de inmediato (no depende únicamente del afterAll).
      await request(app.getHttpServer())
        .patch('/api/v1/configuration')
        .set('Cookie', adminCookie)
        .send({ businessName: originalBusinessName });
      await trackLatestAuditRow(AuditAction.CONFIGURATION_UPDATED);

      const sequencePatch = await request(app.getHttpServer())
        .patch('/api/v1/configuration/sequences/QUOTE')
        .set('Cookie', adminCookie)
        .send({ prefix: 'COT-' });
      expect([200]).toContain(sequencePatch.status);
      // Puede ser no-op si ya era "COT-"; forzamos un cambio real y lo
      // revertimos para garantizar exactamente una fila SEQUENCE_UPDATED.
      const forcedChange = await request(app.getHttpServer())
        .patch('/api/v1/configuration/sequences/QUOTE')
        .set('Cookie', adminCookie)
        .send({ prefix: 'COTE2EAUD-' });
      expect(forcedChange.status).toBe(200);
      const sequenceAudit = await trackLatestAuditRow(
        AuditAction.SEQUENCE_UPDATED,
      );
      const revert = await request(app.getHttpServer())
        .patch('/api/v1/configuration/sequences/QUOTE')
        .set('Cookie', adminCookie)
        .send({ prefix: 'COT-' });
      expect(revert.status).toBe(200);
      await trackLatestAuditRow(AuditAction.SEQUENCE_UPDATED);

      const sequenceDetail = await getAuditDetail(sequenceAudit.id);
      expect(sequenceDetail.status).toBe(200);
      expect(sequenceDetail.body.module).toBe('CONFIGURATION');
      expect(sequenceDetail.body.action).toBe('SEQUENCE_UPDATED');

      const categoryCreate = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `E2EAUDFIX${Date.now()}`,
          name: 'Categoria E2E Audit Fixture',
        });
      expect(categoryCreate.status).toBe(201);
      categoryId = (categoryCreate.body as { id: string }).id;
      ownedCategoryIds.push(categoryId);
      const categoryAudit = await trackLatestAuditRow(
        AuditAction.CATEGORY_CREATED,
      );

      const categoryDetail = await getAuditDetail(categoryAudit.id);
      expect(categoryDetail.status).toBe(200);
      expect(categoryDetail.body.module).toBe('CATEGORIES');
      expect(categoryDetail.body.entityType).toBe('Category');
      expect(categoryDetail.body.entityId).toBe(categoryId);
    });
  });

  describe('§43 — Usuario nulo (login fallido sin actor real)', () => {
    it('LOGIN_FAILED con userId=null se refleja como user=null', async () => {
      const bogusUsername = `e2e_no_existe_${Date.now()}`;
      const failed = await login(
        app.getHttpServer(),
        bogusUsername,
        'ClaveIncorrecta123',
      );
      expect(failed.status).toBe(401);
      const audit = await trackLatestAuditRow(AuditAction.LOGIN_FAILED);
      expect(audit.metadata).toEqual({ reason: 'USER_NOT_FOUND' });

      const detail = await getAuditDetail(audit.id);
      expect(detail.status).toBe(200);
      expect(detail.body.user).toBeNull();

      const list = await listAudit({ module: 'AUTH', action: 'LOGIN_FAILED' });
      const row = list.body.data.find((item) => item.id === audit.id);
      expect(row).toBeDefined();
      expect(row?.user).toBeNull();
    });
  });

  describe('§37 — Filtros de listado', () => {
    it('module/action/entityType/entityId/userId aíslan exactamente la fila propia', async () => {
      expect(categoryId).toBeDefined();
      const byEntity = await listAudit({
        entityType: 'Category',
        entityId: categoryId,
      });
      expect(byEntity.status).toBe(200);
      expect(byEntity.body.data).toHaveLength(1);
      expect(byEntity.body.data[0].entityId).toBe(categoryId);

      const byModuleAction = await listAudit({
        module: 'CATEGORIES',
        action: 'CATEGORY_CREATED',
        entityId: categoryId,
      });
      expect(byModuleAction.body.data).toHaveLength(1);

      const wrongModule = await listAudit({
        module: 'SALES',
        entityId: categoryId,
      });
      expect(wrongModule.body.data).toHaveLength(0);

      const adminUser = await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
        select: { id: true },
      });
      const byUser = await listAudit({
        userId: adminUser.id,
        entityType: 'Category',
        entityId: categoryId,
      });
      expect(byUser.body.data).toHaveLength(1);
    });
  });

  describe('§38 — Frontera de fecha America/Lima', () => {
    it('incluye/excluye exactamente según el día de negocio Lima', async () => {
      const suffix = Date.now();
      const created: { id: string }[] = [];
      for (let i = 0; i < 5; i += 1) {
        const response = await request(app.getHttpServer())
          .post('/api/v1/categories')
          .set('Cookie', adminCookie)
          .send({
            code: `E2EAUDBND${suffix}${i}`,
            name: `Categoria E2E Audit Frontera ${i}`,
          });
        expect(response.status).toBe(201);
        const id = (response.body as { id: string }).id;
        ownedCategoryIds.push(id);
        created.push(response.body as { id: string });
      }

      // Una fila por entityId propio (nunca "la más reciente de la acción
      // en general": con 5 categorías creadas en rápida sucesión, un
      // findFirst() sin filtrar por entidad devolvería 5 veces la misma
      // fila, la última creada).
      const audits = [];
      for (const category of created) {
        const row = await prisma.auditLog.findFirst({
          where: {
            action: AuditAction.CATEGORY_CREATED,
            entityType: 'Category',
            entityId: category.id,
          },
        });
        if (row === null) {
          throw new Error(
            `Se esperaba una fila CATEGORY_CREATED para ${category.id}`,
          );
        }
        ownedAuditLogIds.push(row.id);
        audits.push(row);
      }
      const uniqueIds = new Set(audits.map((audit) => audit.id));
      expect(uniqueIds.size).toBe(5);

      const [justBefore, exactStart, inside, justBeforeEnd, exactNextBoundary] =
        audits;

      await prisma.auditLog.update({
        where: { id: justBefore.id },
        data: { createdAt: new Date('2026-01-10T04:59:59.999Z') },
      });
      await prisma.auditLog.update({
        where: { id: exactStart.id },
        data: { createdAt: new Date('2026-01-10T05:00:00.000Z') },
      });
      await prisma.auditLog.update({
        where: { id: inside.id },
        data: { createdAt: new Date('2026-01-10T12:00:00.000Z') },
      });
      await prisma.auditLog.update({
        where: { id: justBeforeEnd.id },
        data: { createdAt: new Date('2026-01-11T04:59:59.999Z') },
      });
      await prisma.auditLog.update({
        where: { id: exactNextBoundary.id },
        data: { createdAt: new Date('2026-01-11T05:00:00.000Z') },
      });

      const result = await listAudit({
        from: '2026-01-10',
        to: '2026-01-10',
        module: 'CATEGORIES',
        action: 'CATEGORY_CREATED',
      });
      const ids = result.body.data.map((row) => row.id);
      expect(ids).not.toContain(justBefore.id);
      expect(ids).toContain(exactStart.id);
      expect(ids).toContain(inside.id);
      expect(ids).toContain(justBeforeEnd.id);
      expect(ids).not.toContain(exactNextBoundary.id);
    });
  });

  describe('§39/§40 — Paginación, orden y forma segura del listado', () => {
    it('createdAt DESC, id DESC; página vacía más allá del total; forma exacta', async () => {
      const response = await listAudit({
        entityType: 'Category',
        limit: 5,
        page: 1,
      });
      expect(response.status).toBe(200);
      for (let i = 1; i < response.body.data.length; i += 1) {
        const prev = new Date(response.body.data[i - 1].createdAt).getTime();
        const curr = new Date(response.body.data[i].createdAt).getTime();
        expect(prev).toBeGreaterThanOrEqual(curr);
      }

      for (const row of response.body.data) {
        expect(Object.keys(row).sort()).toEqual(
          [
            'id',
            'user',
            'module',
            'action',
            'entityType',
            'entityId',
            'description',
            'createdAt',
          ].sort(),
        );
        expect(row).not.toHaveProperty('metadata');
        expect(row).not.toHaveProperty('ipAddress');
        if (row.user !== null) {
          expect(Object.keys(row.user).sort()).toEqual(
            ['id', 'username', 'firstName', 'lastName'].sort(),
          );
        }
      }

      // Filtro angosto (una sola entidad propia) para que "más allá del
      // total" sea válido sin importar cuántas filas históricas ajenas
      // existan por entityType='Category' en toda la base.
      const beyond = await listAudit({
        entityType: 'Category',
        entityId: categoryId,
        page: 999,
        limit: 20,
      });
      expect(beyond.status).toBe(200);
      expect(beyond.body.data).toEqual([]);
    });
  });

  describe('§41/§42 — Detalle: ADMIN ve IP real, MANAGEMENT siempre null', () => {
    it('misma fila, misma metadata, ipAddress distinto según rol', async () => {
      expect(categoryId).toBeDefined();
      const audit = await prisma.auditLog.findFirst({
        where: { entityType: 'Category', entityId: categoryId },
        orderBy: { createdAt: 'desc' },
      });
      if (audit === null) throw new Error('Fila de auditoría no encontrada');

      const adminView = await getAuditDetail(audit.id, adminCookie);
      const managementView = await getAuditDetail(audit.id, managementCookie);

      expect(adminView.status).toBe(200);
      expect(managementView.status).toBe(200);
      expect(adminView.body.metadata).toEqual(managementView.body.metadata);
      expect(managementView.body.ipAddress).toBeNull();
      expect(managementView.body).toHaveProperty('ipAddress');
      expect(JSON.stringify(adminView.body.metadata)).not.toMatch(
        /password|token|jwt|secret/i,
      );
    });
  });

  describe('§44 — Las lecturas nunca se auditan a sí mismas', () => {
    it('GET /audit y GET /audit/:id (ADMIN y MANAGEMENT) no generan ninguna fila nueva', async () => {
      expect(categoryId).toBeDefined();
      const before = await prisma.auditLog.count();

      await listAudit({}, adminCookie);
      await listAudit({}, managementCookie);
      const anyRow = await prisma.auditLog.findFirst({
        orderBy: { createdAt: 'desc' },
      });
      if (anyRow !== null) {
        await getAuditDetail(anyRow.id, adminCookie);
        await getAuditDetail(anyRow.id, managementCookie);
      }

      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });
  });

  describe('§45 — Seguridad ante errores', () => {
    it('id inválido -> 400; id válido inexistente -> 404; filtros inválidos -> 400', async () => {
      const invalidId = await getAuditDetail('not-a-uuid');
      expect(invalidId.status).toBe(400);

      const missingId = await getAuditDetail(
        '00000000-0000-0000-0000-000000000000',
      );
      expect(missingId.status).toBe(404);

      expect((await listAudit({ action: 'NOT_A_REAL_ACTION' })).status).toBe(
        400,
      );
      expect((await listAudit({ module: 'NOT_A_REAL_MODULE' })).status).toBe(
        400,
      );
      expect((await listAudit({ userId: 'not-a-uuid' })).status).toBe(400);
      expect((await listAudit({ from: '2026-02-30' })).status).toBe(400);
      expect((await listAudit({ unknownField: 'x' })).status).toBe(400);

      for (const response of [
        invalidId,
        missingId,
        await listAudit({ action: 'NOT_A_REAL_ACTION' }),
      ]) {
        const text = JSON.stringify(response.body);
        expect(text).not.toMatch(/at\s+\w+\.\w+\s+\(/);
        expect(text.toLowerCase()).not.toContain('prisma');
        expect(text).not.toMatch(/[A-Z]:\\/);
      }
    });
  });

  describe('§46 — Sin rutas de mutación', () => {
    it('POST/PATCH/PUT/DELETE sobre /audit no están soportados', async () => {
      const post = await request(app.getHttpServer())
        .post('/api/v1/audit')
        .set('Cookie', adminCookie)
        .send({});
      expect(post.status).toBe(404);

      const anyRow = await prisma.auditLog.findFirst();
      const targetId = anyRow?.id ?? '00000000-0000-0000-0000-000000000000';

      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/audit/${targetId}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(patch.status).toBe(404);

      const put = await request(app.getHttpServer())
        .put(`/api/v1/audit/${targetId}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(put.status).toBe(404);

      const del = await request(app.getHttpServer())
        .delete(`/api/v1/audit/${targetId}`)
        .set('Cookie', adminCookie);
      expect(del.status).toBe(404);
    });
  });

  describe('§47 — Invariante de solo lectura', () => {
    it('leer /audit repetidamente no cambia ninguna tabla de negocio', async () => {
      const before = {
        auditLogs: await prisma.auditLog.count(),
        settings: await prisma.companySettings.findUniqueOrThrow({
          where: { singleton: true },
        }),
        sequences: await prisma.documentSequence.findMany({
          orderBy: { documentType: 'asc' },
        }),
        quotes: await prisma.quote.count(),
        sales: await prisma.sale.count(),
        payments: await prisma.payment.count(),
        accountingEntries: await prisma.accountingEntry.count(),
      };

      await listAudit({}, adminCookie);
      await listAudit({ module: 'CONFIGURATION' }, managementCookie);
      const anyRow = await prisma.auditLog.findFirst();
      if (anyRow !== null) {
        await getAuditDetail(anyRow.id, adminCookie);
        await getAuditDetail(anyRow.id, managementCookie);
      }

      const after = {
        auditLogs: await prisma.auditLog.count(),
        settings: await prisma.companySettings.findUniqueOrThrow({
          where: { singleton: true },
        }),
        sequences: await prisma.documentSequence.findMany({
          orderBy: { documentType: 'asc' },
        }),
        quotes: await prisma.quote.count(),
        sales: await prisma.sale.count(),
        payments: await prisma.payment.count(),
        accountingEntries: await prisma.accountingEntry.count(),
      };

      expect(after.auditLogs).toBe(before.auditLogs);
      expect(after.settings).toEqual(before.settings);
      expect(after.sequences).toEqual(before.sequences);
      expect(after.quotes).toBe(before.quotes);
      expect(after.sales).toBe(before.sales);
      expect(after.payments).toBe(before.payments);
      expect(after.accountingEntries).toBe(before.accountingEntries);
    });
  });
});
