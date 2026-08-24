import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  CustomerType,
  DocumentType,
  PaymentMethod,
  PaymentStatus,
  PrismaClient,
  QuoteStatus,
  RoleName,
  SaleStatus,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  businessToday,
  endOfBusinessDayExclusiveUtc,
  fromPrismaDate,
  startOfBusinessDayUtc,
} from '../src/common/date/business-date';
import { createE2eApp } from './helpers/e2e-app';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Fase 9, Bloque D — E2E final de los 5 reportes (Bloque B). Un solo ciclo
 * de aplicación (createE2eApp) y un solo PrismaClient de prueba
 * (createTestPrismaClient, exige pos_db_test). Hechos de negocio siempre
 * vía flujo HTTP real (Customers/Products/Quotes/Sales/Payments/
 * cancelaciones); Category/Unit vía Prisma directo (mismo criterio
 * universal ya usado en sales/quotes.e2e-spec.ts — no son "hechos de
 * negocio", son catálogo de andamiaje). Únicos ajustes directos en
 * pos_db_test: Sale.confirmedAt / Payment.paidAt / Quote.issueDate, cuando
 * el endpoint público no puede fijar esa fecha (§6 del kickoff) — nunca
 * monto/estado/origen.
 */
describe('Reports (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  const SELLER_USERNAME = 'e2e_seller_reports';
  const SELLER_PASSWORD = 'SellerReports123';
  const SELLER2_USERNAME = 'e2e_seller2_reports';
  const SELLER2_PASSWORD = 'Seller2Reports123';
  const MANAGEMENT_USERNAME = 'e2e_management_reports';
  const MANAGEMENT_PASSWORD = 'ManagementReports123';
  const WAREHOUSE_USERNAME = 'e2e_warehouse_reports';
  const WAREHOUSE_PASSWORD = 'WarehouseReports123';
  const TEST_GENERIC_CODE = 'PUBLIC_GENERAL';

  let adminCookie: string;
  let sellerCookie: string;
  let seller2Cookie: string;
  let managementCookie: string;
  let warehouseCookie: string;
  let seller1Id: string;
  let seller2Id: string;

  let categoryId: string;
  let categoryOtherId: string;
  let categoryTieId: string;
  let unitId: string;
  let genericCustomerId: string;
  // Fixture compartida "cliente que cambia de nombre" (R3 §22 vs. R8 §33 /
  // R9 §40): la cotización/venta+pago se crean y capturan su snapshot ANTES
  // de renombrar al cliente, para que R3 (join en vivo) muestre el nombre
  // NUEVO mientras R8/R9 (snapshot propio) sigan mostrando el ORIGINAL.
  // Se preparan en el describe de R3 (§22, donde ocurre el renombre) y se
  // consumen en los describe de R8/R9, que corren después en este archivo.
  let dimCustomerId: string;
  let dimQuoteId: string;
  let dimSaleId: string;
  let dimPaymentId: string;

  const ownedCategoryIds: string[] = [];
  const ownedUnitIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdSaleIds: string[] = [];
  const createdQuoteIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  function addDaysToDateOnly(dateOnly: string, delta: number): string {
    const [year, month, day] = dateOnly.split('-').map(Number);
    return fromPrismaDate(new Date(Date.UTC(year, month - 1, day + delta)));
  }
  const FAR_FUTURE_EXPIRATION = addDaysToDateOnly(businessToday(), 60);

  // Rango de reporte fijo, deliberadamente en el pasado y sin relación con
  // "hoy" para no colisionar con ningún default de otra suite.
  const PERIOD_FROM = '2025-03-10';
  const PERIOD_TO = '2025-03-20';
  const periodStart = startOfBusinessDayUtc(PERIOD_FROM);
  const periodEndExclusive = endOfBusinessDayExclusiveUtc(PERIOD_TO);
  const insideInstant = new Date(periodStart.getTime() + 6 * 60 * 60 * 1000);

  interface FixtureProduct {
    id: string;
    sku: string;
    name: string;
    salePrice: string;
    categoryId: string;
  }
  interface FixtureCustomer {
    id: string;
    name: string;
  }
  interface SafeSaleBody {
    id: string;
    number: string;
    status: SaleStatus;
    total: string;
    seller: {
      id: string;
      username: string;
      firstName: string;
      lastName: string;
    };
    payments: { id: string; status: PaymentStatus; amount: string }[];
  }
  interface SafeQuoteBody {
    id: string;
    number: string;
    status: QuoteStatus;
  }

  // ------------------------------------------------------------------
  // Helpers de fixture (flujo HTTP real)
  // ------------------------------------------------------------------

  async function createProductHttp(
    overrides: Record<string, unknown> = {},
  ): Promise<FixtureProduct> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: `E2EREP-${suffix}`,
        name: `Producto Reports E2E ${suffix}`,
        productType: 'PRODUCT',
        categoryId,
        unitId,
        salePrice: '19.90',
        isInventoryTracked: true,
        stockMinimum: '0',
        ...overrides,
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el producto fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as {
      id: string;
      sku: string;
      name: string;
      salePrice: string;
      categoryId: string;
    };
    createdProductIds.push(body.id);
    // Alta de saldo inicial para que el producto tenga stock vendible.
    await request(app.getHttpServer())
      .post('/api/v1/inventory/initial-balances')
      .set('Cookie', adminCookie)
      .send({
        productId: body.id,
        quantity: '1000.000',
        reason: 'Saldo inicial E2E Reports',
      });
    return body;
  }

  async function createCustomerHttp(
    overrides: Record<string, unknown> = {},
  ): Promise<FixtureCustomer> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Cookie', adminCookie)
      .send({
        customerType: CustomerType.PERSON,
        customerStage: 'CUSTOMER',
        name: `Cliente Reports E2E ${suffix}`,
        ...overrides,
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el cliente fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as { id: string; name: string };
    createdCustomerIds.push(body.id);
    return body;
  }

  async function createSaleHttp(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeSaleBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send(overrides);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la venta fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeSaleBody;
    createdSaleIds.push(body.id);
    return body;
  }

  async function createQuoteHttp(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeQuoteBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({ expirationDate: FAR_FUTURE_EXPIRATION, ...overrides });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la cotización fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeQuoteBody;
    createdQuoteIds.push(body.id);
    return body;
  }

  async function registerPaymentHttp(
    cookie: string,
    saleId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments`)
      .set('Cookie', cookie)
      .send(body);
  }

  /** POST /sales/:saleId/payments responde { payment, sale }, no un Payment plano. */
  function paymentIdOf(response: request.Response): string {
    return (response.body as { payment: { id: string } }).payment.id;
  }

  async function cancelPaymentHttp(
    saleId: string,
    paymentId: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/${paymentId}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Anulación fixture E2E Reports' });
  }

  async function cancelSaleHttp(saleId: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Anulación fixture E2E Reports' });
  }

  async function convertQuoteHttp(quoteId: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/from-quote/${quoteId}`)
      .set('Cookie', adminCookie)
      .send();
  }

  /** Único ajuste directo autorizado (§6): el endpoint público nunca fija confirmedAt. */
  async function setSaleConfirmedAt(saleId: string, date: Date): Promise<void> {
    await prisma.sale.update({
      where: { id: saleId },
      data: { confirmedAt: date },
    });
  }
  async function setPaymentPaidAt(
    paymentId: string,
    date: Date,
  ): Promise<void> {
    await prisma.payment.update({
      where: { id: paymentId },
      data: { paidAt: date },
    });
  }
  async function setQuoteIssueDate(quoteId: string, date: Date): Promise<void> {
    await prisma.quote.update({
      where: { id: quoteId },
      data: { issueDate: date },
    });
  }

  function get(
    path: string,
    cookie: string,
    query: Record<string, string> = {},
  ): request.Test {
    return request(app.getHttpServer())
      .get(path)
      .set('Cookie', cookie)
      .query(query);
  }

  function assertNoLeakage(response: { body: unknown }): void {
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/prisma/i);
    expect(serialized).not.toMatch(/at Object/);
    expect(serialized).not.toMatch(/P2\d{3}/);
    expect(serialized).not.toMatch(/23[05]\d\d/);
    expect(serialized).not.toMatch(/select .* from/i);
    expect(serialized).not.toMatch(/[a-zA-Z]:\\\\/);
  }

  // ==================================================================
  // Setup / teardown
  // ==================================================================
  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_reports@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER2_USERNAME,
      email: 'e2e_seller2_reports@demosystem.test',
      password: SELLER2_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_reports@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_reports@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
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
    seller2Cookie = (
      await login(app.getHttpServer(), SELLER2_USERNAME, SELLER2_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;

    const seller1User = await prisma.user.findUniqueOrThrow({
      where: { username: SELLER_USERNAME },
    });
    seller1Id = seller1User.id;
    const seller2User = await prisma.user.findUniqueOrThrow({
      where: { username: SELLER2_USERNAME },
    });
    seller2Id = seller2User.id;

    // Secuencias propias del spec (upsert defensivo, eliminadas en afterAll).
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

    const category = await prisma.category.upsert({
      where: { code: 'E2EREPCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EREPCAT', name: 'Categoria E2E Reports' },
    });
    categoryId = category.id;
    ownedCategoryIds.push(categoryId);

    const categoryOther = await prisma.category.upsert({
      where: { code: 'E2EREPCATO' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EREPCATO', name: 'Categoria E2E Reports Otra' },
    });
    categoryOtherId = categoryOther.id;
    ownedCategoryIds.push(categoryOtherId);

    const categoryTie = await prisma.category.upsert({
      where: { code: 'E2EREPCATT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EREPCATT', name: 'Categoria E2E Reports Empate' },
    });
    categoryTieId = categoryTie.id;
    ownedCategoryIds.push(categoryTieId);

    const unit = await prisma.unit.upsert({
      where: { code: 'E2EREPUNIT' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2EREPUNIT',
        name: 'Unidad E2E Reports',
        abbreviation: 'urp',
        allowDecimal: true,
      },
    });
    unitId = unit.id;
    ownedUnitIds.push(unitId);

    const generic = await prisma.customer.upsert({
      where: { code: TEST_GENERIC_CODE },
      update: {
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: 'CUSTOMER',
        status: 'ACTIVE',
        documentType: null,
        documentNumber: null,
      },
      create: {
        code: TEST_GENERIC_CODE,
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: 'CUSTOMER',
        status: 'ACTIVE',
        documentType: null,
        documentNumber: null,
      },
    });
    genericCustomerId = generic.id;
  }, 180000);

  afterAll(async () => {
    try {
      if (createdSaleIds.length > 0) {
        const ownedPayments = await prisma.payment.findMany({
          where: { saleId: { in: createdSaleIds } },
          select: { id: true },
        });
        const ownedPaymentIds = ownedPayments.map((p) => p.id);
        if (ownedPaymentIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: { entityType: 'Payment', entityId: { in: ownedPaymentIds } },
          });
        }
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: createdSaleIds } },
        });
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: createdSaleIds } },
        });

        const accountingWhere = {
          OR: [
            { sourceType: 'SALE' as const, sourceId: { in: createdSaleIds } },
            ...(ownedPaymentIds.length > 0
              ? [
                  {
                    sourceType: 'PAYMENT' as const,
                    sourceId: { in: ownedPaymentIds },
                  },
                ]
              : []),
          ],
        };
        await prisma.accountingEntry.deleteMany({
          where: { ...accountingWhere, eventType: 'REVERSAL' },
        });
        await prisma.accountingEntry.deleteMany({
          where: { ...accountingWhere, eventType: 'ORIGINAL' },
        });

        await prisma.payment.deleteMany({
          where: { saleId: { in: createdSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
      }

      if (createdQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: createdQuoteIds } },
        });
        await prisma.quote.deleteMany({
          where: { id: { in: createdQuoteIds } },
        });
      }

      await prisma.documentSequence.deleteMany({
        where: {
          documentType: { in: [DocumentType.SALE, DocumentType.QUOTE] },
        },
      });

      if (createdProductIds.length > 0) {
        await prisma.inventoryMovement.deleteMany({
          where: { productId: { in: createdProductIds } },
        });
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Product', entityId: { in: createdProductIds } },
        });
        await prisma.product.deleteMany({
          where: { id: { in: createdProductIds } },
        });
      }

      await prisma.unit.deleteMany({ where: { id: { in: ownedUnitIds } } });
      await prisma.category.deleteMany({
        where: { id: { in: ownedCategoryIds } },
      });

      if (createdCustomerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'Customer',
            entityId: { in: createdCustomerIds },
          },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: createdCustomerIds } },
        });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 60000);

  // ==================================================================
  // §7 — Auth matrix, las 5 rutas
  // ==================================================================
  describe('auth — 5 rutas de reportes', () => {
    const ROUTES = [
      '/api/v1/reports/sales-by-product',
      '/api/v1/reports/sales-by-customer',
      '/api/v1/reports/sales-by-seller',
      '/api/v1/reports/quotes-by-status',
      '/api/v1/reports/payments-by-method',
    ];

    it.each(ROUTES)('%s sin cookie -> 401', async (route) => {
      const response = await request(app.getHttpServer()).get(route);
      expect(response.status).toBe(401);
    });

    it.each(ROUTES)('%s ADMIN -> 200', async (route) => {
      const response = await get(route, adminCookie);
      expect(response.status).toBe(200);
    });

    it.each(ROUTES)('%s MANAGEMENT -> 200', async (route) => {
      const response = await get(route, managementCookie);
      expect(response.status).toBe(200);
    });

    it.each(ROUTES)('%s SELLER -> 200', async (route) => {
      const response = await get(route, sellerCookie);
      expect(response.status).toBe(200);
    });

    it.each(ROUTES)('%s WAREHOUSE -> 403, sin fuga interna', async (route) => {
      const response = await get(route, warehouseCookie);
      expect(response.status).toBe(403);
      assertNoLeakage(response);
    });
  });

  // ==================================================================
  // §9 — Validación de DTO compartida (representativa, no exhaustiva x5)
  // ==================================================================
  describe('validación de DTO — contrato compartido', () => {
    const ROUTE = '/api/v1/reports/sales-by-product';

    it('from/to válidos YYYY-MM-DD -> 200', async () => {
      const response = await get(ROUTE, adminCookie, {
        from: '2025-01-01',
        to: '2025-01-31',
      });
      expect(response.status).toBe(200);
    });

    it('from solo (sin to) -> 200 (rango de un solo lado permitido)', async () => {
      const response = await get(ROUTE, adminCookie, { from: '2025-01-01' });
      expect(response.status).toBe(200);
    });

    it('to solo (sin from) -> 200', async () => {
      const response = await get(ROUTE, adminCookie, { to: '2025-01-31' });
      expect(response.status).toBe(200);
    });

    it('fecha calendario imposible (2025-02-30) -> 400', async () => {
      const response = await get(ROUTE, adminCookie, { from: '2025-02-30' });
      expect(response.status).toBe(400);
      assertNoLeakage(response);
    });

    it('fecha con timestamp -> 400', async () => {
      const response = await get(ROUTE, adminCookie, {
        from: '2025-01-01T10:00:00Z',
      });
      expect(response.status).toBe(400);
    });

    it('from > to -> 400', async () => {
      const response = await get(ROUTE, adminCookie, {
        from: '2025-01-31',
        to: '2025-01-01',
      });
      expect(response.status).toBe(400);
    });

    it('page=0 -> 400', async () => {
      const response = await get(ROUTE, adminCookie, { page: '0' });
      expect(response.status).toBe(400);
    });

    it('limit=101 (más allá del máximo) -> 400', async () => {
      const response = await get(ROUTE, adminCookie, { limit: '101' });
      expect(response.status).toBe(400);
    });

    it('campo desconocido -> 400', async () => {
      const response = await get(ROUTE, adminCookie, { notAField: 'x' });
      expect(response.status).toBe(400);
    });

    it('productId inválido (no UUID) -> 400', async () => {
      const response = await get(ROUTE, adminCookie, {
        productId: 'not-a-uuid',
      });
      expect(response.status).toBe(400);
    });

    it('R3: customerType inválido -> 400', async () => {
      const response = await get(
        '/api/v1/reports/sales-by-customer',
        adminCookie,
        { customerType: 'NOT_A_TYPE' },
      );
      expect(response.status).toBe(400);
    });

    it('R8: status inválido -> 400', async () => {
      const response = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        { status: 'NOT_A_STATUS' },
      );
      expect(response.status).toBe(400);
    });

    it('R9: method inválido -> 400', async () => {
      const response = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        { method: 'NOT_A_METHOD' },
      );
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // §11 — Fronteras America/Lima (usa R3 por simplicidad: Sale-based)
  // ==================================================================
  describe('fronteras America/Lima', () => {
    it('justo antes excluido; inicio inclusive; dentro incluido; frontera exclusiva del día siguiente excluida', async () => {
      const boundaryCustomer = await createCustomerHttp();
      const justBefore = await createSaleHttp(adminCookie, {
        customerId: boundaryCustomer.id,
        items: [
          { productId: (await createProductHttp()).id, quantity: '1.000' },
        ],
      });
      await setSaleConfirmedAt(
        justBefore.id,
        new Date(periodStart.getTime() - 1),
      );

      const atStart = await createSaleHttp(adminCookie, {
        customerId: boundaryCustomer.id,
        items: [
          { productId: (await createProductHttp()).id, quantity: '1.000' },
        ],
      });
      await setSaleConfirmedAt(atStart.id, periodStart);

      const inside = await createSaleHttp(adminCookie, {
        customerId: boundaryCustomer.id,
        items: [
          { productId: (await createProductHttp()).id, quantity: '1.000' },
        ],
      });
      await setSaleConfirmedAt(inside.id, insideInstant);

      const justBeforeExclusiveEnd = await createSaleHttp(adminCookie, {
        customerId: boundaryCustomer.id,
        items: [
          { productId: (await createProductHttp()).id, quantity: '1.000' },
        ],
      });
      await setSaleConfirmedAt(
        justBeforeExclusiveEnd.id,
        new Date(periodEndExclusive.getTime() - 1),
      );

      const atExclusiveEnd = await createSaleHttp(adminCookie, {
        customerId: boundaryCustomer.id,
        items: [
          { productId: (await createProductHttp()).id, quantity: '1.000' },
        ],
      });
      await setSaleConfirmedAt(atExclusiveEnd.id, periodEndExclusive);

      const response = await get(
        '/api/v1/reports/sales-by-customer',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, customerId: boundaryCustomer.id },
      );
      expect(response.status).toBe(200);
      const rows = (response.body as { data: unknown }).data as {
        customerId: string;
        saleCount: number;
      }[];
      expect(rows).toHaveLength(1);
      // 3 ventas incluidas: atStart, inside, justBeforeExclusiveEnd.
      expect(rows[0].saleCount).toBe(3);
    });
  });

  // ==================================================================
  // R2 — sales-by-product (§12-17)
  // ==================================================================
  describe('R2 — sales-by-product', () => {
    interface R2Row {
      productId: string;
      sku: string;
      productName: string;
      categoryId: string;
      categoryName: string;
      quantitySold: string;
      totalSold: string;
    }

    it('agrupa por producto (ACTIVE only), campos exactos, cantidad fixed3, monto fixed2; ventas ANULADAS no contribuyen', async () => {
      const productA = await createProductHttp({ salePrice: '19.90' });
      const customer = await createCustomerHttp();

      const sale1 = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productA.id, quantity: '2.000' }],
      });
      await setSaleConfirmedAt(sale1.id, insideInstant);

      const sale2 = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productA.id, quantity: '3.000' }],
      });
      await setSaleConfirmedAt(sale2.id, insideInstant);

      const cancelled = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(cancelled.id, insideInstant);
      const cancelResponse = await cancelSaleHttp(cancelled.id);
      expect(cancelResponse.status).toBe(200);

      const response = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, productId: productA.id },
      );
      expect(response.status).toBe(200);
      const rows = (response.body as { data: unknown }).data as R2Row[];
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row).toEqual({
        productId: productA.id,
        sku: productA.sku,
        productName: productA.name,
        categoryId,
        categoryName: expect.any(String) as string,
        quantitySold: '5.000',
        totalSold: '99.50',
      });
    });

    it('dimensión ACTUAL de producto: cambiar el nombre no divide el grupo ni afecta las cantidades históricas', async () => {
      const productDim = await createProductHttp({ name: 'Dim Original' });
      const customer = await createCustomerHttp();
      const sale = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productDim.id, quantity: '4.000' }],
      });
      await setSaleConfirmedAt(sale.id, insideInstant);

      const patchResponse = await request(app.getHttpServer())
        .patch(`/api/v1/products/${productDim.id}`)
        .set('Cookie', adminCookie)
        .send({ name: 'Dim Actualizado' });
      expect(patchResponse.status).toBe(200);

      const response = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, productId: productDim.id },
      );
      const rows = (response.body as { data: unknown }).data as R2Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].productName).toBe('Dim Actualizado');
      expect(rows[0].quantitySold).toBe('4.000');
    });

    it('producto INACTIVE: el hecho histórico ACTIVE sigue apareciendo (el estado actual no filtra en silencio)', async () => {
      const productStatus = await createProductHttp();
      const customer = await createCustomerHttp();
      const sale = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productStatus.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(sale.id, insideInstant);

      const deactivateResponse = await request(app.getHttpServer())
        .post(`/api/v1/products/${productStatus.id}/deactivate`)
        .set('Cookie', adminCookie)
        .send();
      expect(deactivateResponse.status).toBe(200);

      const response = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, productId: productStatus.id },
      );
      const rows = (response.body as { data: unknown }).data as R2Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].quantitySold).toBe('1.000');
    });

    it('filtro categoryId usa Product.categoryId ACTUAL: excluye productos de otra categoría', async () => {
      const productMain = await createProductHttp({ categoryId });
      const productOther = await createProductHttp({
        categoryId: categoryOtherId,
      });
      const customer = await createCustomerHttp();
      const saleMain = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productMain.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleMain.id, insideInstant);
      const saleOther = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productOther.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleOther.id, insideInstant);

      const response = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, categoryId },
      );
      const rows = (response.body as { data: unknown }).data as R2Row[];
      expect(rows.some((r) => r.productId === productMain.id)).toBe(true);
      expect(rows.some((r) => r.productId === productOther.id)).toBe(false);
    });

    it('from/to fuera del rango de la venta: el grupo no aparece', async () => {
      const productOutside = await createProductHttp();
      const customer = await createCustomerHttp();
      const sale = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productOutside.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(sale.id, insideInstant);

      const response = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        { from: '2020-01-01', to: '2020-01-31', productId: productOutside.id },
      );
      expect((response.body as { data: unknown }).data).toEqual([]);
    });

    it('orden totalSold DESC con desempate productId ASC; total = conteo de GRUPOS (no de filas SaleItem); paginación', async () => {
      const tieA = await createProductHttp({
        categoryId: categoryTieId,
        salePrice: '10.00',
      });
      const tieB = await createProductHttp({
        categoryId: categoryTieId,
        salePrice: '10.00',
      });
      const customer = await createCustomerHttp();

      // tieA: dos ventas de 1.000 c/u (2 filas de SaleItem) -> total 20.00.
      const saleA1 = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: tieA.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleA1.id, insideInstant);
      const saleA2 = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: tieA.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleA2.id, insideInstant);

      // tieB: una venta de 2.000 (1 fila de SaleItem) -> total 20.00. Mismo total, menos filas.
      const saleB1 = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: tieB.id, quantity: '2.000' }],
      });
      await setSaleConfirmedAt(saleB1.id, insideInstant);

      const sortedIds = [tieA.id, tieB.id].sort();

      const fullPage = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, categoryId: categoryTieId },
      );
      const fullRows = (fullPage.body as { data: unknown }).data as R2Row[];
      expect(fullRows).toHaveLength(2);
      expect((fullPage.body as { total: number }).total).toBe(2); // 2 GRUPOS, no 3 filas de SaleItem.
      expect(fullRows.map((r) => r.productId)).toEqual(sortedIds);
      expect(fullRows.every((r) => r.totalSold === '20.00')).toBe(true);

      const page1 = await get('/api/v1/reports/sales-by-product', adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
        categoryId: categoryTieId,
        page: '1',
        limit: '1',
      });
      expect((page1.body as { data: unknown }).data).toHaveLength(1);
      expect(
        ((page1.body as { data: unknown }).data as R2Row[])[0].productId,
      ).toBe(sortedIds[0]);
      expect((page1.body as { total: number }).total).toBe(2);
      expect((page1.body as { totalPages: number }).totalPages).toBe(2);

      const page2 = await get('/api/v1/reports/sales-by-product', adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
        categoryId: categoryTieId,
        page: '2',
        limit: '1',
      });
      expect(
        ((page2.body as { data: unknown }).data as R2Row[])[0].productId,
      ).toBe(sortedIds[1]);
    });

    it('página más allá de los datos disponibles: 200 con data []', async () => {
      const response = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          categoryId: categoryTieId,
          page: '99',
        },
      );
      expect(response.status).toBe(200);
      expect((response.body as { data: unknown }).data).toEqual([]);
      expect((response.body as { page: number }).page).toBe(99);
    });

    it('rango sin datos elegibles: 200, data [], total 0, totalPages 0', async () => {
      const response = await get(
        '/api/v1/reports/sales-by-product',
        adminCookie,
        { from: '2019-01-01', to: '2019-01-02' },
      );
      expect(response.status).toBe(200);
      expect((response.body as { data: unknown }).data).toEqual([]);
      expect((response.body as { total: number }).total).toBe(0);
      expect((response.body as { totalPages: number }).totalPages).toBe(0);
    });
  });

  // ==================================================================
  // R3 — sales-by-customer (§18-23)
  // ==================================================================
  describe('R3 — sales-by-customer', () => {
    interface R3Row {
      customerId: string;
      customerName: string;
      customerDocumentNumber: string | null;
      customerType: CustomerType | null;
      saleCount: number;
      totalSold: string;
      totalPaid: string;
      balance: string;
    }

    it('un grupo por customerId; totales operacionales (paidAmount/balanceDue de Sale); ANULADAS no contribuyen', async () => {
      const productR3 = await createProductHttp({ salePrice: '50.00' });
      const customerA = await createCustomerHttp({
        customerType: CustomerType.PERSON,
      });
      const customerB = await createCustomerHttp({
        customerType: CustomerType.COMPANY,
      });

      const saleUnpaid = await createSaleHttp(adminCookie, {
        customerId: customerA.id,
        items: [{ productId: productR3.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleUnpaid.id, insideInstant);

      const salePartial = await createSaleHttp(adminCookie, {
        customerId: customerA.id,
        items: [{ productId: productR3.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(salePartial.id, insideInstant);
      const partialPayment = await registerPaymentHttp(
        adminCookie,
        salePartial.id,
        {
          method: 'CASH',
          amount: '20.00',
        },
      );
      expect(partialPayment.status).toBe(201);

      const salePaid = await createSaleHttp(adminCookie, {
        customerId: customerA.id,
        items: [{ productId: productR3.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(salePaid.id, insideInstant);
      const fullPayment = await registerPaymentHttp(adminCookie, salePaid.id, {
        method: 'CASH',
        amount: '50.00',
      });
      expect(fullPayment.status).toBe(201);

      const cancelled = await createSaleHttp(adminCookie, {
        customerId: customerA.id,
        items: [{ productId: productR3.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(cancelled.id, insideInstant);
      expect((await cancelSaleHttp(cancelled.id)).status).toBe(200);

      const saleB = await createSaleHttp(adminCookie, {
        customerId: customerB.id,
        items: [{ productId: productR3.id, quantity: '2.000' }],
      });
      await setSaleConfirmedAt(saleB.id, insideInstant);

      const responseA = await get(
        '/api/v1/reports/sales-by-customer',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, customerId: customerA.id },
      );
      const rowsA = (responseA.body as { data: unknown }).data as R3Row[];
      expect(rowsA).toHaveLength(1);
      expect(rowsA[0]).toEqual({
        customerId: customerA.id,
        customerName: customerA.name,
        customerDocumentNumber: null,
        customerType: CustomerType.PERSON,
        saleCount: 3,
        totalSold: '150.00',
        totalPaid: '70.00',
        balance: '80.00',
      });

      const responseB = await get(
        '/api/v1/reports/sales-by-customer',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          customerId: customerB.id,
          customerType: CustomerType.COMPANY,
        },
      );
      const rowsB = (responseB.body as { data: unknown }).data as R3Row[];
      expect(rowsB).toHaveLength(1);
      expect(rowsB[0].saleCount).toBe(1);
      expect(rowsB[0].totalSold).toBe('100.00');

      // Orden totalSold DESC: A (150.00) antes que B (100.00).
      const both = await get('/api/v1/reports/sales-by-customer', adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
        limit: '100',
      });
      const bothRows = (
        (both.body as { data: unknown }).data as R3Row[]
      ).filter(
        (r) => r.customerId === customerA.id || r.customerId === customerB.id,
      );
      expect(bothRows.map((r) => r.customerId)).toEqual([
        customerA.id,
        customerB.id,
      ]);
    });

    it('Público general: aparece como UN grupo normal, no excluido, no fabricado', async () => {
      const productPublic = await createProductHttp({ salePrice: '30.00' });
      const quickSale = await createSaleHttp(adminCookie, {
        customerId: genericCustomerId,
        items: [{ productId: productPublic.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '30.00' },
      });
      await setSaleConfirmedAt(quickSale.id, insideInstant);

      const response = await get(
        '/api/v1/reports/sales-by-customer',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, customerId: genericCustomerId },
      );
      const rows = (response.body as { data: unknown }).data as R3Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].customerId).toBe(genericCustomerId);
      expect(rows[0].customerName).toBe('Público general');
      expect(rows[0].totalPaid).toBe('30.00');
      expect(rows[0].balance).toBe('0.00');
    });

    it('dimensión ACTUAL de cliente: R3 usa el nombre vigente (no el snapshot histórico de la venta)', async () => {
      const productDim = await createProductHttp();
      const customerDim = await createCustomerHttp({
        name: 'Cliente Dim Original',
      });
      dimCustomerId = customerDim.id;

      // Cotización y venta+pago propias, creadas y snapshotadas ANTES del
      // renombre: R8 (§33) y R9 (§40) las consumen más abajo en este mismo
      // archivo para probar que su snapshot NO seve afectado por el
      // renombre siguiente.
      const dimQuote = await createQuoteHttp(adminCookie, {
        customerId: customerDim.id,
        items: [{ productId: productDim.id, quantity: '1.000' }],
      });
      dimQuoteId = dimQuote.id;
      await setQuoteIssueDate(
        dimQuote.id,
        new Date(`${PERIOD_FROM}T00:00:00.000Z`),
      );

      const dimSale = await createSaleHttp(adminCookie, {
        customerId: customerDim.id,
        items: [{ productId: productDim.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: productDim.salePrice },
      });
      dimSaleId = dimSale.id;
      await setSaleConfirmedAt(dimSale.id, insideInstant);
      dimPaymentId = dimSale.payments[0].id;
      await setPaymentPaidAt(dimPaymentId, insideInstant);

      // Venta adicional para que R3 tenga un hecho agregable (da igual si
      // es antes o después del renombre: R3 hace join en vivo).
      const extraSale = await createSaleHttp(adminCookie, {
        customerId: customerDim.id,
        items: [{ productId: productDim.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(extraSale.id, insideInstant);

      const patchResponse = await request(app.getHttpServer())
        .patch(`/api/v1/customers/${customerDim.id}`)
        .set('Cookie', adminCookie)
        .send({ name: 'Cliente Dim Renombrado' });
      expect(patchResponse.status).toBe(200);

      const response = await get(
        '/api/v1/reports/sales-by-customer',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, customerId: customerDim.id },
      );
      const rows = (response.body as { data: unknown }).data as R3Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].customerName).toBe('Cliente Dim Renombrado');
      expect(rows[0].saleCount).toBe(2);
    });

    it('rango sin datos elegibles: 200, data [], total 0', async () => {
      const response = await get(
        '/api/v1/reports/sales-by-customer',
        adminCookie,
        { from: '2019-01-01', to: '2019-01-02' },
      );
      expect(response.status).toBe(200);
      expect((response.body as { data: unknown }).data).toEqual([]);
      expect((response.body as { total: number }).total).toBe(0);
    });
  });

  // ==================================================================
  // R4 — sales-by-seller (§24-31) — CRÍTICO: §25 totalCollected
  // ==================================================================
  describe('R4 — sales-by-seller', () => {
    interface R4Row {
      seller: {
        id: string;
        username: string;
        firstName: string;
        lastName: string;
      };
      saleCount: number;
      totalSold: string;
      totalCollected: string;
      convertedQuotes: number;
    }

    const outsideInstant = new Date(
      periodStart.getTime() - 10 * 24 * 60 * 60 * 1000,
    );
    const outsidePaidInstant = new Date(
      periodEndExclusive.getTime() + 10 * 24 * 60 * 60 * 1000,
    );

    it('cohorte por Sale.confirmedAt; totalCollected NUNCA filtra por Payment.paidAt; pago/venta anulados se excluyen correctamente', async () => {
      const productR4 = await createProductHttp({ salePrice: '40.00' });
      const customer = await createCustomerHttp();

      // A: dentro del período; su pago ACTIVE tiene paidAt FUERA del rango
      // -> DEBE contar igual (prueba crítica §25: no se filtra por paidAt).
      const saleA = await createSaleHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR4.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleA.id, insideInstant);
      const paymentA = await registerPaymentHttp(adminCookie, saleA.id, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(paymentA.status).toBe(201);
      await setPaymentPaidAt(paymentIdOf(paymentA), outsidePaidInstant);

      // B: FUERA del período (cohorte definida por confirmedAt); su pago
      // tiene paidAt DENTRO del rango, pero ni la venta ni el pago cuentan.
      const saleB = await createSaleHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR4.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleB.id, outsideInstant);
      const paymentB = await registerPaymentHttp(adminCookie, saleB.id, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(paymentB.status).toBe(201);
      await setPaymentPaidAt(paymentIdOf(paymentB), insideInstant);

      // C: dentro del período; su pago se ANULA -> no contribuye a
      // totalCollected, pero la venta ACTIVE sigue en saleCount/totalSold.
      const saleC = await createSaleHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR4.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleC.id, insideInstant);
      const paymentC = await registerPaymentHttp(adminCookie, saleC.id, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(paymentC.status).toBe(201);
      const cancelPaymentCResponse = await cancelPaymentHttp(
        saleC.id,
        paymentIdOf(paymentC),
      );
      expect(cancelPaymentCResponse.status).toBe(200);

      // D: dentro del período; la VENTA se anula -> excluida del cohorte
      // por completo (ni saleCount ni totalCollected la reflejan; su pago
      // no se cuenta dos veces).
      const saleD = await createSaleHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR4.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleD.id, insideInstant);
      const paymentD = await registerPaymentHttp(adminCookie, saleD.id, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(paymentD.status).toBe(201);
      const cancelSaleDResponse = await cancelSaleHttp(saleD.id);
      expect(cancelSaleDResponse.status).toBe(200);

      const response = await get(
        '/api/v1/reports/sales-by-seller',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, sellerId: seller1Id },
      );
      expect(response.status).toBe(200);
      const rows = (response.body as { data: unknown }).data as R4Row[];
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.saleCount).toBe(2); // A y C únicamente.
      expect(row.totalSold).toBe('80.00'); // A + C.
      expect(row.totalCollected).toBe('40.00'); // solo A (paidAt fuera del rango, igual cuenta).
      expect(row.seller).toEqual({
        id: seller1Id,
        username: SELLER_USERNAME,
        firstName: expect.any(String) as string,
        lastName: expect.any(String) as string,
      });
      expect(Object.keys(row.seller).sort()).toEqual(
        ['id', 'username', 'firstName', 'lastName'].sort(),
      );
    });

    it('convertedQuotes: solo CONVERTED con issueDate en el MISMO rango y sellerId del vendedor; venta con 0 cobros -> "0.00"', async () => {
      const productR4b = await createProductHttp({ salePrice: '15.00' });
      const customer = await createCustomerHttp();

      const saleS2A = await createSaleHttp(seller2Cookie, {
        customerId: customer.id,
        items: [{ productId: productR4b.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleS2A.id, insideInstant);

      const quoteConvertedInside = await createQuoteHttp(seller2Cookie, {
        customerId: customer.id,
        items: [{ productId: productR4b.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quoteConvertedInside.id,
        new Date(`${PERIOD_FROM}T00:00:00.000Z`),
      );
      const convertResponse = await convertQuoteHttp(quoteConvertedInside.id);
      expect(convertResponse.status).toBe(201);
      const convertedSaleId = (convertResponse.body as { id: string }).id;
      createdSaleIds.push(convertedSaleId);
      // Se aleja del período para no interferir con saleCount/totalSold de
      // este vendedor: solo interesa su efecto sobre convertedQuotes.
      await setSaleConfirmedAt(convertedSaleId, outsideInstant);

      const quoteNotConverted = await createQuoteHttp(seller2Cookie, {
        customerId: customer.id,
        items: [{ productId: productR4b.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quoteNotConverted.id,
        new Date(`${PERIOD_FROM}T00:00:00.000Z`),
      );

      const quoteConvertedOutside = await createQuoteHttp(seller2Cookie, {
        customerId: customer.id,
        items: [{ productId: productR4b.id, quantity: '1.000' }],
      });
      const convertOutsideResponse = await convertQuoteHttp(
        quoteConvertedOutside.id,
      );
      expect(convertOutsideResponse.status).toBe(201);
      const convertedOutsideSaleId = (
        convertOutsideResponse.body as { id: string }
      ).id;
      createdSaleIds.push(convertedOutsideSaleId);
      await setSaleConfirmedAt(convertedOutsideSaleId, outsideInstant);
      await setQuoteIssueDate(quoteConvertedOutside.id, outsideInstant);

      const response = await get(
        '/api/v1/reports/sales-by-seller',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, sellerId: seller2Id },
      );
      const rows = (response.body as { data: unknown }).data as R4Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].saleCount).toBe(1);
      expect(rows[0].totalCollected).toBe('0.00');
      expect(rows[0].convertedQuotes).toBe(1);
    });

    it('orden totalSold DESC entre vendedores distintos', async () => {
      const response = await get(
        '/api/v1/reports/sales-by-seller',
        adminCookie,
        { from: PERIOD_FROM, to: PERIOD_TO, limit: '100' },
      );
      const rows = (response.body as { data: unknown }).data as R4Row[];
      const indexSeller1 = rows.findIndex((r) => r.seller.id === seller1Id);
      const indexSeller2 = rows.findIndex((r) => r.seller.id === seller2Id);
      expect(indexSeller1).toBeGreaterThanOrEqual(0);
      expect(indexSeller2).toBeGreaterThanOrEqual(0);
      // seller1 (80.00) > seller2 (15.00): debe listarse primero.
      expect(indexSeller1).toBeLessThan(indexSeller2);
      const totals = rows.map((r) => Number(r.totalSold));
      const sorted = [...totals].sort((a, b) => b - a);
      expect(totals).toEqual(sorted);
    });
  });

  // ==================================================================
  // R8 — quotes-by-status (§32-36)
  // ==================================================================
  describe('R8 — quotes-by-status', () => {
    interface R8Row {
      quoteId: string;
      quoteNumber: string;
      customerName: string;
      total: string;
      status: QuoteStatus;
      resultingSale: { saleId: string; saleNumber: string } | null;
    }

    it('todos los estados persistidos son navegables; filtros status/sellerId/customerId/from/to; orden issueDate DESC, id DESC', async () => {
      const productR8 = await createProductHttp({ salePrice: '25.00' });
      const customer = await createCustomerHttp();

      const quotePending = await createQuoteHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR8.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quotePending.id,
        new Date(`${PERIOD_FROM}T00:00:00.000Z`),
      );

      const quoteAccepted = await createQuoteHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR8.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quoteAccepted.id,
        new Date(`${addDaysToDateOnly(PERIOD_FROM, 1)}T00:00:00.000Z`),
      );
      const acceptResponse = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${quoteAccepted.id}/accept`)
        .set('Cookie', adminCookie)
        .send();
      expect(acceptResponse.status).toBe(200);

      const quoteRejected = await createQuoteHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR8.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quoteRejected.id,
        new Date(`${addDaysToDateOnly(PERIOD_FROM, 2)}T00:00:00.000Z`),
      );
      const rejectResponse = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${quoteRejected.id}/reject`)
        .set('Cookie', adminCookie)
        .send();
      expect(rejectResponse.status).toBe(200);

      const quoteConverted = await createQuoteHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR8.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quoteConverted.id,
        new Date(`${addDaysToDateOnly(PERIOD_FROM, 3)}T00:00:00.000Z`),
      );
      const convertResponse = await convertQuoteHttp(quoteConverted.id);
      expect(convertResponse.status).toBe(201);
      const resultingSale = convertResponse.body as {
        id: string;
        number: string;
      };
      createdSaleIds.push(resultingSale.id);

      // status
      const pendingOnly = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          customerId: customer.id,
          status: QuoteStatus.PENDING,
        },
      );
      expect(
        (pendingOnly.body as { data: unknown }).data as R8Row[],
      ).toHaveLength(1);
      expect(
        ((pendingOnly.body as { data: unknown }).data as R8Row[])[0].quoteId,
      ).toBe(quotePending.id);
      expect(
        ((pendingOnly.body as { data: unknown }).data as R8Row[])[0]
          .resultingSale,
      ).toBeNull();

      // sellerId
      const bySeller = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          customerId: customer.id,
          sellerId: seller1Id,
        },
      );
      expect(
        ((bySeller.body as { data: unknown }).data as R8Row[]).length,
      ).toBe(4);

      // resultingSale presente y coincide exactamente con la venta generada.
      const convertedOnly = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          customerId: customer.id,
          status: QuoteStatus.CONVERTED,
        },
      );
      const convertedRows = (convertedOnly.body as { data: unknown })
        .data as R8Row[];
      expect(convertedRows).toHaveLength(1);
      expect(convertedRows[0].resultingSale).toEqual({
        saleId: resultingSale.id,
        saleNumber: resultingSale.number,
      });

      // Cancelar la venta resultante: el reporte debe SEGUIR mostrando la
      // referencia histórica (§36) — Quote es la fuente de verdad histórica.
      const cancelResultingSaleResponse = await cancelSaleHttp(
        resultingSale.id,
      );
      expect(cancelResultingSaleResponse.status).toBe(200);
      const afterCancel = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          customerId: customer.id,
          status: QuoteStatus.CONVERTED,
        },
      );
      expect(
        ((afterCancel.body as { data: unknown }).data as R8Row[])[0]
          .resultingSale,
      ).toEqual({
        saleId: resultingSale.id,
        saleNumber: resultingSale.number,
      });

      // Orden issueDate DESC, id DESC: converted(día+3) > rejected(+2) >
      // accepted(+1) > pending(+0).
      const allFour = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          customerId: customer.id,
        },
      );
      expect(
        ((allFour.body as { data: unknown }).data as R8Row[]).map(
          (r) => r.quoteId,
        ),
      ).toEqual([
        quoteConverted.id,
        quoteRejected.id,
        quoteAccepted.id,
        quotePending.id,
      ]);
      expect((allFour.body as { total: number }).total).toBe(4); // total = conteo de FILAS, no agregado.
    });

    it('snapshot: R8 muestra el customerName histórico de la cotización, no el nombre actual (renombrado en R3 §22)', async () => {
      const response = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          customerId: dimCustomerId,
        },
      );
      const rows = (response.body as { data: unknown }).data as R8Row[];
      expect(rows).toHaveLength(1);
      expect(rows[0].quoteId).toBe(dimQuoteId);
      expect(rows[0].customerName).toBe('Cliente Dim Original');
    });

    it('rango sin datos elegibles: 200, data [], total 0', async () => {
      const response = await get(
        '/api/v1/reports/quotes-by-status',
        adminCookie,
        {
          from: '2019-01-01',
          to: '2019-01-02',
        },
      );
      expect(response.status).toBe(200);
      expect((response.body as { data: unknown }).data).toEqual([]);
      expect((response.body as { total: number }).total).toBe(0);
    });

    // ========================================================================
    // Fase 9, remediación EXPIRED — consistencia de las 3 superficies (§17-19)
    // ========================================================================
    describe('estado EFECTIVO EXPIRED — consistencia GET /quotes vs R8 vs Dashboard', () => {
      it('una cotización PENDING vencida se muestra como EXPIRED en las 3 superficies, sin doble conteo en su bucket crudo original', async () => {
        // Línea base del Dashboard ANTES de que exista la cotización
        // (sección global, no filtrable por customerId): las aserciones
        // finales comparan por delta contra esta captura, sin depender de
        // residuos de otras pruebas.
        const dashBefore = await get('/api/v1/dashboard', adminCookie, {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        });

        const productExpired = await createProductHttp();
        const customerExpired = await createCustomerHttp();

        // Creada por flujo HTTP real; issueDate se fuerza DENTRO del
        // período del reporte (§6/§17: la API pública no puede fijar
        // issueDate ni expirationDate ya vencida directamente). El propio
        // PERIOD_FROM/PERIOD_TO (2025-03-10..20) ya está muy en el pasado
        // respecto de la fecha de negocio America/Lima REAL de hoy, así
        // que fijar expirationDate en ese mismo rango histórico basta para
        // que la cotización quede efectivamente vencida "hoy" sin
        // necesidad de calcular la fecha real de ejecución. NUNCA se fija
        // status=EXPIRED directamente: ese valor no se persiste jamás.
        const overdueQuote = await createQuoteHttp(sellerCookie, {
          customerId: customerExpired.id,
          items: [{ productId: productExpired.id, quantity: '1.000' }],
        });
        await setQuoteIssueDate(
          overdueQuote.id,
          new Date(`${PERIOD_FROM}T00:00:00.000Z`),
        );
        await prisma.quote.update({
          where: { id: overdueQuote.id },
          data: { expirationDate: new Date(`${PERIOD_FROM}T00:00:00.000Z`) },
        });

        // 1) GET /quotes/:id — superficie canónica: EXPIRED.
        const quoteDetail = await get(
          `/api/v1/quotes/${overdueQuote.id}`,
          adminCookie,
        );
        expect(quoteDetail.status).toBe(200);
        expect((quoteDetail.body as { status: string }).status).toBe('EXPIRED');

        // 2) R8 — status=EXPIRED debe incluirla, con status EXPIRED en la fila.
        const r8Expired = await get(
          '/api/v1/reports/quotes-by-status',
          adminCookie,
          {
            from: PERIOD_FROM,
            to: PERIOD_TO,
            status: 'EXPIRED',
            customerId: customerExpired.id,
          },
        );
        const expiredRows = (r8Expired.body as { data: R8Row[] }).data;
        expect(expiredRows).toHaveLength(1);
        expect(expiredRows[0].quoteId).toBe(overdueQuote.id);
        expect(expiredRows[0].status).toBe('EXPIRED');

        // Filtro inverso (§18): status=PENDING (su estado crudo almacenado)
        // ya NO debe devolverla — coincide con la semántica canónica de
        // GET /quotes, que también la excluiría de ese mismo filtro.
        const r8Pending = await get(
          '/api/v1/reports/quotes-by-status',
          adminCookie,
          {
            from: PERIOD_FROM,
            to: PERIOD_TO,
            status: 'PENDING',
            customerId: customerExpired.id,
          },
        );
        const pendingRows = (r8Pending.body as { data: R8Row[] }).data;
        expect(pendingRows.some((r) => r.quoteId === overdueQuote.id)).toBe(
          false,
        );

        // Sin filtro de status: la fila sigue apareciendo, con status EXPIRED.
        const r8Unfiltered = await get(
          '/api/v1/reports/quotes-by-status',
          adminCookie,
          { from: PERIOD_FROM, to: PERIOD_TO, customerId: customerExpired.id },
        );
        const unfilteredRows = (r8Unfiltered.body as { data: R8Row[] }).data;
        expect(unfilteredRows).toHaveLength(1);
        expect(unfilteredRows[0].status).toBe('EXPIRED');

        // 3) Dashboard — el bucket EXPIRED sube en 1 respecto de la línea
        // base, el bucket PENDING (su estado crudo) NO sube: sin doble
        // conteo entre el bucket crudo original y el efectivo.
        const dashAfter = await get('/api/v1/dashboard', adminCookie, {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        });
        type DashBody = {
          quotes: { byStatus: { status: string; count: number }[] };
        };
        const beforeExpiredCount = (
          dashBefore.body as DashBody
        ).quotes.byStatus.find((r) => r.status === 'EXPIRED')!.count;
        const beforePendingCount = (
          dashBefore.body as DashBody
        ).quotes.byStatus.find((r) => r.status === 'PENDING')!.count;
        const afterExpiredCount = (
          dashAfter.body as DashBody
        ).quotes.byStatus.find((r) => r.status === 'EXPIRED')!.count;
        const afterPendingCount = (
          dashAfter.body as DashBody
        ).quotes.byStatus.find((r) => r.status === 'PENDING')!.count;
        expect(afterExpiredCount).toBe(beforeExpiredCount + 1);
        expect(afterPendingCount).toBe(beforePendingCount);
      });
    });
  });

  // ==================================================================
  // R9 — payments-by-method (§37-43)
  // ==================================================================
  describe('R9 — payments-by-method', () => {
    interface R9Row {
      paidAt: string;
      paymentId: string;
      saleId: string;
      saleNumber: string;
      customerName: string;
      method: PaymentMethod;
      reference: string | null;
      amount: string;
      status: PaymentStatus;
      createdBy: {
        id: string;
        username: string;
        firstName: string;
        lastName: string;
      };
    }

    it('tabular (una fila por Payment); ACTIVE y CANCELLED visibles sin filtro; filtro de status funciona; createdBy != Sale.seller', async () => {
      const productR9 = await createProductHttp({ salePrice: '60.00' });
      const customer = await createCustomerHttp();

      // Venta vendida por seller1, pago registrado por ADMIN (actor
      // distinto del vendedor) -> createdBy debe ser ADMIN, no seller1.
      const saleActive = await createSaleHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR9.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleActive.id, insideInstant);
      const paymentActiveResponse = await registerPaymentHttp(
        adminCookie,
        saleActive.id,
        {
          method: 'CASH',
          amount: '60.00',
        },
      );
      expect(paymentActiveResponse.status).toBe(201);
      const paymentActiveId = paymentIdOf(paymentActiveResponse);
      await setPaymentPaidAt(paymentActiveId, insideInstant);

      // Segunda venta, pago registrado por SELLER (createdBy = seller1),
      // luego anulado -> debe seguir siendo consultable como CANCELLED.
      const saleForCancel = await createSaleHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: productR9.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleForCancel.id, insideInstant);
      const paymentCancelResponse = await registerPaymentHttp(
        sellerCookie,
        saleForCancel.id,
        {
          method: 'CASH',
          amount: '60.00',
        },
      );
      expect(paymentCancelResponse.status).toBe(201);
      const paymentCancelId = paymentIdOf(paymentCancelResponse);
      await setPaymentPaidAt(paymentCancelId, insideInstant);
      const cancelResponse = await cancelPaymentHttp(
        saleForCancel.id,
        paymentCancelId,
      );
      expect(cancelResponse.status).toBe(200);

      const noFilter = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          method: PaymentMethod.CASH,
        },
      );
      const noFilterRows = (
        (noFilter.body as { data: unknown }).data as R9Row[]
      ).filter(
        (r) =>
          r.paymentId === paymentActiveId || r.paymentId === paymentCancelId,
      );
      expect(noFilterRows).toHaveLength(2); // sin filtro de status: ambos visibles.

      const activeOnly = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          status: PaymentStatus.ACTIVE,
        },
      );
      const activeIds = (
        (activeOnly.body as { data: unknown }).data as R9Row[]
      ).map((r) => r.paymentId);
      expect(activeIds).toContain(paymentActiveId);
      expect(activeIds).not.toContain(paymentCancelId);

      const cancelledOnly = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          status: PaymentStatus.CANCELLED,
        },
      );
      const cancelledIds = (
        (cancelledOnly.body as { data: unknown }).data as R9Row[]
      ).map((r) => r.paymentId);
      expect(cancelledIds).toContain(paymentCancelId);
      expect(cancelledIds).not.toContain(paymentActiveId);

      // createdByUserId: paymentActiveId lo registró ADMIN; paymentCancelId, seller1.
      const byAdmin = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        },
      );
      const activeRow = (
        (byAdmin.body as { data: unknown }).data as R9Row[]
      ).find((r) => r.paymentId === paymentActiveId);
      expect(activeRow?.createdBy.username).not.toBe(SELLER_USERNAME);
      const bySellerCreator = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          createdByUserId: seller1Id,
        },
      );
      const sellerCreatedIds = (
        (bySellerCreator.body as { data: unknown }).data as R9Row[]
      ).map((r) => r.paymentId);
      expect(sellerCreatedIds).toContain(paymentCancelId);
      expect(sellerCreatedIds).not.toContain(paymentActiveId);
      expect(
        Object.keys(
          ((byAdmin.body as { data: unknown }).data as R9Row[])[0].createdBy,
        ).sort(),
      ).toEqual(['id', 'username', 'firstName', 'lastName'].sort());
    });

    it('reference: string preservada (BANK_TRANSFER) y null preservado (CASH)', async () => {
      const productR9b = await createProductHttp({ salePrice: '30.00' });
      const customer = await createCustomerHttp();

      const saleWithRef = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productR9b.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleWithRef.id, insideInstant);
      const refPayment = await registerPaymentHttp(
        adminCookie,
        saleWithRef.id,
        {
          method: 'BANK_TRANSFER',
          amount: '30.00',
          reference: 'OP-E2E-REF-123',
        },
      );
      expect(refPayment.status).toBe(201);
      await setPaymentPaidAt(paymentIdOf(refPayment), insideInstant);

      const saleNoRef = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: productR9b.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleNoRef.id, insideInstant);
      const noRefPayment = await registerPaymentHttp(
        adminCookie,
        saleNoRef.id,
        {
          method: 'CASH',
          amount: '30.00',
        },
      );
      expect(noRefPayment.status).toBe(201);
      await setPaymentPaidAt(paymentIdOf(noRefPayment), insideInstant);

      const response = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        },
      );
      const rows = (response.body as { data: unknown }).data as R9Row[];
      const refRow = rows.find((r) => r.paymentId === paymentIdOf(refPayment));
      const noRefRow = rows.find(
        (r) => r.paymentId === paymentIdOf(noRefPayment),
      );
      expect(refRow?.reference).toBe('OP-E2E-REF-123');
      expect(noRefRow?.reference).toBeNull();
    });

    it('snapshot: R9 muestra Sale.customerName histórico, no el nombre actual (renombrado en R3 §22)', async () => {
      const response = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        },
      );
      const rows = (response.body as { data: unknown }).data as R9Row[];
      const dimRow = rows.find((r) => r.paymentId === dimPaymentId);
      expect(dimRow).toBeDefined();
      expect(dimRow?.saleId).toBe(dimSaleId);
      expect(dimRow?.customerName).toBe('Cliente Dim Original');
    });

    it('orden paidAt DESC, id DESC; total = conteo de filas de Payment (sin agregación)', async () => {
      const response = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: PERIOD_FROM,
          to: PERIOD_TO,
          limit: '100',
        },
      );
      const rows = (response.body as { data: unknown }).data as R9Row[];
      const paidAts = rows.map((r) => new Date(r.paidAt).getTime());
      const sorted = [...paidAts].sort((a, b) => b - a);
      expect(paidAts).toEqual(sorted);
      expect(typeof (response.body as { total: number }).total).toBe('number');
      expect((response.body as { total: number }).total).toBeGreaterThanOrEqual(
        rows.length,
      );
    });

    it('rango sin datos elegibles: 200, data [], total 0', async () => {
      const response = await get(
        '/api/v1/reports/payments-by-method',
        adminCookie,
        {
          from: '2019-01-01',
          to: '2019-01-02',
        },
      );
      expect(response.status).toBe(200);
      expect((response.body as { data: unknown }).data).toEqual([]);
      expect((response.body as { total: number }).total).toBe(0);
    });
  });

  // ==================================================================
  // §44-45 — Rutas reutilizadas: 404 para nombres inexistentes, 200 para
  // las superficies reales de R1/R5/R6/R7/R10.
  // ==================================================================
  describe('reused-report routes — no duplicados; superficies reutilizadas disponibles', () => {
    const NONEXISTENT_ROUTES = [
      '/api/v1/reports/sales-by-date',
      '/api/v1/reports/low-stock',
      '/api/v1/reports/current-inventory',
      '/api/v1/reports/inventory-movements',
      '/api/v1/reports/accounts-receivable',
    ];

    it.each(NONEXISTENT_ROUTES)('%s -> 404 (no existe)', async (route) => {
      const response = await get(route, adminCookie);
      expect(response.status).toBe(404);
    });

    it('R1 GET /sales, R5 GET /inventory/low-stock, R6 GET /products, R7 GET /inventory/movements, R10 GET /accounts-receivable siguen disponibles', async () => {
      const routes = [
        '/api/v1/sales',
        '/api/v1/inventory/low-stock',
        '/api/v1/products',
        '/api/v1/inventory/movements',
        '/api/v1/accounts-receivable',
      ];
      for (const route of routes) {
        const response = await get(route, adminCookie);
        expect(response.status).toBe(200);
      }
    });
  });

  // ==================================================================
  // §65/§68/§69 — sin mutación, sin versión sin prefijo, sin fuga de error
  // ==================================================================
  describe('superficie final — sin mutación, versionado, seguridad de error', () => {
    it('POST/PUT/PATCH/DELETE a /reports/* -> 404 (no existe endpoint de mutación)', async () => {
      const targets = [
        '/api/v1/reports/sales-by-product',
        '/api/v1/reports/sales-by-customer',
        '/api/v1/reports/sales-by-seller',
        '/api/v1/reports/quotes-by-status',
        '/api/v1/reports/payments-by-method',
      ];
      for (const target of targets) {
        for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
          const response = await request(app.getHttpServer())
            [verb](target)
            .set('Cookie', adminCookie)
            .send({});
          expect(response.status).toBe(404);
        }
      }
    });

    it('/api/reports/... sin versión -> 404', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/reports/sales-by-product')
        .set('Cookie', adminCookie);
      expect(response.status).toBe(404);
    });

    it('errores controlados (UUID/enum/fecha inválidos) sin fuga interna', async () => {
      const responses = await Promise.all([
        get('/api/v1/reports/sales-by-product', adminCookie, {
          productId: 'not-a-uuid',
        }),
        get('/api/v1/reports/quotes-by-status', adminCookie, {
          status: 'NOT_A_STATUS',
        }),
        get('/api/v1/reports/sales-by-product', adminCookie, {
          from: '2025-02-30',
        }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(400);
        assertNoLeakage(response);
      }
    });
  });

  // ==================================================================
  // §61/§62/§63/§73 — sin auditoría de lectura, invariante read-only,
  // aislamiento contable, lecturas concurrentes
  // ==================================================================
  describe('lecturas de solo lectura: sin auditoría, sin mutación, aislamiento contable', () => {
    it('varias lecturas concurrentes de reportes no crean AuditLog ni mutan Sale/Payment/Quote/AccountingEntry/DocumentSequence', async () => {
      const before = await Promise.all([
        prisma.sale.count(),
        prisma.payment.count(),
        prisma.quote.count(),
        prisma.accountingEntry.count(),
        prisma.accountingEntryLine.count(),
        prisma.auditLog.count(),
        prisma.documentSequence.findUniqueOrThrow({
          where: { documentType: DocumentType.SALE },
        }),
      ]);

      const responses = await Promise.all([
        get('/api/v1/reports/sales-by-product', adminCookie, {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        }),
        get('/api/v1/reports/sales-by-customer', adminCookie, {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        }),
        get('/api/v1/reports/sales-by-seller', adminCookie, {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        }),
        get('/api/v1/reports/quotes-by-status', adminCookie, {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        }),
        get('/api/v1/reports/payments-by-method', adminCookie, {
          from: PERIOD_FROM,
          to: PERIOD_TO,
        }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(200);
      }

      const after = await Promise.all([
        prisma.sale.count(),
        prisma.payment.count(),
        prisma.quote.count(),
        prisma.accountingEntry.count(),
        prisma.accountingEntryLine.count(),
        prisma.auditLog.count(),
        prisma.documentSequence.findUniqueOrThrow({
          where: { documentType: DocumentType.SALE },
        }),
      ]);

      expect(after[0]).toBe(before[0]); // Sale
      expect(after[1]).toBe(before[1]); // Payment
      expect(after[2]).toBe(before[2]); // Quote
      expect(after[3]).toBe(before[3]); // AccountingEntry
      expect(after[4]).toBe(before[4]); // AccountingEntryLine
      expect(after[5]).toBe(before[5]); // AuditLog — ningún REPORT_VIEWED.
      expect((after[6] as { currentNumber: number }).currentNumber).toBe(
        (before[6] as { currentNumber: number }).currentNumber,
      );
    });
  });
});
