import { INestApplication } from '@nestjs/common';
import { CashSessionStatus, PrismaClient, RoleName } from '@prisma/client';
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
 * Ticket B post-MVP, Bloque B2 — CashSessionsModule. Suite dedicada,
 * apertura/lectura únicamente (sin cierre/aprobación/rechazo, eso llega en
 * un bloque posterior). Fixtures propios de esta suite (nunca reutiliza el
 * admin/seller compartido de otras suites): CashSession tiene la
 * invariante "como máximo una sin resolver por usuario", así que cada
 * escenario que necesita una precondición concreta usa su propio usuario
 * dedicado, para no interferir entre pruebas dentro del mismo archivo.
 * Toda CashSession creada aquí se elimina por su ID exacto en afterAll
 * (nunca deleteMany({}) sobre toda la tabla); los usuarios fixture SELLER/
 * MANAGEMENT/WAREHOUSE, idempotentes vía upsertFixtureUser, se conservan
 * entre corridas (mismo criterio que el resto del repositorio). Para el
 * caso ADMIN se reutiliza el admin compartido (E2E_ADMIN_USERNAME) en vez
 * de crear un ADMIN propio: users-admin-concurrency.e2e-spec.ts cuenta el
 * TOTAL de usuarios ADMIN activos en toda la base de datos como
 * precondición exacta de sus escenarios — un ADMIN adicional persistente
 * creado por esta suite rompería esa precondición en cualquier ejecución
 * posterior de la suite completa.
 */
const SELLER_USERNAME = 'e2e_seller_cash_sessions_main';
const SELLER_PASSWORD = 'SellerCashSessions123';
const SELLER2_USERNAME = 'e2e_seller_cash_sessions_other';
const SELLER2_PASSWORD = 'SellerCashSessions456';
const SELLER_NOSESSION_USERNAME = 'e2e_seller_cash_sessions_nosession';
const SELLER_NOSESSION_PASSWORD = 'SellerCashSessions789';
const SELLER_409_USERNAME = 'e2e_seller_cash_sessions_conflict';
const SELLER_409_PASSWORD = 'SellerCashSessionsAAA';
const SELLER_RACE_USERNAME = 'e2e_seller_cash_sessions_race';
const SELLER_RACE_PASSWORD = 'SellerCashSessionsBBB';
const MANAGEMENT_USERNAME = 'e2e_management_cash_sessions';
const MANAGEMENT_PASSWORD = 'ManagementCashSessions123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_cash_sessions';
const WAREHOUSE_PASSWORD = 'WarehouseCashSessions123';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

