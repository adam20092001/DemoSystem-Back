import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  CustomerType,
  DocumentType,
  Prisma,
  PrismaClient,
  QuoteStatus,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  businessToday,
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
 * Fase 9, Bloque D — E2E final del Dashboard (Bloque C). Un solo ciclo de
 * aplicación y un solo PrismaClient de prueba (pos_db_test). Mismo criterio
 * que reports.e2e-spec.ts: hechos de negocio vía flujo HTTP real,
 * Category/Unit vía Prisma directo, y únicamente confirmedAt/paidAt
 * ajustados directamente en pos_db_test cuando el endpoint público no
 * puede fijarlos (§6).
 *
 * lowStock/receivables NO admiten filtro en el Dashboard (a diferencia de
 * los reportes de Bloque B): son secciones globales de estado ACTUAL. Para
 * que las aserciones sean robustas frente a cualquier residuo de otras
 * suites (aunque este archivo se ejecute en aislamiento contra una
 * pos_db_test vacía, ver §3), se capturan líneas base ANTES de crear las
 * fixtures propias y se comparan por delta — nunca con parseFloat: el
 * delta monetario usa Prisma.Decimal, igual que el código de producción.
 */
describe('Dashboard (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  const SELLER_USERNAME = 'e2e_seller_dashboard';
  const SELLER_PASSWORD = 'SellerDashboard123';
  const SELLER2_USERNAME = 'e2e_seller2_dashboard';
  const SELLER2_PASSWORD = 'Seller2Dashboard123';
  const MANAGEMENT_USERNAME = 'e2e_management_dashboard';
  const MANAGEMENT_PASSWORD = 'ManagementDashboard123';
  const WAREHOUSE_USERNAME = 'e2e_warehouse_dashboard';
  const WAREHOUSE_PASSWORD = 'WarehouseDashboard123';

  let adminCookie: string;
  let sellerCookie: string;
  let seller2Cookie: string;
  let managementCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;

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

  // Período dedicado, distinto del usado por reports.e2e-spec.ts, para que
  // ambas suites nunca compartan el mismo rango.
  const PERIOD_FROM = '2025-04-10';
  const PERIOD_TO = '2025-04-20';
  const periodStart = startOfBusinessDayUtc(PERIOD_FROM);
  const insideInstant = new Date(periodStart.getTime() + 6 * 60 * 60 * 1000);
  const outsideInstant = new Date(
    periodStart.getTime() - 20 * 24 * 60 * 60 * 1000,
  );

  interface FixtureProduct {
    id: string;
    sku: string;
    name: string;
    salePrice: string;
  }
  interface FixtureCustomer {
    id: string;
    name: string;
  }
  interface SafeSaleBody {
    id: string;
    number: string;
    total: string;
    payments: { id: string }[];
  }
  interface DashboardBody {
    period: { from: string; to: string };
    sales: { count: number; total: string } | null;
    collections: { count: number; total: string } | null;
    lowStock: {
      count: number;
      items: {
        productId: string;
        sku: string;
        productName: string;
        stockCurrent: string;
        stockMinimum: string;
        difference: string;
      }[];
    } | null;
    quotes: {
      total: number;
      byStatus: { status: QuoteStatus; count: number }[];
    } | null;
    receivables: {
      count: number;
      totalBalance: string;
      oldest: {
        saleId: string;
        saleNumber: string;
        customerId: string;
        customerName: string;
        confirmedAt: string;
        total: string;
        paidAmount: string;
        balanceDue: string;
        daysOutstanding: number;
      }[];
    } | null;
  }

  // ------------------------------------------------------------------
  // Helpers de fixture (flujo HTTP real)
  // ------------------------------------------------------------------

  /** Producto vendible: alta de saldo inicial para que las ventas no fallen por stock insuficiente. */
  async function createSellableProductHttp(
    overrides: Record<string, unknown> = {},
  ): Promise<FixtureProduct> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: `E2EDASH-${suffix}`,
        name: `Producto Dashboard E2E ${suffix}`,
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
    };
    createdProductIds.push(body.id);
    await request(app.getHttpServer())
      .post('/api/v1/inventory/initial-balances')
      .set('Cookie', adminCookie)
      .send({
        productId: body.id,
        quantity: '1000.000',
        reason: 'Saldo inicial E2E Dashboard',
      });
    return body;
  }

  /** Producto de stock bajo: SIN saldo inicial (stockCurrent nace en 0), con stockMinimum controlado. */
  async function createLowStockProductHttp(
    stockMinimum: string,
    overrides: Record<string, unknown> = {},
  ): Promise<FixtureProduct> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: `E2EDASHLS-${suffix}`,
        name: `Producto Dashboard StockBajo E2E ${suffix}`,
        productType: 'PRODUCT',
        categoryId,
        unitId,
        salePrice: '9.90',
        isInventoryTracked: true,
        stockMinimum,
        ...overrides,
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el producto de stock bajo fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as {
      id: string;
      sku: string;
      name: string;
      salePrice: string;
    };
    createdProductIds.push(body.id);
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
        name: `Cliente Dashboard E2E ${suffix}`,
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
  ): Promise<{ id: string; number: string }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send({ expirationDate: FAR_FUTURE_EXPIRATION, ...overrides });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la cotización fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as { id: string; number: string };
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
      .send({ reason: 'Anulación fixture E2E Dashboard' });
  }

  async function cancelSaleHttp(saleId: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Anulación fixture E2E Dashboard' });
  }

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

  async function getDashboard(
    cookie: string,
    query: Record<string, string> = {},
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/dashboard')
      .set('Cookie', cookie)
      .query(query);
  }

  function assertNoLeakage(response: { body: unknown }): void {
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/prisma/i);
    expect(serialized).not.toMatch(/at Object/);
    expect(serialized).not.toMatch(/P2\d{3}/);
  }

  // ==================================================================
  // Setup / teardown
  // ==================================================================
  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_dashboard@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER2_USERNAME,
      email: 'e2e_seller2_dashboard@demosystem.test',
      password: SELLER2_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_dashboard@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_dashboard@demosystem.test',
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
      where: { code: 'E2EDASHCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EDASHCAT', name: 'Categoria E2E Dashboard' },
    });
    categoryId = category.id;
    ownedCategoryIds.push(categoryId);

    const unit = await prisma.unit.upsert({
      where: { code: 'E2EDASHUNIT' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2EDASHUNIT',
        name: 'Unidad E2E Dashboard',
        abbreviation: 'udb',
        allowDecimal: true,
      },
    });
    unitId = unit.id;
    ownedUnitIds.push(unitId);
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
  // §8 — Auth matrix
  // ==================================================================
  describe('auth — GET /dashboard', () => {
    it('sin cookie -> 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/dashboard',
      );
      expect(response.status).toBe(401);
    });

    it.each([
      ['ADMIN', () => adminCookie],
      ['MANAGEMENT', () => managementCookie],
      ['SELLER', () => sellerCookie],
      ['WAREHOUSE', () => warehouseCookie],
    ])('%s -> 200', async (_label, getCookie) => {
      const response = await getDashboard(getCookie());
      expect(response.status).toBe(200);
    });
  });

  // ==================================================================
  // §10 — Validación de query
  // ==================================================================
  describe('validación de query', () => {
    it('ambos omitidos -> 200', async () => {
      const response = await getDashboard(adminCookie);
      expect(response.status).toBe(200);
    });

    it('from + to -> 200', async () => {
      const response = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      expect(response.status).toBe(200);
    });

    it('from solo -> 400', async () => {
      const response = await getDashboard(adminCookie, { from: PERIOD_FROM });
      expect(response.status).toBe(400);
      assertNoLeakage(response);
    });

    it('to solo -> 400', async () => {
      const response = await getDashboard(adminCookie, { to: PERIOD_TO });
      expect(response.status).toBe(400);
    });

    it('from > to -> 400', async () => {
      const response = await getDashboard(adminCookie, {
        from: PERIOD_TO,
        to: PERIOD_FROM,
      });
      expect(response.status).toBe(400);
    });

    it('fecha calendario imposible -> 400', async () => {
      const response = await getDashboard(adminCookie, {
        from: '2025-02-30',
        to: PERIOD_TO,
      });
      expect(response.status).toBe(400);
    });

    it('fecha con timestamp -> 400', async () => {
      const response = await getDashboard(adminCookie, {
        from: '2025-04-10T00:00:00Z',
        to: PERIOD_TO,
      });
      expect(response.status).toBe(400);
    });

    it('campo desconocido -> 400', async () => {
      const response = await getDashboard(adminCookie, { notAField: 'x' });
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // §50 — período por defecto (mes calendario actual America/Lima)
  // ==================================================================
  describe('período por defecto', () => {
    it('sin from/to: period.from = día 1 del mes Lima actual; period.to = hoy Lima', async () => {
      const response = await getDashboard(adminCookie);
      expect(response.status).toBe(200);
      const today = businessToday();
      const expectedFrom = `${today.slice(0, 7)}-01`;
      const body = response.body as DashboardBody;
      expect(body.period).toEqual({ from: expectedFrom, to: today });
    });
  });

  // ==================================================================
  // §51 — período personalizado: eco exacto
  // ==================================================================
  describe('período personalizado', () => {
    it('con from/to: la respuesta refleja exactamente el rango solicitado', async () => {
      const response = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const body = response.body as DashboardBody;
      expect(body.period).toEqual({ from: PERIOD_FROM, to: PERIOD_TO });
    });
  });

  // ==================================================================
  // §46-49 — Matriz de contenido por rol
  // ==================================================================
  describe('matriz de contenido por rol', () => {
    it('ADMIN: las 5 secciones no-null; sin secciones extra', async () => {
      const response = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const body = response.body as DashboardBody;
      expect(body.sales).not.toBeNull();
      expect(body.collections).not.toBeNull();
      expect(body.lowStock).not.toBeNull();
      expect(body.quotes).not.toBeNull();
      expect(body.receivables).not.toBeNull();
      expect(Object.keys(body).sort()).toEqual(
        [
          'period',
          'sales',
          'collections',
          'lowStock',
          'quotes',
          'receivables',
        ].sort(),
      );
    });

    it('MANAGEMENT: idéntico a ADMIN (las 5 no-null)', async () => {
      const response = await getDashboard(managementCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const body = response.body as DashboardBody;
      expect(body.sales).not.toBeNull();
      expect(body.collections).not.toBeNull();
      expect(body.lowStock).not.toBeNull();
      expect(body.quotes).not.toBeNull();
      expect(body.receivables).not.toBeNull();
    });

    it('SELLER: lowStock=null; el resto no-null; sin restricción a sus propias ventas (ve datos de OTRO vendedor)', async () => {
      const productOther = await createSellableProductHttp();
      const customer = await createCustomerHttp();
      // Venta de seller2, consultada por seller1 (sellerCookie).
      const saleFromOther = await createSaleHttp(seller2Cookie, {
        customerId: customer.id,
        items: [{ productId: productOther.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleFromOther.id, insideInstant);

      const response = await getDashboard(sellerCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const body = response.body as DashboardBody;
      expect(body.lowStock).toBeNull();
      expect(body.sales).not.toBeNull();
      expect(body.collections).not.toBeNull();
      expect(body.quotes).not.toBeNull();
      expect(body.receivables).not.toBeNull();
      expect(body.sales!.count).toBeGreaterThanOrEqual(1); // incluye la venta de seller2.
    });

    it('WAREHOUSE: únicamente lowStock no-null; sin fuga financiera/comercial', async () => {
      const response = await getDashboard(warehouseCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const body = response.body as DashboardBody;
      expect(body.lowStock).not.toBeNull();
      expect(body.sales).toBeNull();
      expect(body.collections).toBeNull();
      expect(body.quotes).toBeNull();
      expect(body.receivables).toBeNull();
    });
  });

  // ==================================================================
  // §52 — Dashboard Sales
  // ==================================================================
  describe('sección sales', () => {
    it('cuenta/total solo ACTIVE dentro del período; ANULADA y FUERA del período se excluyen; money fixed2', async () => {
      const product = await createSellableProductHttp({ salePrice: '50.00' });
      const customer = await createCustomerHttp();

      const before = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const beforeBody = before.body as DashboardBody;
      const beforeCount = beforeBody.sales!.count;
      const beforeTotal = new Prisma.Decimal(beforeBody.sales!.total);

      const active = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(active.id, insideInstant);

      const cancelled = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(cancelled.id, insideInstant);
      expect((await cancelSaleHttp(cancelled.id)).status).toBe(200);

      const outside = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(outside.id, outsideInstant);

      const after = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const afterBody = after.body as DashboardBody;
      expect(afterBody.sales!.count).toBe(beforeCount + 1);
      expect(afterBody.sales!.total).toBe(beforeTotal.plus('50.00').toFixed(2));
    });
  });

  // ==================================================================
  // §53 — Dashboard Collections
  // ==================================================================
  describe('sección collections', () => {
    it('cuenta/total solo ACTIVE dentro del período; semántica de estado neto ACTUAL: un pago anulado luego deja de contar', async () => {
      const product = await createSellableProductHttp({ salePrice: '30.00' });
      const customer = await createCustomerHttp();

      const before = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const beforeBody = before.body as DashboardBody;
      const beforeCount = beforeBody.collections!.count;
      const beforeTotal = new Prisma.Decimal(beforeBody.collections!.total);

      const saleActive = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleActive.id, insideInstant);
      const paymentActive = await registerPaymentHttp(
        adminCookie,
        saleActive.id,
        {
          method: 'CASH',
          amount: '30.00',
        },
      );
      expect(paymentActive.status).toBe(201);
      await setPaymentPaidAt(paymentIdOf(paymentActive), insideInstant);

      const saleWillCancel = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleWillCancel.id, insideInstant);
      const paymentWillCancel = await registerPaymentHttp(
        adminCookie,
        saleWillCancel.id,
        {
          method: 'CASH',
          amount: '30.00',
        },
      );
      expect(paymentWillCancel.status).toBe(201);
      const willCancelId = paymentIdOf(paymentWillCancel);
      await setPaymentPaidAt(willCancelId, insideInstant);

      const saleOutside = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(saleOutside.id, insideInstant);
      const paymentOutside = await registerPaymentHttp(
        adminCookie,
        saleOutside.id,
        {
          method: 'CASH',
          amount: '30.00',
        },
      );
      expect(paymentOutside.status).toBe(201);
      await setPaymentPaidAt(paymentIdOf(paymentOutside), outsideInstant);

      const midway = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const midwayBody = midway.body as DashboardBody;
      // active + willCancel (aún ACTIVE) cuentan; outside (paidAt fuera) no.
      expect(midwayBody.collections!.count).toBe(beforeCount + 2);
      expect(midwayBody.collections!.total).toBe(
        beforeTotal.plus('60.00').toFixed(2),
      );

      expect(
        (await cancelPaymentHttp(saleWillCancel.id, willCancelId)).status,
      ).toBe(200);

      const after = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const afterBody = after.body as DashboardBody;
      // Semántica de estado neto ACTUAL: el pago recién anulado deja de contar.
      expect(afterBody.collections!.count).toBe(beforeCount + 1);
      expect(afterBody.collections!.total).toBe(
        beforeTotal.plus('30.00').toFixed(2),
      );
    });
  });

  // ==================================================================
  // §54-55 — Dashboard LowStock (estado actual, sin filtro de período)
  // ==================================================================
  describe('sección lowStock', () => {
    // Faltantes extremos y sin precedente plausible en otras suites, para
    // dominar garantizadamente el top-5 sin importar residuos ajenos.
    const SHORTAGES = ['910000', '920000', '930000', '940000', '950000'];

    it('count incluye TODOS los elegibles (delta); items máx. 5 ordenados por faltante DESC, empate sku ASC/id ASC; no-tracked excluido', async () => {
      const before = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const beforeCount = (before.body as DashboardBody).lowStock!.count;

      const products: FixtureProduct[] = [];
      for (const shortage of SHORTAGES) {
        products.push(await createLowStockProductHttp(shortage));
      }
      // Sexto producto elegible con faltante distinto (más chico, fuera del top-5).
      const sixthLowStock = await createLowStockProductHttp('900000');

      // No inventariado: NUNCA elegible, sin importar cuán "bajo" luzca.
      const nonTrackedResponse = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          sku: `E2EDASHNT-${nextSuffix()}`,
          name: 'Producto Dashboard No Rastreado',
          productType: 'SERVICE',
          categoryId,
          unitId,
          salePrice: '9.90',
          isInventoryTracked: false,
        });
      expect(nonTrackedResponse.status).toBe(201);
      createdProductIds.push((nonTrackedResponse.body as { id: string }).id);

      const after = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const afterBody = after.body as DashboardBody;
      expect(afterBody.lowStock!.count).toBe(
        beforeCount + SHORTAGES.length + 1,
      );

      // products[] se creó en orden ascendente de faltante (910000..950000);
      // el orden esperado (mayor faltante primero) es exactamente el reverso.
      const expectedTop5Ids = [...products].reverse().map((p) => p.id);
      const items = afterBody.lowStock!.items;
      expect(items).toHaveLength(5);
      expect(items.map((i) => i.productId)).toEqual(expectedTop5Ids);
      // El faltante mayor (950000) va primero; el más chico del lote de 5
      // (910000) va último; el sexto producto (900000) queda fuera del top-5.
      const differences = items.map((i) => i.difference);
      expect(differences).toEqual([
        '950000.000',
        '940000.000',
        '930000.000',
        '920000.000',
        '910000.000',
      ]);
      expect(items.map((i) => i.productId)).not.toContain(sixthLowStock.id);
    });

    it('stockCurrent == stockMinimum (faltante "0.000") sigue siendo elegible — verificado vía GET /inventory/low-stock (R5, filtrable)', async () => {
      const equalProduct = await createLowStockProductHttp('7');
      const initialBalance = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: equalProduct.id,
          quantity: '7.000',
          reason: 'Igualar a stockMinimum E2E Dashboard',
        });
      expect(initialBalance.status).toBe(201);

      const response = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', adminCookie)
        .query({ search: equalProduct.sku });
      const rows = (response.body as { data: unknown }).data as {
        id: string;
        difference: string;
      }[];
      expect(rows).toHaveLength(1);
      expect(rows[0].id).toBe(equalProduct.id);
      expect(rows[0].difference).toBe('0.000');
    });

    it('el período del Dashboard NO afecta lowStock (estado actual)', async () => {
      const withPeriod = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const withHistoricalPeriod = await getDashboard(adminCookie, {
        from: '2020-01-01',
        to: '2020-01-05',
      });
      expect((withHistoricalPeriod.body as DashboardBody).lowStock).toEqual(
        (withPeriod.body as DashboardBody).lowStock,
      );
    });
  });

  // ==================================================================
  // §56 — Dashboard Quotes
  // ==================================================================
  describe('sección quotes', () => {
    it('byStatus contiene los 5 valores de QuoteStatus exactamente una vez, en orden de negocio, incluidos los de conteo cero (delta contra la línea base)', async () => {
      const product = await createSellableProductHttp();
      const customer = await createCustomerHttp();

      const before = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const beforeBody = before.body as DashboardBody;
      const beforeByStatus = new Map(
        beforeBody.quotes!.byStatus.map((r) => [r.status, r.count]),
      );
      const beforeTotal = beforeBody.quotes!.total;

      const quotePending = await createQuoteHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quotePending.id,
        new Date(`${PERIOD_FROM}T00:00:00.000Z`),
      );

      const quoteAccepted = await createQuoteHttp(sellerCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setQuoteIssueDate(
        quoteAccepted.id,
        new Date(`${PERIOD_FROM}T00:00:00.000Z`),
      );
      expect(
        (
          await request(app.getHttpServer())
            .post(`/api/v1/quotes/${quoteAccepted.id}/accept`)
            .set('Cookie', adminCookie)
            .send()
        ).status,
      ).toBe(200);

      const after = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const afterBody = after.body as DashboardBody;
      const statuses = afterBody.quotes!.byStatus.map((r) => r.status);
      expect(statuses).toEqual([
        QuoteStatus.PENDING,
        QuoteStatus.ACCEPTED,
        QuoteStatus.REJECTED,
        QuoteStatus.EXPIRED,
        QuoteStatus.CONVERTED,
      ]);
      expect(new Set(statuses).size).toBe(5);

      const afterByStatus = new Map(
        afterBody.quotes!.byStatus.map((r) => [r.status, r.count]),
      );
      expect(afterByStatus.get(QuoteStatus.PENDING)).toBe(
        (beforeByStatus.get(QuoteStatus.PENDING) ?? 0) + 1,
      );
      expect(afterByStatus.get(QuoteStatus.ACCEPTED)).toBe(
        (beforeByStatus.get(QuoteStatus.ACCEPTED) ?? 0) + 1,
      );
      expect(afterByStatus.get(QuoteStatus.REJECTED)).toBe(
        beforeByStatus.get(QuoteStatus.REJECTED) ?? 0,
      );
      expect(afterByStatus.get(QuoteStatus.CONVERTED)).toBe(
        beforeByStatus.get(QuoteStatus.CONVERTED) ?? 0,
      );
      expect(afterBody.quotes!.total).toBe(beforeTotal + 2);
    });
  });

  // ==================================================================
  // §57-58 — Dashboard Receivables (estado actual, sin filtro de período)
  // ==================================================================
  describe('sección receivables', () => {
    it('count/totalBalance por delta; oldest ordenado confirmedAt ASC; money fixed2; daysOutstanding presente', async () => {
      const before = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const beforeBody = before.body as DashboardBody;
      const beforeCount = beforeBody.receivables!.count;
      const beforeTotal = new Prisma.Decimal(
        beforeBody.receivables!.totalBalance,
      );

      const product = await createSellableProductHttp({ salePrice: '80.00' });
      const customer = await createCustomerHttp();

      // 6 ventas con deuda (> 5 para probar que oldest se limita a 5 pero
      // count/totalBalance reflejan las 6), todas con confirmedAt fuera del
      // "ahora" real de otras suites para dominar el orden "más antigua
      // primero" sin ambigüedad.
      const saleIds: string[] = [];
      for (let i = 0; i < 6; i += 1) {
        const sale = await createSaleHttp(adminCookie, {
          customerId: customer.id,
          items: [{ productId: product.id, quantity: '1.000' }],
        });
        await setSaleConfirmedAt(
          sale.id,
          new Date(insideInstant.getTime() + i * 60 * 60 * 1000),
        );
        saleIds.push(sale.id);
      }

      const after = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const afterBody = after.body as DashboardBody;
      expect(afterBody.receivables!.count).toBe(beforeCount + 6);
      expect(afterBody.receivables!.totalBalance).toBe(
        beforeTotal.plus(new Prisma.Decimal('80.00').mul(6)).toFixed(2),
      );

      const oldest = afterBody.receivables!.oldest;
      expect(oldest.length).toBeLessThanOrEqual(5);
      const mineInOldest = oldest.filter((o) => saleIds.includes(o.saleId));
      expect(mineInOldest.length).toBeGreaterThan(0);
      const confirmedAts = oldest.map((o) => new Date(o.confirmedAt).getTime());
      expect(confirmedAts).toEqual([...confirmedAts].sort((a, b) => a - b));
      for (const row of mineInOldest) {
        expect(row.total).toBe('80.00');
        expect(row.balanceDue).toBe('80.00');
        expect(row.paidAmount).toBe('0.00');
        expect(typeof row.daysOutstanding).toBe('number');
        expect(row.daysOutstanding).toBeGreaterThanOrEqual(0);
      }
    });

    it('el período del Dashboard NO afecta receivables (estado actual)', async () => {
      const withPeriod = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const withHistoricalPeriod = await getDashboard(adminCookie, {
        from: '2020-01-01',
        to: '2020-01-05',
      });
      expect((withHistoricalPeriod.body as DashboardBody).receivables).toEqual(
        (withPeriod.body as DashboardBody).receivables,
      );
    });
  });

  // ==================================================================
  // §59 — Anular una venta con deuda: desaparece de sales y receivables
  // ==================================================================
  describe('venta anulada: cae de sales y receivables', () => {
    it('Sale ACTIVE con deuda -> aparece en receivables; tras anularla, desaparece de sales y receivables', async () => {
      const product = await createSellableProductHttp({ salePrice: '45.00' });
      const customer = await createCustomerHttp();
      const sale = await createSaleHttp(adminCookie, {
        customerId: customer.id,
        items: [{ productId: product.id, quantity: '1.000' }],
      });
      await setSaleConfirmedAt(sale.id, insideInstant);

      const before = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const beforeBody = before.body as DashboardBody;
      expect(
        beforeBody.receivables!.oldest.some((o) => o.saleId === sale.id) ||
          beforeBody.receivables!.count > 0,
      ).toBe(true);
      const beforeSalesCount = beforeBody.sales!.count;
      const beforeReceivablesCount = beforeBody.receivables!.count;

      expect((await cancelSaleHttp(sale.id)).status).toBe(200);

      const after = await getDashboard(adminCookie, {
        from: PERIOD_FROM,
        to: PERIOD_TO,
      });
      const afterBody = after.body as DashboardBody;
      expect(afterBody.sales!.count).toBe(beforeSalesCount - 1);
      expect(afterBody.receivables!.count).toBe(beforeReceivablesCount - 1);
      expect(
        afterBody.receivables!.oldest.some((o) => o.saleId === sale.id),
      ).toBe(false);
    });
  });

  // ==================================================================
  // §60/§62/§63/§73 — sin auditoría de lectura, invariante read-only,
  // aislamiento contable, lecturas concurrentes
  // ==================================================================
  describe('lecturas de solo lectura: sin auditoría, sin mutación, aislamiento contable', () => {
    it('varias lecturas concurrentes del Dashboard (ADMIN/SELLER/WAREHOUSE) no crean AuditLog ni mutan Sale/Payment/Quote/Product.stockCurrent/AccountingEntry/DocumentSequence', async () => {
      const before = await Promise.all([
        prisma.sale.count(),
        prisma.payment.count(),
        prisma.quote.count(),
        prisma.accountingEntry.count(),
        prisma.accountingEntryLine.count(),
        prisma.auditLog.count(),
        prisma.inventoryMovement.count(),
        prisma.documentSequence.findUniqueOrThrow({
          where: { documentType: DocumentType.SALE },
        }),
      ]);

      const responses = await Promise.all([
        getDashboard(adminCookie, { from: PERIOD_FROM, to: PERIOD_TO }),
        getDashboard(managementCookie, { from: PERIOD_FROM, to: PERIOD_TO }),
        getDashboard(sellerCookie, { from: PERIOD_FROM, to: PERIOD_TO }),
        getDashboard(warehouseCookie, { from: PERIOD_FROM, to: PERIOD_TO }),
        getDashboard(adminCookie),
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
        prisma.inventoryMovement.count(),
        prisma.documentSequence.findUniqueOrThrow({
          where: { documentType: DocumentType.SALE },
        }),
      ]);

      expect(after[0]).toBe(before[0]); // Sale
      expect(after[1]).toBe(before[1]); // Payment
      expect(after[2]).toBe(before[2]); // Quote
      expect(after[3]).toBe(before[3]); // AccountingEntry
      expect(after[4]).toBe(before[4]); // AccountingEntryLine
      expect(after[5]).toBe(before[5]); // AuditLog — ningún DASHBOARD_VIEWED.
      expect(after[6]).toBe(before[6]); // InventoryMovement
      expect((after[7] as { currentNumber: number }).currentNumber).toBe(
        (before[7] as { currentNumber: number }).currentNumber,
      );
    });
  });

  // ==================================================================
  // §65/§68/§69 — sin mutación, sin versión sin prefijo, sin fuga de error
  // ==================================================================
  describe('superficie final — sin mutación, versionado, seguridad de error', () => {
    it('POST/PUT/PATCH/DELETE a /dashboard -> 404 (no existe endpoint de mutación)', async () => {
      for (const verb of ['post', 'put', 'patch', 'delete'] as const) {
        const response = await request(app.getHttpServer())
          [verb]('/api/v1/dashboard')
          .set('Cookie', adminCookie)
          .send({});
        expect(response.status).toBe(404);
      }
    });

    it('/api/dashboard sin versión -> 404', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/dashboard')
        .set('Cookie', adminCookie);
      expect(response.status).toBe(404);
    });

    it('sin sub-rutas /dashboard/summary|sales|payments|inventory|quotes|receivables', async () => {
      for (const sub of [
        'summary',
        'sales',
        'payments',
        'inventory',
        'quotes',
        'receivables',
      ]) {
        const response = await request(app.getHttpServer())
          .get(`/api/v1/dashboard/${sub}`)
          .set('Cookie', adminCookie);
        expect(response.status).toBe(404);
      }
    });

    it('errores controlados (rango de un solo lado, fecha inválida) sin fuga interna', async () => {
      const responses = await Promise.all([
        getDashboard(adminCookie, { from: PERIOD_FROM }),
        getDashboard(adminCookie, { from: '2025-02-30', to: PERIOD_TO }),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(400);
        assertNoLeakage(response);
      }
    });
  });

  // ==================================================================
  // §66-67 — Swagger final
  // ==================================================================
  describe('Swagger final', () => {
    it('/api/docs-json: exactamente 1 operación Dashboard, tipos seguros, secciones nullable', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');
      expect(response.status).toBe(200);
      const doc = response.body as {
        tags: { name: string }[];
        paths: Record<string, Record<string, unknown>>;
        components: {
          schemas: Record<
            string,
            { properties?: Record<string, unknown>; required?: string[] }
          >;
        };
      };
      expect(doc.tags.some((t) => t.name === 'Dashboard')).toBe(true);
      const dashboardPaths = Object.keys(doc.paths).filter((p) =>
        p.startsWith('/api/v1/dashboard'),
      );
      expect(dashboardPaths).toEqual(['/api/v1/dashboard']);
      expect(Object.keys(doc.paths['/api/v1/dashboard'])).toEqual(['get']);

      const reportPaths = Object.keys(doc.paths).filter((p) =>
        p.startsWith('/api/v1/reports'),
      );
      expect(reportPaths).toHaveLength(5);

      const responseSchema = doc.components.schemas.DashboardResponseDto;
      expect(responseSchema.properties?.sales).toMatchObject({
        nullable: true,
      });
      expect(responseSchema.properties?.lowStock).toMatchObject({
        nullable: true,
      });
      expect(responseSchema.properties?.receivables).toMatchObject({
        nullable: true,
      });

      const salesSchema =
        doc.components.schemas.DashboardSalesSectionResponseDto;
      expect(salesSchema.properties?.total).toMatchObject({ type: 'string' });
      const lowStockItemSchema =
        doc.components.schemas.DashboardLowStockItemResponseDto;
      expect(lowStockItemSchema.properties?.stockCurrent).toMatchObject({
        type: 'string',
      });
      expect(lowStockItemSchema.properties?.difference).toMatchObject({
        type: 'string',
      });

      const serialized = JSON.stringify(doc);
      expect(serialized).not.toMatch(/percentage|conversionRate|growth/i);
    });
  });

  // ==================================================================
  // Aislamiento de rango histórico ya cubierto arriba (§55/§58). Cierre.
  // ==================================================================
});
