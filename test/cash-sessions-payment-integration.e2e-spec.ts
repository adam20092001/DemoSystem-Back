import { INestApplication } from '@nestjs/common';
import {
  CashSessionStatus,
  DocumentType,
  PaymentMethodAccountingDestination,
  Prisma,
  PrismaClient,
  RoleName,
} from '@prisma/client';
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
 * Ticket B, Bloque B4 — integración PaymentEngine <-> CashSession: prueba
 * de extremo a extremo (HTTP real, PostgreSQL real) que CUALQUIER registro
 * de un Payment nuevo exige que el cobrador tenga su propia caja OPEN,
 * sobre los TRES caminos de producción (pago explícito, venta directa con
 * pago inicial, conversión de cotización con pago inicial), el caso
 * especial Público general, los totales en vivo derivados de Payments ya
 * vinculados naturalmente (sin ningún montaje manual de fixture, a
 * diferencia del Bloque B3), y la concurrencia real Payment-vs-close que
 * B3 dejó preparada mediante el mismo lock de fila compartido
 * (CashSessionReader.lockUnresolvedForUser()).
 *
 * Archivo DEDICADO, separado de cash-sessions.e2e-spec.ts (B1-B3: ciclo de
 * vida propio de CashSession) y de payments.e2e-spec.ts (dominio de Pagos
 * en general): esta suite prueba específicamente el punto de integración
 * que B4 introduce. Cada actor (seller fixture) es de uso EXCLUSIVO de
 * esta suite (nunca compartido con otro archivo), y cada uno se mueve de
 * forma secuencial y determinista entre estados de caja dentro de sus
 * propios `it()` (mismo criterio de "reutilización secuencial de un solo
 * fixture" ya establecido en cash-sessions.e2e-spec.ts, Bloque B3).
 *
 * Esta suite crea Sales y Quotes reales por HTTP: igual que
 * accounting.e2e-spec.ts/reports.e2e-spec.ts/sales.e2e-spec.ts, asume la
 * responsabilidad de las secuencias NV/COT (upsert defensivo en beforeAll,
 * eliminación en afterAll).
 */
describe('Cash Sessions <-> Payments (e2e) — Ticket B, Bloque B4', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  const SELLER_MATRIX_USERNAME = 'e2e_seller_b4_matrix';
  const SELLER_MATRIX_PASSWORD = 'SellerB4Matrix123';
  const SELLER_PATHS_USERNAME = 'e2e_seller_b4_paths';
  const SELLER_PATHS_PASSWORD = 'SellerB4Paths123';
  const SELLER_PUBLIC_USERNAME = 'e2e_seller_b4_public';
  const SELLER_PUBLIC_PASSWORD = 'SellerB4Public123';
  const SELLER_LIVE_USERNAME = 'e2e_seller_b4_live';
  const SELLER_LIVE_PASSWORD = 'SellerB4Live123';
  const SELLER_RACE_USERNAME = 'e2e_seller_b4_race';
  const SELLER_RACE_PASSWORD = 'SellerB4Race123';
  const SELLER_TWO_USERNAME = 'e2e_seller_b4_two';
  const SELLER_TWO_PASSWORD = 'SellerB4Two123';

  let adminCookie: string;
  let sellerMatrixCookie: string;
  let sellerPathsCookie: string;
  let sellerPublicCookie: string;
  let sellerLiveCookie: string;
  let sellerRaceCookie: string;
  let sellerTwoCookie: string;

  let categoryId: string;
  let unitId: string;
  let genericCustomerId: string;

  const ownedCustomerIds: string[] = [];
  const ownedProductIds: string[] = [];
  const ownedSaleIds: string[] = [];
  const ownedQuoteIds: string[] = [];
  const ownedPaymentIds: string[] = [];
  const ownedSessionIds: string[] = [];
  const ownedPaymentMethodIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_MATRIX_USERNAME,
      email: 'e2e_seller_b4_matrix@demosystem.test',
      password: SELLER_MATRIX_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_PATHS_USERNAME,
      email: 'e2e_seller_b4_paths@demosystem.test',
      password: SELLER_PATHS_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_PUBLIC_USERNAME,
      email: 'e2e_seller_b4_public@demosystem.test',
      password: SELLER_PUBLIC_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_LIVE_USERNAME,
      email: 'e2e_seller_b4_live@demosystem.test',
      password: SELLER_LIVE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_RACE_USERNAME,
      email: 'e2e_seller_b4_race@demosystem.test',
      password: SELLER_RACE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_TWO_USERNAME,
      email: 'e2e_seller_b4_two@demosystem.test',
      password: SELLER_TWO_PASSWORD,
      roleName: RoleName.SELLER,
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
    sellerMatrixCookie = (
      await login(
        app.getHttpServer(),
        SELLER_MATRIX_USERNAME,
        SELLER_MATRIX_PASSWORD,
      )
    ).cookie;
    sellerPathsCookie = (
      await login(
        app.getHttpServer(),
        SELLER_PATHS_USERNAME,
        SELLER_PATHS_PASSWORD,
      )
    ).cookie;
    sellerPublicCookie = (
      await login(
        app.getHttpServer(),
        SELLER_PUBLIC_USERNAME,
        SELLER_PUBLIC_PASSWORD,
      )
    ).cookie;
    sellerLiveCookie = (
      await login(
        app.getHttpServer(),
        SELLER_LIVE_USERNAME,
        SELLER_LIVE_PASSWORD,
      )
    ).cookie;
    sellerRaceCookie = (
      await login(
        app.getHttpServer(),
        SELLER_RACE_USERNAME,
        SELLER_RACE_PASSWORD,
      )
    ).cookie;
    sellerTwoCookie = (
      await login(app.getHttpServer(), SELLER_TWO_USERNAME, SELLER_TWO_PASSWORD)
    ).cookie;

    // Secuencias NV/COT: mismo criterio exacto que sales.e2e-spec.ts/
    // accounting.e2e-spec.ts/reports.e2e-spec.ts — esta suite crea Sales y
    // Quotes reales, así que asume la misma responsabilidad de dejar la
    // fila ausente en afterAll para que el siguiente archivo la recree
    // fresca en 0 vía su propio upsert defensivo.
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

    const category = await prisma.category.findFirstOrThrow({
      where: { code: 'SERVICIOS' },
    });
    categoryId = category.id;
    const unit = await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } });
    unitId = unit.id;

    const generic = await prisma.customer.findFirstOrThrow({
      where: { isGeneric: true },
    });
    genericCustomerId = generic.id;
  }, 120000);

  afterAll(async () => {
    try {
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
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Payment', entityId: { in: ownedPaymentIds } },
        });
        await prisma.payment.deleteMany({
          where: { id: { in: ownedPaymentIds } },
        });
      }
      if (ownedSaleIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: ownedSaleIds } },
        });
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: ownedSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: ownedSaleIds } } });
      }
      if (ownedQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: ownedQuoteIds } },
        });
        await prisma.quote.deleteMany({ where: { id: { in: ownedQuoteIds } } });
      }
      if (ownedSessionIds.length > 0) {
        await prisma.cashSessionPaymentMethodSummary.deleteMany({
          where: { cashSessionId: { in: ownedSessionIds } },
        });
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'CashSession',
            entityId: { in: ownedSessionIds },
          },
        });
        await prisma.cashSession.deleteMany({
          where: { id: { in: ownedSessionIds } },
        });
      }
      await prisma.documentSequence.deleteMany({
        where: {
          documentType: { in: [DocumentType.SALE, DocumentType.QUOTE] },
        },
      });
      if (ownedPaymentMethodIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'PaymentMethod',
            entityId: { in: ownedPaymentMethodIds },
          },
        });
        await prisma.paymentMethod.deleteMany({
          where: { id: { in: ownedPaymentMethodIds } },
        });
      }
      if (ownedProductIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Product', entityId: { in: ownedProductIds } },
        });
        await prisma.product.deleteMany({
          where: { id: { in: ownedProductIds } },
        });
      }
      if (ownedCustomerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Customer', entityId: { in: ownedCustomerIds } },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: ownedCustomerIds } },
        });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  // ====================================================================
  // Helpers
  // ====================================================================

  async function createServiceProduct(salePrice: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: `B4-${nextSuffix()}`,
        name: 'Servicio fixture Bloque B4',
        productType: 'SERVICE',
        categoryId,
        unitId,
        salePrice,
        isInventoryTracked: false,
      });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    ownedProductIds.push(id);
    return id;
  }

  async function createCustomer(cookie: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Cookie', cookie)
      .send({
        customerType: 'PERSON',
        customerStage: 'CUSTOMER',
        name: `Cliente B4 ${nextSuffix()}`,
      });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    ownedCustomerIds.push(id);
    return id;
  }

  async function createSale(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send(body);
  }

  async function registerPayment(
    cookie: string,
    saleId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function openSession(
    cookie: string,
    openingAmount: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/cash-sessions/open')
      .set('Cookie', cookie)
      .send({ openingAmount });
  }

  async function openSessionOrThrow(
    cookie: string,
    openingAmount: string,
  ): Promise<{ id: string }> {
    const response = await openSession(cookie, openingAmount);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo abrir la caja fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const id = (response.body as { id: string }).id;
    ownedSessionIds.push(id);
    return { id };
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

  /** Cierre sin descuadre (countedCashAmount = openingAmount, sin Payments vinculados) — deja al actor sin caja sin resolver. */
  async function closeSessionZeroDiff(
    cookie: string,
    openingAmount: string,
  ): Promise<void> {
    const response = await closeSession(cookie, {
      countedCashAmount: openingAmount,
    });
    expect(response.status).toBe(200);
    expect((response.body as { status: CashSessionStatus }).status).toBe(
      CashSessionStatus.CLOSED,
    );
  }

  // ====================================================================
  // §13-16, §41 — Matriz de estado obligatorio de caja para registrar cobros
  // ====================================================================
  describe('Payment exige caja OPEN del cobrador (§13-16, §41 del plan aprobado)', () => {
    it('sin caja sin resolver -> 409, nunca crea el Payment', async () => {
      const customerId = await createCustomer(sellerMatrixCookie);
      const productId = await createServiceProduct('50.00');
      const saleResponse = await createSale(sellerMatrixCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(saleResponse.status).toBe(201);
      const saleId = (saleResponse.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const before = await prisma.payment.count({ where: { saleId } });
      const response = await registerPayment(sellerMatrixCookie, saleId, {
        method: 'CASH',
        amount: '50.00',
      });
      expect(response.status).toBe(409);
      const after = await prisma.payment.count({ where: { saleId } });
      expect(after).toBe(before);
    });

    it('caja OPEN -> 201, Payment.cashSessionId = la caja del actor', async () => {
      const session = await openSessionOrThrow(sellerMatrixCookie, '0');

      const customerId = await createCustomer(sellerMatrixCookie);
      const productId = await createServiceProduct('50.00');
      const saleResponse = await createSale(sellerMatrixCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(saleResponse.status).toBe(201);
      const saleId = (saleResponse.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const response = await registerPayment(sellerMatrixCookie, saleId, {
        method: 'CASH',
        amount: '50.00',
      });
      expect(response.status).toBe(201);
      const paymentId = (response.body as { payment: { id: string } }).payment
        .id;
      ownedPaymentIds.push(paymentId);

      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(row.cashSessionId).toBe(session.id);
    });

    it('caja PENDING_APPROVAL -> 409, nunca crea el Payment', async () => {
      // Descuadre deliberado sobre la caja recién usada arriba (aún OPEN):
      // countedCashAmount != expectedCashAmount (50.00 cobrado) fuerza
      // PENDING_APPROVAL.
      const closeResponse = await closeSession(sellerMatrixCookie, {
        countedCashAmount: '999.00',
        closingObservation: 'Bloque B4: forzar descuadre para la matriz',
      });
      expect(closeResponse.status).toBe(200);
      expect((closeResponse.body as { status: CashSessionStatus }).status).toBe(
        CashSessionStatus.PENDING_APPROVAL,
      );
      const pendingId = (closeResponse.body as { id: string }).id;

      const customerId = await createCustomer(sellerMatrixCookie);
      const productId = await createServiceProduct('10.00');
      const saleResponse = await createSale(sellerMatrixCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(saleResponse.status).toBe(201);
      const saleId = (saleResponse.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const response = await registerPayment(sellerMatrixCookie, saleId, {
        method: 'CASH',
        amount: '10.00',
      });
      expect(response.status).toBe(409);

      // Resolución (ADMIN nunca es el dueño): deja al actor en CLOSED para
      // el siguiente caso de la matriz.
      const approveResponse = await request(app.getHttpServer())
        .post(`/api/v1/cash-sessions/${pendingId}/approve`)
        .set('Cookie', adminCookie)
        .send({});
      expect(approveResponse.status).toBe(200);
    });

    it('caja CLOSED (sin caja nueva) -> 409, nunca crea el Payment', async () => {
      const customerId = await createCustomer(sellerMatrixCookie);
      const productId = await createServiceProduct('10.00');
      const saleResponse = await createSale(sellerMatrixCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(saleResponse.status).toBe(201);
      const saleId = (saleResponse.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const response = await registerPayment(sellerMatrixCookie, saleId, {
        method: 'CASH',
        amount: '10.00',
      });
      expect(response.status).toBe(409);
    });

    it('cierre y nueva apertura: el siguiente Payment se vincula a la caja NUEVA, nunca a la anterior', async () => {
      const newSession = await openSessionOrThrow(sellerMatrixCookie, '0');

      const customerId = await createCustomer(sellerMatrixCookie);
      const productId = await createServiceProduct('20.00');
      const saleResponse = await createSale(sellerMatrixCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(saleResponse.status).toBe(201);
      const saleId = (saleResponse.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const response = await registerPayment(sellerMatrixCookie, saleId, {
        method: 'CASH',
        amount: '20.00',
      });
      expect(response.status).toBe(201);
      const paymentId = (response.body as { payment: { id: string } }).payment
        .id;
      ownedPaymentIds.push(paymentId);

      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(row.cashSessionId).toBe(newSession.id);

      // Deja al actor resuelto (CLOSED) para no interferir con otra suite.
      await closeSessionZeroDiff(sellerMatrixCookie, '20.00');
    });

    it('método sin afectación de caja (CARD, affectsCashDrawer=false) también exige caja abierta — la exigencia nunca depende de affectsCashDrawer', async () => {
      const customerId = await createCustomer(sellerMatrixCookie);
      const productId = await createServiceProduct('30.00');
      const saleResponse = await createSale(sellerMatrixCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(saleResponse.status).toBe(201);
      const saleId = (saleResponse.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      // El actor no tiene ninguna caja sin resolver en este punto (quedó
      // CLOSED en el caso anterior).
      const response = await registerPayment(sellerMatrixCookie, saleId, {
        method: 'CARD',
        amount: '30.00',
      });
      expect(response.status).toBe(409);
    });
  });

  // ====================================================================
  // §24 — Los tres caminos de creación de Payment en producción
  // ====================================================================
  describe('Los tres caminos de producción exigen caja abierta (§24 del plan aprobado)', () => {
    it('1) pago explícito (POST /sales/:saleId/payments): sin caja -> 409, con caja -> 201', async () => {
      const customerId = await createCustomer(sellerPathsCookie);
      const productId = await createServiceProduct('40.00');
      const sale = await createSale(sellerPathsCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      const saleId = (sale.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const withoutSession = await registerPayment(sellerPathsCookie, saleId, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(withoutSession.status).toBe(409);

      await openSessionOrThrow(sellerPathsCookie, '0');
      const withSession = await registerPayment(sellerPathsCookie, saleId, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(withSession.status).toBe(201);
      ownedPaymentIds.push(
        (withSession.body as { payment: { id: string } }).payment.id,
      );

      await closeSessionZeroDiff(sellerPathsCookie, '40.00');
    });

    it('2) venta directa con pago inicial embebido (POST /sales): sin caja -> 409 (ninguna venta se confirma), con caja -> 201', async () => {
      const customerId = await createCustomer(sellerPathsCookie);
      const productId = await createServiceProduct('60.00');

      const before = await prisma.sale.count();
      const withoutSession = await createSale(sellerPathsCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payment: { method: 'CASH', amount: '60.00' },
      });
      expect(withoutSession.status).toBe(409);
      const after = await prisma.sale.count();
      expect(after).toBe(before);

      await openSessionOrThrow(sellerPathsCookie, '0');
      const withSession = await createSale(sellerPathsCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payment: { method: 'CASH', amount: '60.00' },
      });
      expect(withSession.status).toBe(201);
      const saleId = (withSession.body as { id: string }).id;
      ownedSaleIds.push(saleId);
      const paymentId = (withSession.body as { payments: { id: string }[] })
        .payments[0].id;
      ownedPaymentIds.push(paymentId);

      await closeSessionZeroDiff(sellerPathsCookie, '60.00');
    });

    it('3) conversión de cotización con pago inicial embebido (POST /sales/from-quote/:quoteId): sin caja -> 409, con caja -> 201', async () => {
      const customerId = await createCustomer(sellerPathsCookie);
      const productId = await createServiceProduct('70.00');

      const quoteResponse = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', sellerPathsCookie)
        .send({ customerId, items: [{ productId, quantity: '1' }] });
      expect(quoteResponse.status).toBe(201);
      const quoteId = (quoteResponse.body as { id: string }).id;
      ownedQuoteIds.push(quoteId);

      const withoutSession = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteId}`)
        .set('Cookie', sellerPathsCookie)
        .send({ payment: { method: 'CASH', amount: '70.00' } });
      expect(withoutSession.status).toBe(409);

      await openSessionOrThrow(sellerPathsCookie, '0');
      const withSession = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteId}`)
        .set('Cookie', sellerPathsCookie)
        .send({ payment: { method: 'CASH', amount: '70.00' } });
      expect(withSession.status).toBe(201);
      const saleId = (withSession.body as { id: string }).id;
      ownedSaleIds.push(saleId);
      const paymentId = (withSession.body as { payments: { id: string }[] })
        .payments[0].id;
      ownedPaymentIds.push(paymentId);

      await closeSessionZeroDiff(sellerPathsCookie, '70.00');
    });
  });

  // ====================================================================
  // §25 — Público general
  // ====================================================================
  describe('PUBLIC_GENERAL (§25 del plan aprobado)', () => {
    it('venta directa totalmente pagada a Público general: sin caja -> 409, con caja -> 201', async () => {
      const productId = await createServiceProduct('15.00');

      const withoutSession = await createSale(sellerPublicCookie, {
        customerId: genericCustomerId,
        items: [{ productId, quantity: '1' }],
        payment: { method: 'CASH', amount: '15.00' },
      });
      expect(withoutSession.status).toBe(409);

      await openSessionOrThrow(sellerPublicCookie, '0');
      const withSession = await createSale(sellerPublicCookie, {
        customerId: genericCustomerId,
        items: [{ productId, quantity: '1' }],
        payment: { method: 'CASH', amount: '15.00' },
      });
      expect(withSession.status).toBe(201);
      const body = withSession.body as {
        id: string;
        balanceDue: string;
        payments: { id: string }[];
      };
      expect(body.balanceDue).toBe('0.00');
      ownedSaleIds.push(body.id);
      ownedPaymentIds.push(body.payments[0].id);

      await closeSessionZeroDiff(sellerPublicCookie, '15.00');
    });
  });

  // ====================================================================
  // §21-23, §43 — Totales en vivo, pagos mixtos, método custom, cancelación
  // ====================================================================
  describe('Totales en vivo desde Payments vinculados naturalmente (§21-23, §43)', () => {
    it('opening 100 + CASH 200 (afecta caja) + CARD 300 (no afecta caja) -> collectionsTotal 500, cashCollectionsTotal 200, expected 300', async () => {
      await openSessionOrThrow(sellerLiveCookie, '100.00');
      const customerId = await createCustomer(sellerLiveCookie);
      const productCash = await createServiceProduct('200.00');
      const productCard = await createServiceProduct('300.00');

      const saleCash = await createSale(sellerLiveCookie, {
        customerId,
        items: [{ productId: productCash, quantity: '1' }],
      });
      expect(saleCash.status).toBe(201);
      const saleCashId = (saleCash.body as { id: string }).id;
      ownedSaleIds.push(saleCashId);
      const paymentCash = await registerPayment(sellerLiveCookie, saleCashId, {
        method: 'CASH',
        amount: '200.00',
      });
      expect(paymentCash.status).toBe(201);
      ownedPaymentIds.push(
        (paymentCash.body as { payment: { id: string } }).payment.id,
      );

      const saleCard = await createSale(sellerLiveCookie, {
        customerId,
        items: [{ productId: productCard, quantity: '1' }],
      });
      expect(saleCard.status).toBe(201);
      const saleCardId = (saleCard.body as { id: string }).id;
      ownedSaleIds.push(saleCardId);
      const paymentCard = await registerPayment(sellerLiveCookie, saleCardId, {
        method: 'CARD',
        amount: '300.00',
        // CARD (baseline, requiresReference=true) exige referencia.
        reference: 'OP-B4-CARD-1',
      });
      expect(paymentCard.status).toBe(201);
      ownedPaymentIds.push(
        (paymentCard.body as { payment: { id: string } }).payment.id,
      );

      const current = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerLiveCookie);
      expect(current.status).toBe(200);
      const body = current.body as {
        liveCollectionsTotal: string;
        liveCashCollectionsTotal: string;
        liveExpectedCashAmount: string;
      };
      expect(body.liveCollectionsTotal).toBe('500.00');
      expect(body.liveCashCollectionsTotal).toBe('200.00');
      expect(body.liveExpectedCashAmount).toBe('300.00');
    });

    it('un método dinámico custom (affectsCashDrawer=false) también se vincula automáticamente y cuenta en collectionsTotal, no en cashCollectionsTotal', async () => {
      const customMethodResponse = await request(app.getHttpServer())
        .post('/api/v1/payment-methods')
        .set('Cookie', adminCookie)
        .send({
          code: `WALLETB4${nextSuffix()}`,
          name: 'Billetera fixture B4',
          requiresReference: false,
          affectsCashDrawer: false,
          accountingDestination: PaymentMethodAccountingDestination.BANK,
        });
      expect(customMethodResponse.status).toBe(201);
      const customMethodCode = (customMethodResponse.body as { code: string })
        .code;
      const customMethodId = (customMethodResponse.body as { id: string }).id;
      ownedPaymentMethodIds.push(customMethodId);

      const customerId = await createCustomer(sellerLiveCookie);
      const productId = await createServiceProduct('90.00');
      const sale = await createSale(sellerLiveCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      const saleId = (sale.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const beforeCurrent = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerLiveCookie);
      const before = beforeCurrent.body as {
        liveCollectionsTotal: string;
        liveCashCollectionsTotal: string;
      };

      const payment = await registerPayment(sellerLiveCookie, saleId, {
        method: customMethodCode,
        amount: '90.00',
      });
      expect(payment.status).toBe(201);
      const paymentId = (payment.body as { payment: { id: string } }).payment
        .id;
      ownedPaymentIds.push(paymentId);

      const afterCurrent = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerLiveCookie);
      const after = afterCurrent.body as {
        liveCollectionsTotal: string;
        liveCashCollectionsTotal: string;
      };
      expect(
        new Prisma.Decimal(after.liveCollectionsTotal)
          .minus(before.liveCollectionsTotal)
          .toFixed(2),
      ).toBe('90.00');
      expect(after.liveCashCollectionsTotal).toBe(
        before.liveCashCollectionsTotal,
      );
    });

    it('cancelar un Payment CASH vinculado mientras la caja sigue OPEN reduce los totales en vivo (los totales solo cuentan ACTIVE)', async () => {
      const customerId = await createCustomer(sellerLiveCookie);
      const productId = await createServiceProduct('25.00');
      const sale = await createSale(sellerLiveCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      const saleId = (sale.body as { id: string }).id;
      ownedSaleIds.push(saleId);
      const payment = await registerPayment(sellerLiveCookie, saleId, {
        method: 'CASH',
        amount: '25.00',
      });
      expect(payment.status).toBe(201);
      const paymentId = (payment.body as { payment: { id: string } }).payment
        .id;
      ownedPaymentIds.push(paymentId);

      const beforeCancel = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerLiveCookie);
      const before = new Prisma.Decimal(
        (beforeCancel.body as { liveCashCollectionsTotal: string })
          .liveCashCollectionsTotal,
      );

      const cancelResponse = await request(app.getHttpServer())
        .post(`/api/v1/sales/${saleId}/payments/${paymentId}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Prueba B4: cancelación con caja OPEN' });
      expect(cancelResponse.status).toBe(200);

      const afterCancel = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerLiveCookie);
      const after = new Prisma.Decimal(
        (afterCancel.body as { liveCashCollectionsTotal: string })
          .liveCashCollectionsTotal,
      );
      expect(before.minus(after).toFixed(2)).toBe('25.00');

      // Cierra la caja (cuyo total ya no incluye el pago cancelado) para
      // dejar al actor resuelto.
      const finalCurrent = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerLiveCookie);
      const finalExpected = (
        finalCurrent.body as { liveExpectedCashAmount: string }
      ).liveExpectedCashAmount;
      await closeSessionZeroDiff(sellerLiveCookie, finalExpected);
    });
  });

  // ====================================================================
  // §33 — Concurrencia real Payment vs close (prueba central de Ticket B)
  // ====================================================================
  describe('Concurrencia real: Payment vs close (§33 del plan aprobado)', () => {
    it('Payment y close compiten por el MISMO lock de fila: nunca "Payment 2xx" + "close con expectedCashAmount que lo excluye"', async () => {
      await openSessionOrThrow(sellerRaceCookie, '0');
      const customerId = await createCustomer(sellerRaceCookie);
      const productId = await createServiceProduct('10.00');
      const sale = await createSale(sellerRaceCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      const saleId = (sale.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const [paymentResult, closeResult] = await Promise.allSettled([
        registerPayment(sellerRaceCookie, saleId, {
          method: 'CASH',
          amount: '10.00',
        }),
        closeSession(sellerRaceCookie, {
          countedCashAmount: '0.00',
          closingObservation: 'Revisión de concurrencia',
        }),
      ]);

      const paymentResponse =
        paymentResult.status === 'fulfilled' ? paymentResult.value : null;
      const closeResponse =
        closeResult.status === 'fulfilled' ? closeResult.value : null;
      expect(paymentResponse).not.toBeNull();
      expect(closeResponse).not.toBeNull();

      const paymentSucceeded = paymentResponse!.status === 201;
      if (paymentSucceeded) {
        ownedPaymentIds.push(
          (paymentResponse!.body as { payment: { id: string } }).payment.id,
        );
      }

      if (paymentSucceeded) {
        // El cobro ganó el lock primero: el cierre posterior DEBE reflejar
        // ese Payment, nunca expectedCashAmount=0 excluyéndolo. Puede
        // resultar en 200 (con snapshot que incluye el pago) o, si la
        // sesión ya no era la actual esperada por alguna otra razón, en un
        // error de estado — nunca en un snapshot que ignore el pago.
        if (closeResponse!.status === 200) {
          const body = closeResponse!.body as {
            expectedCashAmount: string;
            status: CashSessionStatus;
          };
          expect(body.expectedCashAmount).toBe('10.00');
          expect(body.status).toBe(CashSessionStatus.PENDING_APPROVAL);
        }
      } else {
        // El cierre ganó el lock primero: el pago posterior ve la caja ya
        // resuelta (CLOSED) -> 409.
        expect(paymentResponse!.status).toBe(409);
        expect(closeResponse!.status).toBe(200);
      }

      // Deja al actor en un estado terminal (CLOSED o PENDING_APPROVAL
      // resuelto) para no interferir con otra ejecución de esta suite.
      const current = await request(app.getHttpServer())
        .get('/api/v1/cash-sessions/current')
        .set('Cookie', sellerRaceCookie);
      if (current.status === 200) {
        const status = (
          current.body as { status: CashSessionStatus; id: string }
        ).status;
        const id = (current.body as { id: string }).id;
        if (status === CashSessionStatus.PENDING_APPROVAL) {
          const approveResponse = await request(app.getHttpServer())
            .post(`/api/v1/cash-sessions/${id}/approve`)
            .set('Cookie', adminCookie)
            .send({});
          expect(approveResponse.status).toBe(200);
        }
      }
    });
  });

  // ====================================================================
  // §34 — Dos Payments concurrentes bajo la MISMA sesión
  // ====================================================================
  describe('Dos Payments concurrentes bajo la misma sesión OPEN (§34 del plan aprobado)', () => {
    it('ambos se vinculan correctamente, ninguno queda con cashSessionId NULL', async () => {
      const session = await openSessionOrThrow(sellerTwoCookie, '0');
      const customerId = await createCustomer(sellerTwoCookie);
      const productA = await createServiceProduct('5.00');
      const productB = await createServiceProduct('7.00');

      const saleA = await createSale(sellerTwoCookie, {
        customerId,
        items: [{ productId: productA, quantity: '1' }],
      });
      const saleB = await createSale(sellerTwoCookie, {
        customerId,
        items: [{ productId: productB, quantity: '1' }],
      });
      expect(saleA.status).toBe(201);
      expect(saleB.status).toBe(201);
      const saleAId = (saleA.body as { id: string }).id;
      const saleBId = (saleB.body as { id: string }).id;
      ownedSaleIds.push(saleAId, saleBId);

      const [resultA, resultB] = await Promise.all([
        registerPayment(sellerTwoCookie, saleAId, {
          method: 'CASH',
          amount: '5.00',
        }),
        registerPayment(sellerTwoCookie, saleBId, {
          method: 'CASH',
          amount: '7.00',
        }),
      ]);
      expect(resultA.status).toBe(201);
      expect(resultB.status).toBe(201);
      const paymentAId = (resultA.body as { payment: { id: string } }).payment
        .id;
      const paymentBId = (resultB.body as { payment: { id: string } }).payment
        .id;
      ownedPaymentIds.push(paymentAId, paymentBId);

      const rows = await prisma.payment.findMany({
        where: { id: { in: [paymentAId, paymentBId] } },
      });
      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(row.cashSessionId).toBe(session.id);
      }

      await closeSessionZeroDiff(sellerTwoCookie, '12.00');
    });
  });
});