interface SafeCashSessionBody {
  id: string;
  userId: string;
  status: CashSessionStatus;
  openingAmount: string;
  openedAt: string;
  closeRequestedAt: string | null;
  expectedCashAmount: string | null;
  countedCashAmount: string | null;
  differenceAmount: string | null;
  closingObservation: string | null;
  closedAt: string | null;
  approvedByUserId: string | null;
  approvedAt: string | null;
  approvalComment: string | null;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedBody<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

describe('Cash Sessions (e2e) — Ticket B, Bloque B2', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let sellerCookie: string;
  let sellerId: string;
  let seller2Cookie: string;
  let seller2Id: string;
  let sellerNoSessionCookie: string;
  let seller409Cookie: string;
  let seller409Id: string;
  let sellerRaceCookie: string;
  let sellerRaceId: string;
  let managementCookie: string;
  let warehouseCookie: string;

  /** IDs propios de CashSession/AuditLog generados por esta suite (cleanup exacto en afterAll). */
  const ownedSessionIds: string[] = [];
  const ownedAuditLogIds: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_cash_sessions_main@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER2_USERNAME,
      email: 'e2e_seller_cash_sessions_other@demosystem.test',
      password: SELLER2_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_NOSESSION_USERNAME,
      email: 'e2e_seller_cash_sessions_nosession@demosystem.test',
      password: SELLER_NOSESSION_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_409_USERNAME,
      email: 'e2e_seller_cash_sessions_conflict@demosystem.test',
      password: SELLER_409_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_RACE_USERNAME,
      email: 'e2e_seller_cash_sessions_race@demosystem.test',
      password: SELLER_RACE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_cash_sessions@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_cash_sessions@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });

    adminCookie = (
      await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_ACTIVE_PASSWORD,
      )
    ).cookie;
    const sellerLogin = await login(
      app.getHttpServer(),
      SELLER_USERNAME,
      SELLER_PASSWORD,
    );
    sellerCookie = sellerLogin.cookie;
    sellerId = (sellerLogin.body as { id: string }).id;
    const seller2Login = await login(
      app.getHttpServer(),
      SELLER2_USERNAME,
      SELLER2_PASSWORD,
    );
    seller2Cookie = seller2Login.cookie;
    seller2Id = (seller2Login.body as { id: string }).id;
    sellerNoSessionCookie = (
      await login(
        app.getHttpServer(),
        SELLER_NOSESSION_USERNAME,
        SELLER_NOSESSION_PASSWORD,
      )
    ).cookie;
    const seller409Login = await login(
      app.getHttpServer(),
      SELLER_409_USERNAME,
      SELLER_409_PASSWORD,
    );
    seller409Cookie = seller409Login.cookie;
    seller409Id = (seller409Login.body as { id: string }).id;
    const sellerRaceLogin = await login(
      app.getHttpServer(),
      SELLER_RACE_USERNAME,
      SELLER_RACE_PASSWORD,
    );
    sellerRaceCookie = sellerRaceLogin.cookie;
    sellerRaceId = (sellerRaceLogin.body as { id: string }).id;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
  });

  afterAll(async () => {
    try {
      if (ownedAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedAuditLogIds } },
        });
      }
      if (ownedSessionIds.length > 0) {
        await prisma.cashSession.deleteMany({
          where: { id: { in: ownedSessionIds } },
        });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  async function openCashSession(
    cookie: string,
    openingAmount: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/cash-sessions/open')
      .set('Cookie', cookie)
      .send({ openingAmount });
  }

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

  /**
   * Toda apertura exitosa audita CASH_SESSION_OPENED (nunca solo la del
   * test que explícitamente inspecciona su contenido): este helper rastrea
   * SIEMPRE la fila de auditoría resultante además de la propia
   * CashSession, para que ninguna quede huérfana en afterAll.
   */
  async function openCashSessionOrThrow(
    cookie: string,
    openingAmount: string,
  ): Promise<SafeCashSessionBody> {
    const response = await openCashSession(cookie, openingAmount);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo abrir la caja fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeCashSessionBody;
    ownedSessionIds.push(body.id);
    await trackLatestAuditRow(AuditAction.CASH_SESSION_OPENED, body.id);
    return body;
  }

  // ==================================================================
  // POST /cash-sessions/open
  // ==================================================================
  describe('POST /cash-sessions/open', () => {
    it('ADMIN abre con openingAmount=0 -> 201, audita CASH_SESSION_OPENED sin secretos', async () => {
      const body = await openCashSessionOrThrow(adminCookie, '0');
      expect(body.status).toBe(CashSessionStatus.OPEN);
      expect(body.openingAmount).toBe('0.00');
      expect(body.closeRequestedAt).toBeNull();
      expect(body.approvedByUserId).toBeNull();

      // Ya rastreada por openCashSessionOrThrow(); aquí solo se relee para
      // inspeccionar su contenido, sin volver a trackearla (evita un ID
      // duplicado en ownedAuditLogIds).
      const auditRow = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.CASH_SESSION_OPENED,
          entityId: body.id,
        },
      });
      assertAuditRowHasNoSecrets(auditRow);
    });

    it('SELLER abre con openingAmount positivo -> 201', async () => {
      const body = await openCashSessionOrThrow(sellerCookie, '150.75');
      expect(body.openingAmount).toBe('150.75');
      expect(body.userId).toBe(sellerId);
    });

    it('openingAmount negativo -> 400, sin crear caja', async () => {
      const before = await prisma.cashSession.count({
        where: { userId: seller2Id },
      });
      const response = await openCashSession(seller2Cookie, '-1.00');
      expect(response.status).toBe(400);
      const after = await prisma.cashSession.count({
        where: { userId: seller2Id },
      });
      expect(after).toBe(before);
    });

    it('segundo intento de apertura con una sesión OPEN ya existente -> 409', async () => {
      await openCashSessionOrThrow(seller409Cookie, '100.00');
      const second = await openCashSession(seller409Cookie, '50.00');
      expect(second.status).toBe(409);
      const count = await prisma.cashSession.count({
        where: { userId: seller409Id },
      });
      expect(count).toBe(1);
    });

    it('WAREHOUSE -> 403', async () => {
      const response = await openCashSession(warehouseCookie, '10.00');
      expect(response.status).toBe(403);
    });

    it('MANAGEMENT -> 403', async () => {
      const response = await openCashSession(managementCookie, '10.00');
      expect(response.status).toBe(403);
    });
  });

  // ==================================================================
  // GET /cash-sessions/current
  // ==================================================================
  describe('GET /cash-sessions/current', () => {
    it('propia OPEN -> 200', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      expect(body.userId).toBe(sellerId);
      expect(body.status).toBe(CashSessionStatus.OPEN);
    });

    it('sin sesión sin resolver -> 404', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerNoSessionCookie);
      expect(response.status).toBe(404);
    });

    it('WAREHOUSE -> 403', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', warehouseCookie);
      expect(response.status).toBe(403);
    });

    it('MANAGEMENT -> 403', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', managementCookie);
      expect(response.status).toBe(403);
    });
  });

  // ==================================================================
  // GET /cash-sessions (historial)
  // ==================================================================
  describe('GET /cash-sessions', () => {
    it('ADMIN ve sesiones de múltiples usuarios (sin restricción de propiedad)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ limit: 100 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCashSessionBody>;
      const userIds = new Set(body.data.map((row) => row.userId));
      expect(userIds.has(sellerId)).toBe(true);
      expect(userIds.has(seller409Id)).toBe(true);
    });

    it('MANAGEMENT ve sesiones de múltiples usuarios (sin restricción de propiedad)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ limit: 100 })
        .set('Cookie', managementCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCashSessionBody>;
      const userIds = new Set(body.data.map((row) => row.userId));
      expect(userIds.has(sellerId)).toBe(true);
    });

    it('SELLER ve únicamente sus propias sesiones', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ limit: 100 })
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCashSessionBody>;
      expect(body.data.length).toBeGreaterThan(0);
      expect(body.data.every((row) => row.userId === sellerId)).toBe(true);
    });

    it('SELLER con userId ajeno en la query: el filtro se ignora, nunca escapa el ámbito propio', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ userId: seller409Id, limit: 100 })
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCashSessionBody>;
      expect(body.data.every((row) => row.userId === sellerId)).toBe(true);
      expect(body.data.some((row) => row.userId === seller409Id)).toBe(false);
    });

    it('paginación: limit=1 devuelve exactamente 1 fila con total real', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ limit: 1, page: 1 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCashSessionBody>;
      expect(body.data).toHaveLength(1);
      expect(body.limit).toBe(1);
      expect(body.total).toBeGreaterThanOrEqual(1);
    });

    it('filtro status=OPEN devuelve solo filas OPEN', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ status: CashSessionStatus.OPEN, limit: 100 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCashSessionBody>;
      expect(
        body.data.every((row) => row.status === CashSessionStatus.OPEN),
      ).toBe(true);
    });

    it('filtro openedFrom en el futuro: no encuentra las sesiones ya creadas', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ openedFrom: '2099-01-01', limit: 100 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeCashSessionBody>;
      expect(body.data.every((row) => row.userId !== sellerId)).toBe(true);
    });

    it('fecha inválida -> 400', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .query({ openedFrom: '2026-99-99' })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(400);
    });

    it('WAREHOUSE -> 403', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions')
        .set('Cookie', warehouseCookie);
      expect(response.status).toBe(403);
    });
  });

  // ==================================================================
  // GET /cash-sessions/:id
  // ==================================================================
  describe('GET /cash-sessions/:id', () => {
    it('ADMIN lee el detalle de la sesión del SELLER principal', async () => {
      const sellerSession = await prisma.cashSession.findFirstOrThrow({
        where: { userId: sellerId },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/cash-sessions/${sellerSession.id}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect((response.body as SafeCashSessionBody).userId).toBe(sellerId);
    });

    it('MANAGEMENT lee el detalle de la sesión del SELLER principal', async () => {
      const sellerSession = await prisma.cashSession.findFirstOrThrow({
        where: { userId: sellerId },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/cash-sessions/${sellerSession.id}`)
        .set('Cookie', managementCookie);
      expect(response.status).toBe(200);
    });

    it('SELLER lee su propia sesión', async () => {
      const sellerSession = await prisma.cashSession.findFirstOrThrow({
        where: { userId: sellerId },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/cash-sessions/${sellerSession.id}`)
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(200);
    });

    it('SELLER no puede leer una sesión ajena -> 404 (nunca 403)', async () => {
      const foreignSession = await prisma.cashSession.findFirstOrThrow({
        where: { userId: seller409Id },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/cash-sessions/${foreignSession.id}`)
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(404);
    });

    it('WAREHOUSE -> 403', async () => {
      const sellerSession = await prisma.cashSession.findFirstOrThrow({
        where: { userId: sellerId },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/cash-sessions/${sellerSession.id}`)
        .set('Cookie', warehouseCookie);
      expect(response.status).toBe(403);
    });

    it('ID inexistente -> 404', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/cash-sessions/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(404);
    });
  });

  // ==================================================================
  // Concurrencia real (§27 del plan aprobado)
  // ==================================================================
  describe('concurrencia real de apertura', () => {
    it('dos POST /open simultáneos del mismo usuario: exactamente uno 201 y uno 409', async () => {
      const [resultA, resultB] = await Promise.allSettled([
        openCashSession(sellerRaceCookie, '10.00'),
        openCashSession(sellerRaceCookie, '20.00'),
      ]);

      const statuses = [resultA, resultB].map((result) =>
        result.status === 'fulfilled' ? result.value.status : -1,
      );
      expect(statuses.sort()).toEqual([201, 409]);

      const successResponse =
        resultA.status === 'fulfilled' && resultA.value.status === 201
          ? resultA.value
          : resultB.status === 'fulfilled' && resultB.value.status === 201
            ? resultB.value
            : null;
      expect(successResponse).not.toBeNull();
      if (successResponse) {
        const winningId = (successResponse.body as SafeCashSessionBody).id;
        ownedSessionIds.push(winningId);
        await trackLatestAuditRow(AuditAction.CASH_SESSION_OPENED, winningId);
      }

      const finalCount = await prisma.cashSession.count({
        where: { userId: sellerRaceId },
      });
      expect(finalCount).toBe(1);
    });
  });
});
