import { INestApplication } from '@nestjs/common';
import {
  AccountingEventType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  DocumentType,
  PaymentCancellationSource,
  PaymentMethodAccountingDestination,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  QuoteStatus,
  RoleName,
  SalePaymentStatus,
} from '@prisma/client';
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
 * R1-B2 — lote de pagos iniciales (`payments[]`) en POST /sales y
 * POST /sales/from-quote/:quoteId: prueba de extremo a extremo (HTTP real,
 * PostgreSQL real) de que todos los pagos del lote se registran vía
 * PaymentEngine en la MISMA transacción que confirma la venta, o que nada
 * persiste si cualquiera falla (venta, correlativo, pagos, asientos, stock,
 * auditoría). Archivo dedicado con fixtures de propiedad exacta: usuarios
 * exclusivos de esta suite, secuencias NV/COT y "Público general"
 * upserteados en beforeAll y retirados en afterAll. Desde la eliminación de
 * Caja, ningún cobro exige ni crea una CashSession.
 */
describe('Sales — lote de pagos iniciales (e2e) — R1-B2', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  const SELLER_USERNAME = 'e2e_seller_r1_batch';
  const SELLER_PASSWORD = 'SellerR1Batch123';
  const SELLER_NO_SESSION_USERNAME = 'e2e_seller_r1_nosession';
  const SELLER_NO_SESSION_PASSWORD = 'SellerR1NoSession123';
  const TEST_GENERIC_CODE = 'PUBLIC_GENERAL';
  // Valor UUID arbitrario: solo se usa para probar que `cashSessionId` es
  // un campo NO declarado en el DTO (400), nunca como caja real.
  const UNDECLARED_CASH_SESSION_ID = '00000000-0000-4000-8000-000000000000';

  let adminCookie: string;
  let sellerCookie: string;
  let noSessionCookie: string;
  let noSessionUserId: string;

  let categoryId: string;
  let unitId: string;
  let genericCustomerId: string;
  let trackedProductId: string;
  let inactiveMethodCode: string;

  const ownedCustomerIds: string[] = [];
  const ownedProductIds: string[] = [];
  const ownedSaleIds: string[] = [];
  const ownedQuoteIds: string[] = [];
  const ownedPaymentMethodIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  interface SaleBody {
    id: string;
    number: string;
    total: string;
    paymentStatus: SalePaymentStatus;
    paidAmount: string;
    balanceDue: string;
    quote: { id: string } | null;
    payments: {
      id: string;
      method: string;
      amount: string;
      reference: string | null;
      status: PaymentStatus;
    }[];
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_r1_batch@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_NO_SESSION_USERNAME,
      email: 'e2e_seller_r1_nosession@demosystem.test',
      password: SELLER_NO_SESSION_PASSWORD,
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
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    noSessionCookie = (
      await login(
        app.getHttpServer(),
        SELLER_NO_SESSION_USERNAME,
        SELLER_NO_SESSION_PASSWORD,
      )
    ).cookie;
    noSessionUserId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: SELLER_NO_SESSION_USERNAME },
      })
    ).id;

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

    const generic = await prisma.customer.upsert({
      where: { code: TEST_GENERIC_CODE },
      update: {
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
      create: {
        code: TEST_GENERIC_CODE,
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
    });
    genericCustomerId = generic.id;

    // Producto inventariable fixture (mismo patrón de inserción directa que
    // sales.e2e-spec.ts): permite verificar que un lote fallido no deja
    // ningún movimiento de stock.
    const tracked = await prisma.product.create({
      data: {
        sku: `R1B2-T-${nextSuffix()}`,
        name: 'Producto inventariable R1-B2',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('50.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('100.000'),
        status: ProductStatus.ACTIVE,
      },
    });
    trackedProductId = tracked.id;
    ownedProductIds.push(tracked.id);

    // Método dinámico propio, creado activo y luego desactivado: garantiza
    // un código existente pero INACTIVO sin depender del estado de los
    // métodos legacy compartidos con otras suites.
    inactiveMethodCode = `R1B2_OFF_${nextSuffix()}`.slice(0, 30);
    const created = await request(app.getHttpServer())
      .post('/api/v1/payment-methods')
      .set('Cookie', adminCookie)
      .send({
        code: inactiveMethodCode,
        name: 'Método inactivo R1-B2',
        requiresReference: false,
        affectsCashDrawer: false,
        accountingDestination: PaymentMethodAccountingDestination.BANK,
      });
    if (created.status !== 201) {
      throw new Error(
        `No se pudo crear el método fixture: ${JSON.stringify(created.body)}`,
      );
    }
    const methodId = (created.body as { id: string }).id;
    ownedPaymentMethodIds.push(methodId);
    const deactivated = await request(app.getHttpServer())
      .patch(`/api/v1/payment-methods/${methodId}`)
      .set('Cookie', adminCookie)
      .send({ active: false });
    if (deactivated.status !== 200) {
      throw new Error(
        `No se pudo desactivar el método fixture: ${JSON.stringify(deactivated.body)}`,
      );
    }
  }, 120000);

  afterAll(async () => {
    try {
      const ownedPayments = await prisma.payment.findMany({
        where: { saleId: { in: ownedSaleIds } },
        select: { id: true },
      });
      const ownedPaymentIds = ownedPayments.map((p) => p.id);

      if (ownedSaleIds.length > 0) {
        // REVERSAL primero (self-FK reversesEntryId hacia su ORIGINAL),
        // luego ORIGINAL; las líneas se van por CASCADE.
        const accountingWhere = {
          OR: [
            { sourceType: 'SALE' as const, sourceId: { in: ownedSaleIds } },
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
        await prisma.inventoryMovement.deleteMany({
          where: { productId: { in: ownedProductIds } },
        });
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
      if (genericCustomerId) {
        await prisma.customer.deleteMany({ where: { id: genericCustomerId } });
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
        sku: `R1B2-${nextSuffix()}`,
        name: 'Servicio fixture R1-B2',
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

  async function createCustomer(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Cookie', sellerCookie)
      .send({
        customerType: 'PERSON',
        customerStage: 'CUSTOMER',
        name: `Cliente R1-B2 ${nextSuffix()}`,
      });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    ownedCustomerIds.push(id);
    return id;
  }

  function postSale(
    cookie: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send(body);
  }

  function trackSale(response: request.Response): SaleBody {
    const body = response.body as SaleBody;
    ownedSaleIds.push(body.id);
    return body;
  }

  async function createQuote(customerId: string, productId: string) {
    const response = await request(app.getHttpServer())
      .post('/api/v1/quotes')
      .set('Cookie', sellerCookie)
      .send({ customerId, items: [{ productId, quantity: '1' }] });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    ownedQuoteIds.push(id);
    return id;
  }

  async function saleSequenceNumber(): Promise<number> {
    const row = await prisma.documentSequence.findUniqueOrThrow({
      where: { documentType: DocumentType.SALE },
    });
    return row.currentNumber;
  }

  /**
   * Instantánea de todo lo que una confirmación de venta con lote podría
   * persistir. Se compara antes/después de un intento fallido: un lote
   * atómico no deja NINGÚN rastro.
   */
  async function persistenceSnapshot(customerId: string) {
    const [
      sales,
      payments,
      accountingEntries,
      inventoryMovements,
      stock,
      saleSequence,
      saleConfirmedAudits,
      paymentRegisteredAudits,
    ] = await Promise.all([
      prisma.sale.count({ where: { customerId } }),
      prisma.payment.count(),
      prisma.accountingEntry.count(),
      prisma.inventoryMovement.count({
        where: { productId: trackedProductId },
      }),
      prisma.product
        .findUniqueOrThrow({ where: { id: trackedProductId } })
        .then((p) => p.stockCurrent.toFixed(3)),
      saleSequenceNumber(),
      prisma.auditLog.count({ where: { action: AuditAction.SALE_CONFIRMED } }),
      prisma.auditLog.count({
        where: { action: AuditAction.PAYMENT_REGISTERED },
      }),
    ]);
    return {
      sales,
      payments,
      accountingEntries,
      inventoryMovements,
      stock,
      saleSequence,
      saleConfirmedAudits,
      paymentRegisteredAudits,
    };
  }

  const BATCH_250 = [
    { method: 'CASH', amount: '100.00' },
    { method: 'YAPE', amount: '100.00', reference: 'OP-123' },
    { method: 'CARD', amount: '50.00', reference: 'VCH-9' },
  ];

  // ====================================================================
  // Éxito — venta directa y conversión
  // ====================================================================
  describe('lote exitoso', () => {
    it('venta directa 250 = CASH 100 + YAPE 100 + CARD 50: PAID, 3 Payments ACTIVE sin caja, snapshot affectsCashDrawer, asientos por destino', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('250.00');

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payments: BATCH_250,
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);

      expect(sale.total).toBe('250.00');
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.paidAmount).toBe('250.00');
      expect(sale.balanceDue).toBe('0.00');
      expect(sale.payments).toHaveLength(3);
      expect(
        sale.payments.every((p) => p.status === PaymentStatus.ACTIVE),
      ).toBe(true);

      const rows = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(rows).toHaveLength(3);
      expect(rows.every((p) => p.cashSessionId === null)).toBe(true);
      expect(
        rows.map((p) => `${p.paymentMethodCode}:${p.amount.toFixed(2)}`).sort(),
      ).toEqual(['CARD:50.00', 'CASH:100.00', 'YAPE:100.00']);
      expect(
        rows
          .filter((p) => p.paymentMethodAffectsCashDrawer)
          .map((p) => p.paymentMethodCode),
      ).toEqual(['CASH']);

      // Sin registros duplicados: exactamente un asiento ORIGINAL por pago,
      // con el destino contable configurado de cada método.
      for (const payment of rows) {
        const entries = await prisma.accountingEntry.findMany({
          where: { sourceType: 'PAYMENT', sourceId: payment.id },
          include: { lines: { include: { account: true } } },
        });
        expect(entries).toHaveLength(1);
        expect(entries[0].eventType).toBe(AccountingEventType.ORIGINAL);
        const debit = entries[0].lines.find((l) =>
          l.debitAmount.greaterThan(0),
        );
        const credit = entries[0].lines.find((l) =>
          l.creditAmount.greaterThan(0),
        );
        const expectedKey =
          payment.paymentMethodCode === 'CASH'
            ? AccountingSystemKey.CASH
            : AccountingSystemKey.BANK;
        expect(debit?.account.systemKey).toBe(expectedKey);
        expect(debit?.debitAmount.equals(payment.amount)).toBe(true);
        expect(credit?.account.systemKey).toBe(
          AccountingSystemKey.ACCOUNTS_RECEIVABLE,
        );
        expect(credit?.creditAmount.equals(payment.amount)).toBe(true);
      }

      const registeredAudits = await prisma.auditLog.count({
        where: {
          action: AuditAction.PAYMENT_REGISTERED,
          entityId: { in: rows.map((p) => p.id) },
        },
      });
      expect(registeredAudits).toBe(3);
      const confirmedAudits = await prisma.auditLog.count({
        where: { action: AuditAction.SALE_CONFIRMED, entityId: sale.id },
      });
      expect(confirmedAudits).toBe(1);
    });

    it('conversión de cotización con el mismo lote: PAID, Quote CONVERTED, 3 Payments sin caja', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('250.00');
      const quoteId = await createQuote(customerId, productId);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteId}`)
        .set('Cookie', sellerCookie)
        .send({ payments: BATCH_250 });
      expect(response.status).toBe(201);
      const sale = trackSale(response);

      expect(sale.quote?.id).toBe(quoteId);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.balanceDue).toBe('0.00');
      const rows = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(rows).toHaveLength(3);
      expect(rows.every((p) => p.cashSessionId === null)).toBe(true);
      const quote = await prisma.quote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(quote.status).toBe(QuoteStatus.CONVERTED);
    });

    it('método repetido en el lote (CASH 30 + CASH 20): dos Payments CASH', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('50.00');

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payments: [
          { method: 'CASH', amount: '30.00' },
          { method: 'CASH', amount: '20.00' },
        ],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.payments.map((p) => p.method)).toEqual(['CASH', 'CASH']);
    });

    it('un único pago vía `payments`: un Payment, PAID', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('40.00');

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payments: [{ method: 'CASH', amount: '40.00' }],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.payments).toHaveLength(1);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
    });

    it('lote parcial con cliente elegible: PARTIALLY_PAID y saldo pendiente exacto', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('100.00');

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payments: [
          { method: 'CASH', amount: '30.00' },
          { method: 'YAPE', amount: '25.50', reference: 'OP-PART' },
        ],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(sale.paidAmount).toBe('55.50');
      expect(sale.balanceDue).toBe('44.50');
    });

    it('Público general con lote que salda el total: 201', async () => {
      const productId = await createServiceProduct('80.00');

      const response = await postSale(sellerCookie, {
        customerId: genericCustomerId,
        items: [{ productId, quantity: '1' }],
        payments: [
          { method: 'CASH', amount: '50.00' },
          { method: 'YAPE', amount: '30.00', reference: 'OP-PG' },
        ],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.balanceDue).toBe('0.00');
      expect(sale.payments).toHaveLength(2);
    });

    it('cobrador que nunca tuvo una caja: lote -> 201 (antes 409); pagos sin caja; createdBy = ese cobrador; no se crea ninguna caja', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('50.00');
      const sessionsBefore = await prisma.cashSession.count({
        where: { userId: noSessionUserId },
      });

      const response = await postSale(noSessionCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payments: [
          { method: 'CASH', amount: '25.00' },
          { method: 'CASH', amount: '25.00' },
        ],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);

      const rows = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(rows).toHaveLength(2);
      expect(rows.every((p) => p.cashSessionId === null)).toBe(true);
      expect(rows.every((p) => p.createdByUserId === noSessionUserId)).toBe(
        true,
      );
      expect(
        await prisma.cashSession.count({ where: { userId: noSessionUserId } }),
      ).toBe(sessionsBefore);
    });
  });

  // ====================================================================
  // Compatibilidad
  // ====================================================================
  describe('compatibilidad con el contrato existente', () => {
    it('`payment` singular sigue funcionando: un Payment sin caja', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('60.00');

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payment: { method: 'CASH', amount: '60.00' },
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.payments).toHaveLength(1);
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: sale.payments[0].id },
      });
      expect(row.cashSessionId).toBeNull();
    });

    it('sin `payment` ni `payments`: UNPAID, sin Payments (comportamiento previo)', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('70.00');

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.UNPAID);
      expect(sale.balanceDue).toBe('70.00');
      expect(sale.payments).toEqual([]);
    });
  });

  // ====================================================================
  // Validación (400/409) sin efectos persistidos
  // ====================================================================
  describe('rechazos sin efectos persistidos', () => {
    async function expectRejectedWithoutEffects(
      body: (customerId: string, productId: string) => Record<string, unknown>,
      expectedStatus: number,
      cookie: string = sellerCookie,
    ): Promise<request.Response> {
      const customerId = await createCustomer();
      const before = await persistenceSnapshot(customerId);

      const response = await postSale(
        cookie,
        body(customerId, trackedProductId),
      );
      expect(response.status).toBe(expectedStatus);

      const after = await persistenceSnapshot(customerId);
      expect(after).toEqual(before);
      return response;
    }

    it('`payment` y `payments` a la vez -> 400', async () => {
      await expectRejectedWithoutEffects(
        (customerId, productId) => ({
          customerId,
          items: [{ productId, quantity: '1' }],
          payment: { method: 'CASH', amount: '50.00' },
          payments: [{ method: 'CASH', amount: '50.00' }],
        }),
        400,
      );
    });

    it('`payments` vacío -> 400', async () => {
      await expectRejectedWithoutEffects(
        (customerId, productId) => ({
          customerId,
          items: [{ productId, quantity: '1' }],
          payments: [],
        }),
        400,
      );
    });

    it('11 pagos -> 400', async () => {
      await expectRejectedWithoutEffects(
        (customerId, productId) => ({
          customerId,
          items: [{ productId, quantity: '1' }],
          payments: Array.from({ length: 11 }, () => ({
            method: 'CASH',
            amount: '1.00',
          })),
        }),
        400,
      );
    });

    it('monto anidado inválido -> 400', async () => {
      await expectRejectedWithoutEffects(
        (customerId, productId) => ({
          customerId,
          items: [{ productId, quantity: '1' }],
          payments: [
            { method: 'CASH', amount: '10.00' },
            { method: 'CASH', amount: '-5.00' },
          ],
        }),
        400,
      );
    });

    it('method anidado mal formado -> 400', async () => {
      await expectRejectedWithoutEffects(
        (customerId, productId) => ({
          customerId,
          items: [{ productId, quantity: '1' }],
          payments: [{ method: 'A'.repeat(31), amount: '50.00' }],
        }),
        400,
      );
    });

    it('campo no declarado en un elemento -> 400', async () => {
      await expectRejectedWithoutEffects(
        (customerId, productId) => ({
          customerId,
          items: [{ productId, quantity: '1' }],
          payments: [
            {
              method: 'CASH',
              amount: '50.00',
              cashSessionId: UNDECLARED_CASH_SESSION_ID,
            },
          ],
        }),
        400,
      );
    });

    it('sobrepago (suma 50.01 sobre 50.00) -> 409', async () => {
      await expectRejectedWithoutEffects(
        (customerId, productId) => ({
          customerId,
          items: [{ productId, quantity: '1' }],
          payments: [
            { method: 'CASH', amount: '25.00' },
            { method: 'CASH', amount: '25.01' },
          ],
        }),
        409,
      );
    });

    it('Público general con lote incompleto -> 409', async () => {
      const before = await persistenceSnapshot(genericCustomerId);
      const response = await postSale(sellerCookie, {
        customerId: genericCustomerId,
        items: [{ productId: trackedProductId, quantity: '1' }],
        payments: [
          { method: 'CASH', amount: '20.00' },
          { method: 'YAPE', amount: '20.00', reference: 'OP-PG-INC' },
        ],
      });
      expect(response.status).toBe(409);
      expect(await persistenceSnapshot(genericCustomerId)).toEqual(before);
    });
  });

  // ====================================================================
  // Atomicidad ante fallo a mitad del lote
  // ====================================================================
  describe('fallo a mitad del lote: rollback total', () => {
    it('pago #2 con método INACTIVO -> 409; sin venta, correlativo, pagos, asientos, stock ni auditoría', async () => {
      const customerId = await createCustomer();
      const before = await persistenceSnapshot(customerId);

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId: trackedProductId, quantity: '2' }],
        payments: [
          { method: 'CASH', amount: '40.00' },
          { method: inactiveMethodCode, amount: '30.00' },
          { method: 'CASH', amount: '30.00' },
        ],
      });
      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('inactivo');

      expect(await persistenceSnapshot(customerId)).toEqual(before);
    });

    it('pago #3 sin la referencia obligatoria (CARD) -> 400; rollback total de los pagos #1 y #2 ya registrados en la transacción', async () => {
      const customerId = await createCustomer();
      const before = await persistenceSnapshot(customerId);

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId: trackedProductId, quantity: '2' }],
        payments: [
          { method: 'CASH', amount: '40.00' },
          { method: 'YAPE', amount: '30.00', reference: 'OP-R3' },
          { method: 'CARD', amount: '30.00' },
        ],
      });
      expect(response.status).toBe(400);
      expect(JSON.stringify(response.body)).toContain('referencia');

      expect(await persistenceSnapshot(customerId)).toEqual(before);
    });

    it('conversión de cotización con fallo en el pago #2 -> 409; la Quote sigue PENDING y sin venta', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('90.00');
      const quoteId = await createQuote(customerId, productId);
      const sequenceBefore = await saleSequenceNumber();

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteId}`)
        .set('Cookie', sellerCookie)
        .send({
          payments: [
            { method: 'CASH', amount: '45.00' },
            { method: inactiveMethodCode, amount: '45.00' },
          ],
        });
      expect(response.status).toBe(409);

      const quote = await prisma.quote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(quote.status).toBe(QuoteStatus.PENDING);
      expect(await prisma.sale.count({ where: { quoteId } })).toBe(0);
      expect(await saleSequenceNumber()).toBe(sequenceBefore);
    });

    it('después de los fallos, el mismo lote válido sobre el producto inventariable confirma y descuenta stock una sola vez', async () => {
      const customerId = await createCustomer();
      const stockBefore = (
        await prisma.product.findUniqueOrThrow({
          where: { id: trackedProductId },
        })
      ).stockCurrent;

      const response = await postSale(sellerCookie, {
        customerId,
        items: [{ productId: trackedProductId, quantity: '2' }],
        payments: [
          { method: 'CASH', amount: '40.00' },
          { method: 'YAPE', amount: '30.00', reference: 'OP-OK' },
          { method: 'CARD', amount: '30.00', reference: 'VCH-OK' },
        ],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);

      const stockAfter = (
        await prisma.product.findUniqueOrThrow({
          where: { id: trackedProductId },
        })
      ).stockCurrent;
      expect(stockBefore.minus(stockAfter).toFixed(3)).toBe('2.000');
    });
  });

  // ====================================================================
  // Anulación de una venta confirmada con lote
  // ====================================================================
  describe('anulación de venta con lote', () => {
    it('ADMIN anula: los 3 pagos iniciales quedan CANCELLED (SALE_CANCELLATION) con su REVERSAL contable', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('250.00');
      const created = await postSale(sellerCookie, {
        customerId,
        items: [{ productId, quantity: '1' }],
        payments: BATCH_250,
      });
      expect(created.status).toBe(201);
      const sale = trackSale(created);

      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'R1-B2: anulación de venta con lote' });
      expect(cancelled.status).toBe(200);

      const rows = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(rows).toHaveLength(3);
      for (const payment of rows) {
        expect(payment.status).toBe(PaymentStatus.CANCELLED);
        expect(payment.cancellationSource).toBe(
          PaymentCancellationSource.SALE_CANCELLATION,
        );
        const entries = await prisma.accountingEntry.findMany({
          where: { sourceType: 'PAYMENT', sourceId: payment.id },
        });
        expect(entries.map((e) => e.eventType).sort()).toEqual([
          AccountingEventType.ORIGINAL,
          AccountingEventType.REVERSAL,
        ]);
      }
    });
  });
});
