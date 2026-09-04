import { INestApplication } from '@nestjs/common';
import {
  CashSessionStatus,
  DocumentType,
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
 * Ticket B post-MVP, Bloques B2+B3 — CashSessionsModule. Fixtures propios
 * de esta suite (nunca reutiliza el admin/seller compartido de otras
 * suites): CashSession tiene la invariante "como máximo una sin resolver
 * por usuario", así que cada escenario que necesita una precondición
 * concreta usa su propio usuario dedicado, para no interferir entre
 * pruebas dentro del mismo archivo — o encadena estados secuencialmente en
 * el MISMO usuario cuando un estado ya resuelto (OPEN tras un cierre
 * exacto, o CLOSED) no bloquea una apertura siguiente. Toda CashSession
 * creada aquí se elimina por su ID exacto en afterAll (nunca
 * deleteMany({}) sobre toda la tabla); los usuarios fixture SELLER/
 * MANAGEMENT/WAREHOUSE, idempotentes vía upsertFixtureUser, se conservan
 * entre corridas (mismo criterio que el resto del repositorio). Para el
 * caso ADMIN se reutiliza el admin compartido (E2E_ADMIN_USERNAME) como
 * PRIMER revisor siempre que sea posible; el único ADMIN adicional
 * (ADMIN2_USERNAME, necesario para probar "un ADMIN nunca puede
 * aprobar/rechazar su propia caja" vs. "un ADMIN distinto sí puede") es
 * efímero: se crea en beforeAll y se ELIMINA por completo en afterAll —
 * nunca queda persistente, porque users-admin-concurrency.e2e-spec.ts
 * cuenta el TOTAL de usuarios ADMIN activos en toda la base de datos como
 * precondición exacta de sus escenarios.
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
const SELLER_CLOSE_USERNAME = 'e2e_seller_cash_sessions_close';
const SELLER_CLOSE_PASSWORD = 'SellerCashSessionsCCC';
const SELLER_EXPECTED_USERNAME = 'e2e_seller_cash_sessions_expected';
const SELLER_EXPECTED_PASSWORD = 'SellerCashSessionsDDD';
const SELLER_APPROVAL_USERNAME = 'e2e_seller_cash_sessions_approval';
const SELLER_APPROVAL_PASSWORD = 'SellerCashSessionsEEE';
const SELLER_REJECT_USERNAME = 'e2e_seller_cash_sessions_reject';
const SELLER_REJECT_PASSWORD = 'SellerCashSessionsFFF';
const SELLER_RESOLUTION_RACE_USERNAME = 'e2e_seller_cash_sessions_resrace';
const SELLER_RESOLUTION_RACE_PASSWORD = 'SellerCashSessionsGGG';
const MANAGEMENT_USERNAME = 'e2e_management_cash_sessions';
const MANAGEMENT_PASSWORD = 'ManagementCashSessions123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_cash_sessions';
const WAREHOUSE_PASSWORD = 'WarehouseCashSessions123';
const ADMIN2_USERNAME = 'e2e_admin2_cash_sessions_ephemeral';
const ADMIN2_PASSWORD = 'Admin2CashSessionsHHH';

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

interface SafeCashSessionMethodBreakdownRowBody {
  paymentMethodId: string;
  paymentMethodCode: string;
  paymentMethodName: string;
  totalAmount: string;
}

interface SafeCashSessionDetailBody extends SafeCashSessionBody {
  liveCollectionsTotal: string | null;
  liveCashCollectionsTotal: string | null;
  liveExpectedCashAmount: string | null;
  liveBreakdownByMethod: SafeCashSessionMethodBreakdownRowBody[] | null;
  breakdownByMethod: SafeCashSessionMethodBreakdownRowBody[] | null;
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
  let sellerCloseCookie: string;
  let sellerExpectedCookie: string;
  let sellerApprovalCookie: string;
  let sellerRejectCookie: string;
  let sellerResolutionRaceCookie: string;
  let managementCookie: string;
  let warehouseCookie: string;
  let admin2Cookie: string;

  /** IDs propios de CashSession/AuditLog generados por esta suite (cleanup exacto en afterAll). */
  const ownedSessionIds: string[] = [];
  const ownedAuditLogIds: string[] = [];
  /** Fixtures de Payment/Sale/Customer/Product vinculadas (Ticket B, Bloque B3: prueba de efectivo esperado), cleanup exacto en afterAll. */
  const ownedPaymentIds: string[] = [];
  const ownedSaleIds: string[] = [];
  const ownedCustomerIds: string[] = [];
  const ownedProductIds: string[] = [];

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
      username: SELLER_CLOSE_USERNAME,
      email: 'e2e_seller_cash_sessions_close@demosystem.test',
      password: SELLER_CLOSE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_EXPECTED_USERNAME,
      email: 'e2e_seller_cash_sessions_expected@demosystem.test',
      password: SELLER_EXPECTED_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_APPROVAL_USERNAME,
      email: 'e2e_seller_cash_sessions_approval@demosystem.test',
      password: SELLER_APPROVAL_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_REJECT_USERNAME,
      email: 'e2e_seller_cash_sessions_reject@demosystem.test',
      password: SELLER_REJECT_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_RESOLUTION_RACE_USERNAME,
      email: 'e2e_seller_cash_sessions_resrace@demosystem.test',
      password: SELLER_RESOLUTION_RACE_PASSWORD,
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
    // ADMIN efímero (ver docblock de cabecera): se elimina por completo en
    // afterAll, nunca queda persistente.
    await upsertFixtureUser(prisma, {
      username: ADMIN2_USERNAME,
      email: 'e2e_admin2_cash_sessions_ephemeral@demosystem.test',
      password: ADMIN2_PASSWORD,
      roleName: RoleName.ADMIN,
    });

    // Secuencia NV: mismo criterio exacto que accounting.e2e-spec.ts/
    // reports.e2e-spec.ts/sales.e2e-spec.ts. Esta suite crea Sales reales
    // (createLinkedPayment, Ticket B Bloque B3), así que debe garantizar
    // defensivamente que la fila exista (recreándola fresca en 0 si una
    // suite previa la dejó ausente vía su propio afterAll), sin pisar un
    // contador ya en curso si la fila ya existe (update: {} es un no-op).
    await prisma.documentSequence.upsert({
      where: { documentType: DocumentType.SALE },
      update: {},
      create: {
        documentType: DocumentType.SALE,
        prefix: 'NV-',
        currentNumber: 0,
        padding: 6,
      },
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
    sellerCloseCookie = (
      await login(
        app.getHttpServer(),
        SELLER_CLOSE_USERNAME,
        SELLER_CLOSE_PASSWORD,
      )
    ).cookie;
    sellerExpectedCookie = (
      await login(
        app.getHttpServer(),
        SELLER_EXPECTED_USERNAME,
        SELLER_EXPECTED_PASSWORD,
      )
    ).cookie;
    sellerApprovalCookie = (
      await login(
        app.getHttpServer(),
        SELLER_APPROVAL_USERNAME,
        SELLER_APPROVAL_PASSWORD,
      )
    ).cookie;
    sellerRejectCookie = (
      await login(
        app.getHttpServer(),
        SELLER_REJECT_USERNAME,
        SELLER_REJECT_PASSWORD,
      )
    ).cookie;
    sellerResolutionRaceCookie = (
      await login(
        app.getHttpServer(),
        SELLER_RESOLUTION_RACE_USERNAME,
        SELLER_RESOLUTION_RACE_PASSWORD,
      )
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    admin2Cookie = (
      await login(app.getHttpServer(), ADMIN2_USERNAME, ADMIN2_PASSWORD)
    ).cookie;
  });

  afterAll(async () => {
    try {
      if (ownedAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedAuditLogIds } },
        });
      }
      // Orden por FK: AccountingEntry (Payment/Sale) -> Payment
      // (cashSessionId RESTRICT hacia CashSession) ->
      // CashSessionPaymentMethodSummary (por si algo quedó sin resolver
      // hacia OPEN) -> CashSession -> Sale -> Customer/Product.
      if (ownedPaymentIds.length > 0 || ownedSaleIds.length > 0) {
        await prisma.accountingEntry.deleteMany({
          where: {
            OR: [
              ...(ownedPaymentIds.length > 0
                ? [
                    {
                      sourceType: 'PAYMENT' as const,
                      sourceId: { in: ownedPaymentIds },
                    },
                  ]
                : []),
              ...(ownedSaleIds.length > 0
                ? [
                    {
                      sourceType: 'SALE' as const,
                      sourceId: { in: ownedSaleIds },
                    },
                  ]
                : []),
            ],
          },
        });
      }
      if (ownedPaymentIds.length > 0) {
        await prisma.payment.deleteMany({
          where: { id: { in: ownedPaymentIds } },
        });
      }
      if (ownedSessionIds.length > 0) {
        await prisma.cashSessionPaymentMethodSummary.deleteMany({
          where: { cashSessionId: { in: ownedSessionIds } },
        });
        await prisma.cashSession.deleteMany({
          where: { id: { in: ownedSessionIds } },
        });
      }
      if (ownedSaleIds.length > 0) {
        await prisma.sale.deleteMany({ where: { id: { in: ownedSaleIds } } });
        // Secuencia NV: mismo criterio exacto que accounting.e2e-spec.ts/
        // reports.e2e-spec.ts/sales.e2e-spec.ts (se elimina al final, nunca
        // solo se resetea el contador): esta suite crea Sales reales igual
        // que aquellas (vía createLinkedPayment, Ticket B Bloque B3), así
        // que asume la misma responsabilidad de dejar la fila ausente para
        // que el siguiente archivo que la necesite la recree fresca en 0
        // vía su propio upsert defensivo. Sin este paso, cualquier suite
        // posterior que asuma "currentNumber = 0 antes de la primera venta"
        // (sales.e2e-spec.ts) fallaría por un efecto colateral de esta
        // suite.
        await prisma.documentSequence.deleteMany({
          where: { documentType: DocumentType.SALE },
        });
      }
      if (ownedProductIds.length > 0) {
        await prisma.product.deleteMany({
          where: { id: { in: ownedProductIds } },
        });
      }
      if (ownedCustomerIds.length > 0) {
        await prisma.customer.deleteMany({
          where: { id: { in: ownedCustomerIds } },
        });
      }
      // ADMIN efímero: sus propias CashSession ya se eliminaron arriba
      // (rastreadas en ownedSessionIds), así que el borrado del usuario
      // nunca choca contra la FK CashSession.userId (RESTRICT).
      await prisma.user.deleteMany({ where: { username: ADMIN2_USERNAME } });
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

  async function closeSession(
    cookie: string,
    body: { countedCashAmount: string; closingObservation?: string },
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/cash-sessions/current/close')
      .set('Cookie', cookie)
      .send(body);
  }

  async function approveSession(
    cookie: string,
    id: string,
    body: { comment?: string } = {},
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/cash-sessions/${id}/approve`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function rejectSession(
    cookie: string,
    id: string,
    body: { reason?: string },
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/cash-sessions/${id}/reject`)
      .set('Cookie', cookie)
      .send(body);
  }

  /**
   * Crea un Sale + Payment real vía la API pública. Desde el Ticket B,
   * Bloque B4, PaymentEngine.register() vincula Payment.cashSessionId
   * automáticamente a la caja OPEN del actor (sellerCookieForFixture) —
   * esta función ya NO escribe ese campo a mano (a diferencia del Bloque
   * B3, que sí lo hacía como scaffolding explícito mientras B4 no
   * existía): en su lugar, verifica que el vínculo automático coincida
   * exactamente con `cashSessionId` (la caja abierta previamente por el
   * propio test para ese mismo actor), lo cual prueba genuinamente la
   * integración B4 en vez de asumirla. La anulación, si se pide, pasa
   * SIEMPRE por el endpoint real (nunca una escritura cruda de status):
   * §27 exige probar el snapshot de CashSession sin alterar el
   * comportamiento real de PaymentsService.cancel().
   */
  async function createLinkedPayment(
    sellerCookieForFixture: string,
    cashSessionId: string,
    method: string,
    amount: string,
    options: { reference?: string } = {},
  ): Promise<{
    id: string;
    saleId: string;
    paymentMethodAffectsCashDrawer: boolean;
  }> {
    const category = await prisma.category.findFirstOrThrow({
      where: { code: 'SERVICIOS' },
    });
    const unit = await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } });

    const customerResponse = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Cookie', sellerCookieForFixture)
      .send({
        customerType: 'PERSON',
        customerStage: 'CUSTOMER',
        name: `Cliente B3 ${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      });
    expect(customerResponse.status).toBe(201);
    const customerId = (customerResponse.body as { id: string }).id;
    ownedCustomerIds.push(customerId);

    const productResponse = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: `B3-CS-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        name: 'Servicio fixture Bloque B3',
        productType: 'SERVICE',
        categoryId: category.id,
        unitId: unit.id,
        salePrice: amount,
        isInventoryTracked: false,
      });
    expect(productResponse.status).toBe(201);
    const productId = (productResponse.body as { id: string }).id;
    ownedProductIds.push(productId);

    const saleResponse = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', sellerCookieForFixture)
      .send({ customerId, items: [{ productId, quantity: '1' }] });
    expect(saleResponse.status).toBe(201);
    const saleId = (saleResponse.body as { id: string }).id;
    ownedSaleIds.push(saleId);

    const paymentResponse = await request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments`)
      .set('Cookie', sellerCookieForFixture)
      .send({ method, amount, reference: options.reference });
    expect(paymentResponse.status).toBe(201);
    const paymentId = (paymentResponse.body as { payment: { id: string } })
      .payment.id;
    ownedPaymentIds.push(paymentId);

    // Ticket B, Bloque B4: prueba genuina de la integración — el vínculo
    // ya lo asignó PaymentEngine.register() él mismo, nunca esta fixture.
    const linked = await prisma.payment.findUniqueOrThrow({
      where: { id: paymentId },
      select: {
        id: true,
        cashSessionId: true,
        paymentMethodAffectsCashDrawer: true,
      },
    });
    expect(linked.cashSessionId).toBe(cashSessionId);
    return { ...linked, saleId };
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

  // ==================================================================
  // POST /cash-sessions/current/close — matriz (Ticket B, Bloque B3 §35)
  // ==================================================================
  describe('POST /cash-sessions/current/close', () => {
    it('OPEN, diferencia cero -> CLOSED directo, sin revisor', async () => {
      const session = await openCashSessionOrThrow(sellerCloseCookie, '100.00');
      const response = await closeSession(sellerCloseCookie, {
        countedCashAmount: '100.00',
      });
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      expect(body.id).toBe(session.id);
      expect(body.status).toBe(CashSessionStatus.CLOSED);
      expect(body.differenceAmount).toBe('0.00');
      expect(body.approvedByUserId).toBeNull();
      expect(body.closedAt).not.toBeNull();
      await trackLatestAuditRow(AuditAction.CASH_SESSION_CLOSED, session.id);
    });

    it('descuadre sin closingObservation -> 400, la caja sigue OPEN', async () => {
      const session = await openCashSessionOrThrow(sellerCloseCookie, '100.00');
      const response = await closeSession(sellerCloseCookie, {
        countedCashAmount: '90.00',
      });
      expect(response.status).toBe(400);
      const current = await prisma.cashSession.findUniqueOrThrow({
        where: { id: session.id },
      });
      expect(current.status).toBe(CashSessionStatus.OPEN);
    });

    it('descuadre con closingObservation válida -> PENDING_APPROVAL, audita CASH_SESSION_CLOSING_REQUESTED', async () => {
      const response = await closeSession(sellerCloseCookie, {
        countedCashAmount: '90.00',
        closingObservation: 'Faltante justificado por vuelto',
      });
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      expect(body.status).toBe(CashSessionStatus.PENDING_APPROVAL);
      expect(body.differenceAmount).toBe('-10.00');
      expect(body.closingObservation).toBe('Faltante justificado por vuelto');
      expect(body.closedAt).toBeNull();
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_CLOSING_REQUESTED,
        body.id,
      );
    });

    it('segundo cierre mientras PENDING_APPROVAL -> 409, snapshot no se sobrescribe', async () => {
      const before = await prisma.cashSession.findFirstOrThrow({
        where: {
          userId: (
            await prisma.user.findUniqueOrThrow({
              where: { username: SELLER_CLOSE_USERNAME },
            })
          ).id,
          status: CashSessionStatus.PENDING_APPROVAL,
        },
      });
      const response = await closeSession(sellerCloseCookie, {
        countedCashAmount: '999.00',
        closingObservation: 'intento de sobrescritura',
      });
      expect(response.status).toBe(409);
      const after = await prisma.cashSession.findUniqueOrThrow({
        where: { id: before.id },
      });
      expect(after.countedCashAmount?.toFixed(2)).toBe(
        before.countedCashAmount?.toFixed(2),
      );
      expect(after.closingObservation).toBe(before.closingObservation);
    });

    it('sin caja sin resolver -> 404', async () => {
      const response = await closeSession(sellerNoSessionCookie, {
        countedCashAmount: '0',
      });
      expect(response.status).toBe(404);
    });

    it('countedCashAmount negativo -> 400', async () => {
      const response = await closeSession(seller2Cookie, {
        countedCashAmount: '-1.00',
      });
      expect(response.status).toBe(400);
    });

    it('MANAGEMENT -> 403', async () => {
      const response = await closeSession(managementCookie, {
        countedCashAmount: '0',
      });
      expect(response.status).toBe(403);
    });

    it('WAREHOUSE -> 403', async () => {
      const response = await closeSession(warehouseCookie, {
        countedCashAmount: '0',
      });
      expect(response.status).toBe(403);
    });
  });

  // ==================================================================
  // Cálculo de efectivo esperado (Ticket B, Bloque B3 §36)
  // ==================================================================
  describe('cálculo de efectivo esperado', () => {
    it('opening 100 + CASH 200 (afecta caja) + CARD 300 (no afecta caja) -> expected 300, collectionsTotal 500, cashCollectionsTotal 200; CANCELLED excluido', async () => {
      const session = await openCashSessionOrThrow(
        sellerExpectedCookie,
        '100.00',
      );

      const cashPayment = await createLinkedPayment(
        sellerExpectedCookie,
        session.id,
        'CASH',
        '200.00',
      );
      expect(cashPayment.paymentMethodAffectsCashDrawer).toBe(true);

      const cardPayment = await createLinkedPayment(
        sellerExpectedCookie,
        session.id,
        'CARD',
        '300.00',
        { reference: 'OP-B3-CARD' },
      );
      expect(cardPayment.paymentMethodAffectsCashDrawer).toBe(false);

      // Payment vinculado pero luego anulado por el flujo REAL de
      // cancelación (nunca una escritura cruda de status): debe excluirse
      // por completo del cálculo, igual que si nunca hubiera existido.
      const cancelledPayment = await createLinkedPayment(
        sellerExpectedCookie,
        session.id,
        'CASH',
        '999.00',
      );
      const cancelResponse = await request(app.getHttpServer())
        .post(
          `/api/v1/sales/${cancelledPayment.saleId}/payments/${cancelledPayment.id}/cancel`,
        )
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación fixture B3 — excluir del cálculo' });
      expect(cancelResponse.status).toBe(200);

      const currentResponse = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerExpectedCookie);
      expect(currentResponse.status).toBe(200);
      const currentBody = currentResponse.body as SafeCashSessionDetailBody;
      expect(currentBody.liveCollectionsTotal).toBe('500.00');
      expect(currentBody.liveCashCollectionsTotal).toBe('200.00');
      expect(currentBody.liveExpectedCashAmount).toBe('300.00');
      expect(currentBody.liveBreakdownByMethod).toHaveLength(2);
      expect(currentBody.breakdownByMethod).toBeNull();

      const closeResponse = await closeSession(sellerExpectedCookie, {
        countedCashAmount: '300.00',
      });
      expect(closeResponse.status).toBe(200);
      const closed = closeResponse.body as SafeCashSessionBody;
      expect(closed.status).toBe(CashSessionStatus.CLOSED);
      expect(closed.expectedCashAmount).toBe('300.00');
      expect(closed.differenceAmount).toBe('0.00');
      await trackLatestAuditRow(AuditAction.CASH_SESSION_CLOSED, session.id);

      const detailResponse = await request(app.getHttpServer())
        .get(`/api/v1/cash-sessions/${session.id}`)
        .set('Cookie', sellerExpectedCookie);
      expect(detailResponse.status).toBe(200);
      const detailBody = detailResponse.body as SafeCashSessionDetailBody;
      expect(detailBody.liveExpectedCashAmount).toBeNull();
      expect(detailBody.breakdownByMethod).toHaveLength(2);
      const cashRow = detailBody.breakdownByMethod?.find(
        (row) => row.paymentMethodCode === 'CASH',
      );
      const cardRow = detailBody.breakdownByMethod?.find(
        (row) => row.paymentMethodCode === 'CARD',
      );
      expect(cashRow?.totalAmount).toBe('200.00');
      expect(cardRow?.totalAmount).toBe('300.00');

      const summaryCount = await prisma.cashSessionPaymentMethodSummary.count({
        where: { cashSessionId: session.id },
      });
      expect(summaryCount).toBe(2);
    });
  });

  // ==================================================================
  // POST /cash-sessions/:id/approve — matriz (Ticket B, Bloque B3 §37)
  // ==================================================================
  describe('POST /cash-sessions/:id/approve', () => {
    async function openAndRequestPending(
      cookie: string,
      amount = '100.00',
      counted = '90.00',
    ): Promise<SafeCashSessionBody> {
      await openCashSessionOrThrow(cookie, amount);
      const response = await closeSession(cookie, {
        countedCashAmount: counted,
        closingObservation: 'Descuadre fixture B3',
      });
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_CLOSING_REQUESTED,
        body.id,
      );
      return body;
    }

    it('ADMIN aprueba la caja PENDING_APPROVAL de un SELLER -> CLOSED', async () => {
      const pending = await openAndRequestPending(sellerApprovalCookie);
      const response = await approveSession(adminCookie, pending.id);
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      expect(body.status).toBe(CashSessionStatus.CLOSED);
      expect(body.approvedByUserId).not.toBeNull();
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('MANAGEMENT aprueba la caja PENDING_APPROVAL de un SELLER -> CLOSED', async () => {
      const pending = await openAndRequestPending(sellerApprovalCookie);
      const response = await approveSession(managementCookie, pending.id);
      expect(response.status).toBe(200);
      expect((response.body as SafeCashSessionBody).status).toBe(
        CashSessionStatus.CLOSED,
      );
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('SELLER -> 403', async () => {
      const pending = await openAndRequestPending(sellerApprovalCookie);
      const response = await approveSession(sellerApprovalCookie, pending.id);
      expect(response.status).toBe(403);
      // Limpieza: la caja sigue pendiente; la resuelve ADMIN para no dejar
      // un residuo PENDING_APPROVAL fuera de las aserciones de este test.
      await approveSession(adminCookie, pending.id);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('WAREHOUSE -> 403', async () => {
      const pending = await openAndRequestPending(sellerApprovalCookie);
      const response = await approveSession(warehouseCookie, pending.id);
      expect(response.status).toBe(403);
      await approveSession(adminCookie, pending.id);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('caja no está PENDING_APPROVAL (ya CLOSED) -> 409', async () => {
      const pending = await openAndRequestPending(sellerApprovalCookie);
      const first = await approveSession(adminCookie, pending.id);
      expect(first.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
      const second = await approveSession(adminCookie, pending.id);
      expect(second.status).toBe(409);
    });

    it('ADMIN nunca puede aprobar su propia caja -> 403; un ADMIN distinto sí puede', async () => {
      const pending = await openAndRequestPending(admin2Cookie);
      const selfAttempt = await approveSession(admin2Cookie, pending.id);
      expect(selfAttempt.status).toBe(403);

      const otherAdminAttempt = await approveSession(adminCookie, pending.id);
      expect(otherAdminAttempt.status).toBe(200);
      expect((otherAdminAttempt.body as SafeCashSessionBody).status).toBe(
        CashSessionStatus.CLOSED,
      );
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('MANAGEMENT puede aprobar la caja de un ADMIN', async () => {
      const pending = await openAndRequestPending(admin2Cookie);
      const response = await approveSession(managementCookie, pending.id);
      expect(response.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('comment opcional se normaliza y viaja en la respuesta', async () => {
      const pending = await openAndRequestPending(sellerApprovalCookie);
      const response = await approveSession(adminCookie, pending.id, {
        comment: '  Verificado con el cobrador  ',
      });
      expect(response.status).toBe(200);
      expect((response.body as SafeCashSessionBody).approvalComment).toBe(
        'Verificado con el cobrador',
      );
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('ID inexistente -> 404', async () => {
      const response = await approveSession(adminCookie, NON_EXISTENT_UUID);
      expect(response.status).toBe(404);
    });
  });

  // ==================================================================
  // POST /cash-sessions/:id/reject — matriz (Ticket B, Bloque B3 §38)
  // ==================================================================
  describe('POST /cash-sessions/:id/reject', () => {
    async function openAndRequestPending(
      cookie: string,
      amount = '100.00',
      counted = '90.00',
    ): Promise<SafeCashSessionBody> {
      await openCashSessionOrThrow(cookie, amount);
      const response = await closeSession(cookie, {
        countedCashAmount: counted,
        closingObservation: 'Descuadre fixture B3 rechazo',
      });
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_CLOSING_REQUESTED,
        body.id,
      );
      return body;
    }

    it('rechazo sin reason -> 400, la caja sigue PENDING_APPROVAL', async () => {
      const pending = await openAndRequestPending(sellerRejectCookie);
      const response = await rejectSession(adminCookie, pending.id, {});
      expect(response.status).toBe(400);
      const current = await prisma.cashSession.findUniqueOrThrow({
        where: { id: pending.id },
      });
      expect(current.status).toBe(CashSessionStatus.PENDING_APPROVAL);

      // Limpieza: el 400 deliberadamente NO resuelve la caja (es justo lo
      // que se está probando). Se aprueba (nunca se rechaza) a propósito:
      // un rechazo solo devuelve la caja a OPEN, que sigue siendo "sin
      // resolver" y bloquearía el siguiente test de este describe —
      // aprobar la lleva a CLOSED (terminal), dejando a sellerRejectCookie
      // libre para abrir de nuevo.
      const cleanup = await approveSession(adminCookie, pending.id);
      expect(cleanup.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('ADMIN rechaza -> OPEN; snapshot limpiado; resumen eliminado; AuditLog captura el snapshot previo', async () => {
      const opened = await openCashSessionOrThrow(sellerRejectCookie, '100.00');
      // Payment vinculado ANTES del cierre, para que la fila de resumen
      // que se prueba "eliminada" abajo sea real (nunca un conteo
      // trivialmente en cero por falta de datos).
      await createLinkedPayment(sellerRejectCookie, opened.id, 'CASH', '50.00');
      const closeResponse = await closeSession(sellerRejectCookie, {
        countedCashAmount: '90.00',
        closingObservation: 'Descuadre fixture B3 rechazo',
      });
      expect(closeResponse.status).toBe(200);
      const pending = closeResponse.body as SafeCashSessionBody;
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_CLOSING_REQUESTED,
        pending.id,
      );

      const summaryCountBefore =
        await prisma.cashSessionPaymentMethodSummary.count({
          where: { cashSessionId: pending.id },
        });
      expect(summaryCountBefore).toBe(1);

      const response = await rejectSession(adminCookie, pending.id, {
        reason: 'El conteo no coincide con lo reportado',
      });
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      expect(body.status).toBe(CashSessionStatus.OPEN);
      expect(body.closeRequestedAt).toBeNull();
      expect(body.expectedCashAmount).toBeNull();
      expect(body.countedCashAmount).toBeNull();
      expect(body.differenceAmount).toBeNull();
      expect(body.closingObservation).toBeNull();
      expect(body.closedAt).toBeNull();
      expect(body.approvedByUserId).toBeNull();
      expect(body.approvalComment).toBeNull();

      const summaryCountAfter =
        await prisma.cashSessionPaymentMethodSummary.count({
          where: { cashSessionId: pending.id },
        });
      expect(summaryCountAfter).toBe(0);

      const auditRow = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.CASH_SESSION_DISCREPANCY_REJECTED,
          entityId: pending.id,
        },
        orderBy: { createdAt: 'desc' },
      });
      ownedAuditLogIds.push(auditRow.id);
      const metadata = auditRow.metadata as {
        reason: string;
        previousDifferenceAmount: string;
      };
      expect(metadata.reason).toBe('El conteo no coincide con lo reportado');
      // opening 100.00 + CASH 50.00 vinculado = expected 150.00; counted 90.00.
      expect(metadata.previousDifferenceAmount).toBe('-60.00');
      assertAuditRowHasNoSecrets(auditRow);

      // El rechazo deja la caja OPEN — "sin resolver" todavía (la
      // invariante de "como máximo una sin resolver" no distingue OPEN de
      // PENDING_APPROVAL) — se cierra para dejar a sellerRejectCookie
      // libre para el siguiente test de este describe. El Payment CASH
      // vinculado (50.00) sigue vinculado tras el rechazo (el rechazo
      // limpia el snapshot de CashSession, nunca desvincula Payments), así
      // que el efectivo esperado ahora es 100.00 (opening) + 50.00 = 150.00.
      const closeCleanup = await closeSession(sellerRejectCookie, {
        countedCashAmount: '150.00',
      });
      expect(closeCleanup.status).toBe(200);
      await trackLatestAuditRow(AuditAction.CASH_SESSION_CLOSED, pending.id);
    });

    it('MANAGEMENT rechaza -> OPEN', async () => {
      const pending = await openAndRequestPending(sellerRejectCookie);
      const response = await rejectSession(managementCookie, pending.id, {
        reason: 'Motivo de MANAGEMENT',
      });
      expect(response.status).toBe(200);
      expect((response.body as SafeCashSessionBody).status).toBe(
        CashSessionStatus.OPEN,
      );
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_REJECTED,
        pending.id,
      );

      const closeCleanup = await closeSession(sellerRejectCookie, {
        countedCashAmount: '100.00',
      });
      expect(closeCleanup.status).toBe(200);
      await trackLatestAuditRow(AuditAction.CASH_SESSION_CLOSED, pending.id);
    });

    it('SELLER -> 403', async () => {
      const pending = await openAndRequestPending(sellerRejectCookie);
      const response = await rejectSession(sellerRejectCookie, pending.id, {
        reason: 'motivo',
      });
      expect(response.status).toBe(403);
      // Limpieza: aprobar (nunca rechazar) resuelve a CLOSED (terminal) en
      // un solo paso, dejando a sellerRejectCookie libre para el siguiente
      // test.
      const cleanup = await approveSession(adminCookie, pending.id);
      expect(cleanup.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('WAREHOUSE -> 403', async () => {
      const pending = await openAndRequestPending(sellerRejectCookie);
      const response = await rejectSession(warehouseCookie, pending.id, {
        reason: 'motivo',
      });
      expect(response.status).toBe(403);
      const cleanup = await approveSession(adminCookie, pending.id);
      expect(cleanup.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('ADMIN nunca puede rechazar su propia caja -> 403', async () => {
      const pending = await openAndRequestPending(admin2Cookie);
      const response = await rejectSession(admin2Cookie, pending.id, {
        reason: 'motivo',
      });
      expect(response.status).toBe(403);
      // Limpieza vía un ADMIN DISTINTO (adminCookie, nunca admin2Cookie):
      // aprobar resuelve a CLOSED en un solo paso.
      const cleanup = await approveSession(adminCookie, pending.id);
      expect(cleanup.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        pending.id,
      );
    });

    it('caja no está PENDING_APPROVAL (ya OPEN) -> 409', async () => {
      const pending = await openAndRequestPending(sellerRejectCookie);
      const first = await rejectSession(adminCookie, pending.id, {
        reason: 'primero',
      });
      expect(first.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_REJECTED,
        pending.id,
      );
      const second = await rejectSession(adminCookie, pending.id, {
        reason: 'segundo',
      });
      expect(second.status).toBe(409);

      const closeCleanup = await closeSession(sellerRejectCookie, {
        countedCashAmount: '100.00',
      });
      expect(closeCleanup.status).toBe(200);
      await trackLatestAuditRow(AuditAction.CASH_SESSION_CLOSED, pending.id);
    });

    it('ID inexistente -> 404', async () => {
      const response = await rejectSession(adminCookie, NON_EXISTENT_UUID, {
        reason: 'motivo',
      });
      expect(response.status).toBe(404);
    });

    it('tras el rechazo, el operador cierra de nuevo sin ningún residuo del intento anterior (§23 del plan aprobado)', async () => {
      const pending = await openAndRequestPending(
        sellerRejectCookie,
        '100.00',
        '80.00',
      );
      const rejectResponse = await rejectSession(adminCookie, pending.id, {
        reason: 'Reintente el conteo',
      });
      expect(rejectResponse.status).toBe(200);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_REJECTED,
        pending.id,
      );

      // Nuevo cierre EXACTO (sin descuadre esta vez): debe recalcular
      // desde cero, sin ningún valor del intento rechazado.
      const recloseResponse = await closeSession(sellerRejectCookie, {
        countedCashAmount: '100.00',
      });
      expect(recloseResponse.status).toBe(200);
      const reclosed = recloseResponse.body as SafeCashSessionBody;
      expect(reclosed.id).toBe(pending.id);
      expect(reclosed.status).toBe(CashSessionStatus.CLOSED);
      expect(reclosed.differenceAmount).toBe('0.00');
      expect(reclosed.closingObservation).toBeNull();
      expect(reclosed.approvedByUserId).toBeNull();
      await trackLatestAuditRow(AuditAction.CASH_SESSION_CLOSED, pending.id);

      const summaryCount = await prisma.cashSessionPaymentMethodSummary.count({
        where: { cashSessionId: pending.id },
      });
      expect(summaryCount).toBe(0);
    });
  });

  // ==================================================================
  // Concurrencia real de resolución — approve/reject (Ticket B, Bloque B3 §39)
  // ==================================================================
  describe('concurrencia real de resolución (approve/reject)', () => {
    async function openAndRequestPending(): Promise<string> {
      await openCashSessionOrThrow(sellerResolutionRaceCookie, '100.00');
      const response = await closeSession(sellerResolutionRaceCookie, {
        countedCashAmount: '90.00',
        closingObservation: 'Descuadre fixture concurrencia B3',
      });
      expect(response.status).toBe(200);
      const body = response.body as SafeCashSessionBody;
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_CLOSING_REQUESTED,
        body.id,
      );
      return body.id;
    }

    it('approve + approve simultáneos: exactamente uno 200, uno 409', async () => {
      const id = await openAndRequestPending();
      const [resultA, resultB] = await Promise.allSettled([
        approveSession(adminCookie, id),
        approveSession(managementCookie, id),
      ]);
      const statuses = [resultA, resultB].map((result) =>
        result.status === 'fulfilled' ? result.value.status : -1,
      );
      expect(statuses.sort()).toEqual([200, 409]);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
        id,
      );

      const final = await prisma.cashSession.findUniqueOrThrow({
        where: { id },
      });
      expect(final.status).toBe(CashSessionStatus.CLOSED);
    });

    it('approve + reject simultáneos: exactamente un ganador', async () => {
      const id = await openAndRequestPending();
      const [resultA, resultB] = await Promise.allSettled([
        approveSession(adminCookie, id),
        rejectSession(managementCookie, id, { reason: 'carrera' }),
      ]);
      const statuses = [resultA, resultB].map((result) =>
        result.status === 'fulfilled' ? result.value.status : -1,
      );
      expect(statuses.sort()).toEqual([200, 409]);

      const final = await prisma.cashSession.findUniqueOrThrow({
        where: { id },
      });
      expect([CashSessionStatus.CLOSED, CashSessionStatus.OPEN]).toContain(
        final.status,
      );
      if (final.status === CashSessionStatus.CLOSED) {
        await trackLatestAuditRow(
          AuditAction.CASH_SESSION_DISCREPANCY_APPROVED,
          id,
        );
      } else {
        await trackLatestAuditRow(
          AuditAction.CASH_SESSION_DISCREPANCY_REJECTED,
          id,
        );
      }
    });

    it('reject + reject simultáneos: exactamente uno 200, uno 409', async () => {
      const id = await openAndRequestPending();
      const [resultA, resultB] = await Promise.allSettled([
        rejectSession(adminCookie, id, { reason: 'motivo A' }),
        rejectSession(managementCookie, id, { reason: 'motivo B' }),
      ]);
      const statuses = [resultA, resultB].map((result) =>
        result.status === 'fulfilled' ? result.value.status : -1,
      );
      expect(statuses.sort()).toEqual([200, 409]);
      await trackLatestAuditRow(
        AuditAction.CASH_SESSION_DISCREPANCY_REJECTED,
        id,
      );

      const final = await prisma.cashSession.findUniqueOrThrow({
        where: { id },
      });
      expect(final.status).toBe(CashSessionStatus.OPEN);
    });
  });
});
