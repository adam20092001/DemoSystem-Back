import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  LineDiscountType,
  Prisma,
  ProductStatus,
  QuoteStatus,
  RoleName,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
  UnitStatus,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import * as businessDateModule from '../common/date/business-date';
import { SettingsReader } from '../configuration/settings-reader.service';
import { CompanySettingsSnapshot } from '../configuration/types/company-settings-snapshot';
import ExcelJS from 'exceljs';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { PrismaService } from '../database/prisma.service';
import { StockMovementEngine } from '../inventory/stock-movement.engine';
import { PaymentEngine } from '../payments/payment.engine';
import { SaleAccessRequester } from './sale-access.policy';
import { SalesService } from './sales.service';

const ACTOR_ID = 'actor-1';
const CUSTOMER_ID = 'customer-1';
const PRODUCT_ID = 'product-1';
const PRODUCT_ID_2 = 'product-2';
const QUOTE_ID = 'quote-1';
const QUOTE_SELLER_ID = 'quote-seller-1';
const SALE_ID = 'sale-1';
// Permisos por vendedor (P2): solicitante = usuario autenticado. Con id
// ACTOR_ID, que es el vendedor de las filas fixture (ventas propias).
function asRole(role: RoleName, id: string = ACTOR_ID): SaleAccessRequester {
  return { id, role };
}
const FIXED_TODAY = '2026-03-15';

// ----------------------------------------------------------------------
// Fixtures
// ----------------------------------------------------------------------

function makeCustomerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CUSTOMER_ID,
    isGeneric: false,
    status: CustomerStatus.ACTIVE,
    customerStage: CustomerStage.CUSTOMER,
    customerType: CustomerType.PERSON,
    documentType: null,
    documentNumber: null,
    name: 'Cliente Uno',
    address: null,
    // NR-02A: default true para no alterar el comportamiento de ningún test
    // preexistente de este archivo (todos asumían crédito sin restricción,
    // el comportamiento histórico que la migración preserva para clientes
    // ya existentes). Los tests dedicados de NR-02A lo sobreescriben a
    // false explícitamente.
    creditEnabled: true,
    ...overrides,
  };
}

function makeGenericCustomerRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return makeCustomerRow({
    id: 'generic-customer',
    isGeneric: true,
    customerType: null,
    customerStage: CustomerStage.CUSTOMER,
    name: 'Público general',
    ...overrides,
  });
}

function makeProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    productId: PRODUCT_ID,
    sku: 'SKU-1',
    name: 'Producto Uno',
    salePrice: new Prisma.Decimal('10.00'),
    isInventoryTracked: true,
    stockCurrent: new Prisma.Decimal('50.000'),
    productStatus: ProductStatus.ACTIVE,
    categoryId: 'category-1',
    categoryStatus: CategoryStatus.ACTIVE,
    unitId: 'unit-1',
    unitCode: 'UND',
    unitName: 'Unidad',
    unitAbbreviation: 'und',
    unitStatus: UnitStatus.ACTIVE,
    allowDecimal: true,
    ...overrides,
  };
}

function makeQuoteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: QUOTE_ID,
    number: 'COT-000001',
    status: QuoteStatus.PENDING,
    customerId: CUSTOMER_ID,
    customerType: CustomerType.PERSON,
    customerDocumentType: null,
    customerDocumentNumber: null,
    customerName: 'Cliente Uno',
    customerAddress: null,
    sellerId: QUOTE_SELLER_ID,
    issueDate: new Date('2026-03-10T00:00:00.000Z'),
    expirationDate: new Date('2026-03-20T00:00:00.000Z'),
    subtotal: new Prisma.Decimal('10.00'),
    discountAmount: new Prisma.Decimal('0.00'),
    taxAmount: new Prisma.Decimal('0.00'),
    total: new Prisma.Decimal('10.00'),
    // Fase 11, Bloque B: contexto de moneda/impuesto copiado VERBATIM a Sale
    // en la conversión (nunca releído de CompanySettings).
    currencyCode: 'PEN',
    taxEnabled: false,
    taxRate: new Prisma.Decimal('18.00'),
    pricesIncludeTax: false,
    ...overrides,
  };
}

function makeQuoteItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    productId: PRODUCT_ID,
    productSku: 'SKU-1',
    productName: 'Producto Uno',
    unitCode: 'UND',
    unitName: 'Unidad',
    unitAbbreviation: 'und',
    quantity: new Prisma.Decimal('1.000'),
    unitPrice: new Prisma.Decimal('10.00'),
    lineTotal: new Prisma.Decimal('10.00'),
    // NR-03: sin descuento de línea por defecto en este fixture.
    discountType: null,
    discountValue: null,
    discountAmount: new Prisma.Decimal('0'),
    ...overrides,
  };
}

function makeSaleLockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SALE_ID,
    number: 'NV-000001',
    status: SaleStatus.ACTIVE,
    // P3: el SELECT ... FOR UPDATE de lockSale incluye seller_id.
    sellerId: ACTOR_ID,
    deliveryStatus: SaleDeliveryStatus.PENDING,
    subtotal: new Prisma.Decimal('10.00'),
    discountAmount: new Prisma.Decimal('0.00'),
    taxAmount: new Prisma.Decimal('0.00'),
    total: new Prisma.Decimal('10.00'),
    ...overrides,
  };
}

function makeSaleItemRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'sale-item-1',
    productId: PRODUCT_ID,
    productSku: 'SKU-1',
    productName: 'Producto Uno',
    unitCode: 'UND',
    unitName: 'Unidad',
    unitAbbreviation: 'und',
    quantity: new Prisma.Decimal('1.000'),
    unitPrice: new Prisma.Decimal('10.00'),
    lineTotal: new Prisma.Decimal('10.00'),
    // NR-03: sin descuento de línea por defecto en este fixture.
    discountType: null,
    discountValue: null,
    discountAmount: new Prisma.Decimal('0'),
    ...overrides,
  };
}

function makeSaleDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SALE_ID,
    number: 'NV-000001',
    status: SaleStatus.ACTIVE,
    paymentStatus: SalePaymentStatus.UNPAID,
    deliveryStatus: SaleDeliveryStatus.PENDING,
    customerId: CUSTOMER_ID,
    customerIsGeneric: false,
    customerType: CustomerType.PERSON,
    customerDocumentType: null,
    customerDocumentNumber: null,
    customerName: 'Cliente Uno',
    customerAddress: null,
    seller: {
      id: ACTOR_ID,
      username: 'admin',
      firstName: 'Ana',
      lastName: 'Admin',
    },
    quote: null,
    subtotal: new Prisma.Decimal('10.00'),
    discountAmount: new Prisma.Decimal('0.00'),
    taxAmount: new Prisma.Decimal('0.00'),
    total: new Prisma.Decimal('10.00'),
    // Fase 11, Bloque B: contexto de moneda/impuesto congelado con el snapshot comercial.
    currencyCode: 'PEN',
    taxEnabled: false,
    taxRate: new Prisma.Decimal('18.00'),
    pricesIncludeTax: true,
    paidAmount: new Prisma.Decimal('0.00'),
    balanceDue: new Prisma.Decimal('10.00'),
    items: [makeSaleItemRow()],
    payments: [],
    confirmedAt: new Date('2026-03-15T12:00:00.000Z'),
    cancelledAt: null,
    cancellationReason: null,
    cancelledBy: null,
    createdAt: new Date('2026-03-15T12:00:00.000Z'),
    updatedAt: new Date('2026-03-15T12:00:00.000Z'),
    ...overrides,
  };
}

function makeMovementRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'movement-1',
    productId: PRODUCT_ID,
    movementType: 'EXIT',
    origin: 'SALE',
    quantity: new Prisma.Decimal('1.000'),
    previousStock: new Prisma.Decimal('50.000'),
    newStock: new Prisma.Decimal('49.000'),
    createdAt: new Date('2026-03-15T12:00:00.000Z'),
    ...overrides,
  };
}

function makePaymentRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'payment-1',
    saleId: SALE_ID,
    method: 'CASH',
    amount: new Prisma.Decimal('10.00'),
    reference: null,
    status: 'ACTIVE',
    paidAt: new Date('2026-03-15T12:00:00.000Z'),
    createdBy: {
      id: ACTOR_ID,
      username: 'admin',
      firstName: 'Ana',
      lastName: 'Admin',
    },
    cancelledAt: null,
    cancellationReason: null,
    cancellationSource: null,
    cancelledBy: null,
    createdAt: new Date('2026-03-15T12:00:00.000Z'),
    updatedAt: new Date('2026-03-15T12:00:00.000Z'),
    ...overrides,
  };
}

// ----------------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------------

interface QueryRawRouterConfig {
  customer?: Record<string, unknown> | null;
  quote?: Record<string, unknown> | null;
  sale?: Record<string, unknown> | null;
  products?: Map<string, Record<string, unknown>>;
  // A0-review: moneda vigente de la empresa, para el lock + lectura de
  // company_settings que createFromQuote() toma antes de comparar contra
  // Quote.currencyCode. 'PEN' por defecto (coincide con el default de
  // makeQuoteRow()) para que los tests que no les interesa esta regla no
  // necesiten especificarlo.
  companySettingsCurrencyCode?: string;
}

/**
 * `$queryRaw` se enruta por el contenido literal del SQL (nunca por orden
 * de llamada): SalesService ejecuta varias consultas raw distintas dentro
 * de una misma transacción (cliente, producto por producto, cotización,
 * venta, configuración de la empresa), así que un único mockResolvedValue
 * no alcanza.
 */
function createQueryRawRouter(config: QueryRawRouterConfig) {
  return jest.fn((query: Prisma.Sql) => {
    const sqlText = query.strings.join(' ');
    if (sqlText.includes('FROM customers')) {
      return Promise.resolve(config.customer ? [config.customer] : []);
    }
    if (sqlText.includes('FROM quotes')) {
      return Promise.resolve(config.quote ? [config.quote] : []);
    }
    if (sqlText.includes('FROM company_settings')) {
      return Promise.resolve([
        { currencyCode: config.companySettingsCurrencyCode ?? 'PEN' },
      ]);
    }
    if (sqlText.includes('FROM sales')) {
      return Promise.resolve(config.sale ? [config.sale] : []);
    }
    if (sqlText.includes('FROM products')) {
      const productId = query.values[0] as string;
      const row = config.products?.get(productId);
      return Promise.resolve(row ? [row] : []);
    }
    return Promise.resolve([]);
  });
}

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
    sale: {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    quote: {
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    quoteItem: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    customer: {
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    inventoryMovement: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    payment: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    electronicDocument: {
      findFirst: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    sale: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    inventoryMovement: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function createSequenceServiceMock() {
  return { next: jest.fn<Promise<string>, [unknown, DocumentType]>() };
}

function createEngineMock() {
  return { apply: jest.fn<Promise<unknown>, [unknown, unknown]>() };
}

function createPaymentEngineMock() {
  return {
    register: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    sumActiveForSale: jest.fn<Promise<Prisma.Decimal>, [unknown, string]>(),
    recalculateSaleSummary: jest.fn<
      Promise<unknown>,
      [unknown, string, Prisma.Decimal]
    >(),
    cancel: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    cancelAllActiveForSale: jest.fn<Promise<unknown[]>, [unknown, unknown]>(),
  };
}

function createAccountingEngineMock() {
  return {
    postSaleRecognition: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    postPaymentCollection: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    reverseOriginalForSource: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

function makeSettingsSnapshot(
  overrides: Partial<CompanySettingsSnapshot> = {},
): CompanySettingsSnapshot {
  return {
    currencyCode: 'PEN',
    currencySymbol: 'S/',
    taxEnabled: false,
    taxRate: new Prisma.Decimal('18.00'),
    quoteValidityDays: 15,
    maxDiscountPercent: new Prisma.Decimal('100.00'),
    ...overrides,
  };
}

function createSettingsReaderMock() {
  return {
    getCurrent: jest.fn<Promise<CompanySettingsSnapshot>, [unknown?]>(),
  };
}

describe('SalesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let sequenceService: ReturnType<typeof createSequenceServiceMock>;
  let engine: ReturnType<typeof createEngineMock>;
  let paymentEngine: ReturnType<typeof createPaymentEngineMock>;
  let accountingEngine: ReturnType<typeof createAccountingEngineMock>;
  let settingsReader: ReturnType<typeof createSettingsReaderMock>;
  let service: SalesService;

  beforeEach(() => {
    jest
      .spyOn(businessDateModule, 'businessToday')
      .mockReturnValue(FIXED_TODAY);

    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    sequenceService = createSequenceServiceMock();
    sequenceService.next.mockResolvedValue('NV-000001');
    engine = createEngineMock();
    engine.apply.mockResolvedValue(makeMovementRow());
    paymentEngine = createPaymentEngineMock();
    paymentEngine.register.mockResolvedValue(makePaymentRow());
    paymentEngine.sumActiveForSale.mockResolvedValue(new Prisma.Decimal(0));
    paymentEngine.recalculateSaleSummary.mockResolvedValue({
      paymentStatus: SalePaymentStatus.PAID,
      paidAmount: new Prisma.Decimal(0),
      balanceDue: new Prisma.Decimal(0),
    });
    paymentEngine.cancel.mockResolvedValue(
      makePaymentRow({ status: 'CANCELLED' }),
    );
    paymentEngine.cancelAllActiveForSale.mockResolvedValue([]);
    accountingEngine = createAccountingEngineMock();
    accountingEngine.postSaleRecognition.mockResolvedValue({
      id: 'accounting-entry-1',
      sourceType: 'SALE',
      sourceId: SALE_ID,
      eventType: 'ORIGINAL',
    });
    accountingEngine.postPaymentCollection.mockResolvedValue({
      id: 'accounting-entry-2',
      sourceType: 'PAYMENT',
      sourceId: 'payment-1',
      eventType: 'ORIGINAL',
    });
    accountingEngine.reverseOriginalForSource.mockResolvedValue({
      id: 'accounting-entry-3',
      sourceType: 'SALE',
      sourceId: SALE_ID,
      eventType: 'REVERSAL',
    });
    settingsReader = createSettingsReaderMock();
    settingsReader.getCurrent.mockResolvedValue(makeSettingsSnapshot());

    service = new SalesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      sequenceService,
      engine as unknown as StockMovementEngine,
      paymentEngine as unknown as PaymentEngine,
      accountingEngine as unknown as AccountingEngine,
      settingsReader as unknown as SettingsReader,
      new ExcelExportService(),
    );

    prisma.tx.$queryRaw.mockImplementation(
      createQueryRawRouter({
        customer: makeCustomerRow(),
        quote: makeQuoteRow(),
        sale: makeSaleLockRow(),
        products: new Map([[PRODUCT_ID, makeProductRow()]]),
      }),
    );
    prisma.tx.sale.create.mockResolvedValue(makeSaleDetailRow());
    prisma.tx.sale.update.mockResolvedValue(makeSaleDetailRow());
    prisma.tx.sale.findUnique.mockResolvedValue(null);
    prisma.tx.quote.update.mockResolvedValue(makeQuoteRow());
    prisma.tx.quoteItem.findMany.mockResolvedValue([makeQuoteItemRow()]);
    prisma.tx.customer.update.mockResolvedValue(makeCustomerRow());
    prisma.tx.inventoryMovement.findMany.mockResolvedValue([]);
    prisma.tx.payment.findMany.mockResolvedValue([makePaymentRow()]);
    // A0.3: por defecto, sin comprobante electrónico ACEPTADO — las
    // pruebas de cancel() que sí necesitan uno lo sobrescriben.
    prisma.tx.electronicDocument.findFirst.mockResolvedValue(null);
    prisma.inventoryMovement.findMany.mockResolvedValue([]);
    prisma.sale.findUnique.mockResolvedValue(makeSaleDetailRow());
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const validDirectInput = {
    customerId: CUSTOMER_ID,
    items: [{ productId: PRODUCT_ID, quantity: '1' }],
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
  };

  // ====================================================================
  // createDirect
  // ====================================================================
  describe('createDirect', () => {
    it('crea correctamente y devuelve SafeSale', async () => {
      const result = await service.createDirect(validDirectInput);
      expect(result.id).toBe(SALE_ID);
    });

    it('A0-review: bloquea company_settings (FOR UPDATE) antes de leer currencyCode, para cerrar la carrera con A0.2', async () => {
      await service.createDirect(validDirectInput);
      const lockCall = prisma.tx.$queryRaw.mock.calls.find((call) =>
        call[0].strings.join(' ').includes('company_settings'),
      );
      expect(lockCall).toBeDefined();
      expect((lockCall?.[0] as Prisma.Sql).strings.join(' ')).toContain(
        'FOR UPDATE',
      );
      expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
    });

    it('Fase 11, Bloque B: snapshotea currencyCode/taxEnabled/taxRate con el MISMO settings ya leído para taxAmount, sin una segunda lectura', async () => {
      settingsReader.getCurrent.mockResolvedValue(
        makeSettingsSnapshot({
          currencyCode: 'USD',
          taxEnabled: true,
          taxRate: new Prisma.Decimal('20.00'),
        }),
      );
      await service.createDirect(validDirectInput);
      const createArgs = prisma.tx.sale.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.currencyCode).toBe('USD');
      expect(createArgs.data.taxEnabled).toBe(true);
      expect(createArgs.data.taxRate).toEqual(new Prisma.Decimal('20.00'));
      expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
    });

    it.each([true, false])(
      'R2-B4: toda venta directa nueva fija pricesIncludeTax=true (semántica, no si el IGV está activo) — taxEnabled=%s',
      async (taxEnabled) => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ taxEnabled }),
        );
        await service.createDirect(validDirectInput);
        const createArgs = prisma.tx.sale.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(createArgs.data.pricesIncludeTax).toBe(true);
      },
    );

    describe('R2-B4 — pagos iniciales y deuda contra el total con IGV incluido', () => {
      beforeEach(() => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
          }),
        );
      });

      it('pago que cubre el total con IGV incluido (10.00): PAID; nunca exige 11.80', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('10.00'),
        );
        await service.createDirect({
          ...validDirectInput,
          payments: [
            { method: 'CASH', amount: '6.00' },
            { method: 'YAPE', amount: '4.00', reference: 'OP-1' },
          ],
        });
        const created = prisma.tx.sale.create.mock.calls[0][0] as {
          data: { paymentStatus: string; balanceDue: Prisma.Decimal };
        };
        expect(created.data.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(created.data.balanceDue.toFixed(2)).toBe('0.00');
      });

      it('sobrepago evaluado contra el total real: 10.01 -> 409 sin insertar la venta', async () => {
        await expect(
          service.createDirect({
            ...validDirectInput,
            payment: { method: 'CASH', amount: '10.01' },
          }),
        ).rejects.toThrow(
          'El monto del pago inicial no puede superar el total de la venta',
        );
        expect(prisma.tx.sale.create).not.toHaveBeenCalled();
      });

      it('Público general paga exactamente el total con IGV incluido (10.00): éxito', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeGenericCustomerRow(),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('10.00'),
        );
        await expect(
          service.createDirect({
            ...validDirectInput,
            customerId: 'generic-customer',
            payment: { method: 'CASH', amount: '10.00' },
          }),
        ).resolves.toBeDefined();
      });

      it('pago parcial de cliente elegible sobre el total con IGV incluido: PARTIALLY_PAID 4.00/6.00', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('4.00'),
        );
        await service.createDirect({
          ...validDirectInput,
          payment: { method: 'CASH', amount: '4.00' },
        });
        const created = prisma.tx.sale.create.mock.calls[0][0] as {
          data: { paymentStatus: string; balanceDue: Prisma.Decimal };
        };
        expect(created.data.paymentStatus).toBe(
          SalePaymentStatus.PARTIALLY_PAID,
        );
        expect(created.data.balanceDue.toFixed(2)).toBe('6.00');
      });
    });

    it('items vacíos -> 400 sin abrir transacción', async () => {
      await expect(
        service.createDirect({ ...validDirectInput, items: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('producto duplicado -> 400 antes de abrir transacción', async () => {
      await expect(
        service.createDirect({
          ...validDirectInput,
          items: [
            { productId: PRODUCT_ID, quantity: '1' },
            { productId: PRODUCT_ID, quantity: '2' },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    describe('elegibilidad de cliente', () => {
      it('cliente inexistente -> 404', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: null,
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('cliente INACTIVE -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({ status: CustomerStatus.INACTIVE }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('cliente ACTIVE con total positivo: UNPAID permitido', async () => {
        const result = await service.createDirect(validDirectInput);
        expect(result).toBeDefined();
      });

      it('cliente PROSPECT es elegible', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({
              customerStage: CustomerStage.PROSPECT,
            }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).resolves.toBeDefined();
      });

      it('cliente CUSTOMER es elegible', async () => {
        await expect(
          service.createDirect(validDirectInput),
        ).resolves.toBeDefined();
      });

      it('Público general con total positivo -> 409, sin generar NV', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeGenericCustomerRow(),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(sequenceService.next).not.toHaveBeenCalled();
      });

      it('Público general con total cero es permitido (producto de precio 0)', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeGenericCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ salePrice: new Prisma.Decimal('0.00') }),
              ],
            ]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).resolves.toBeDefined();
      });

      it('BLOCKED con total positivo -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({ status: CustomerStatus.BLOCKED }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('BLOCKED con total cero es permitido', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({ status: CustomerStatus.BLOCKED }),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ salePrice: new Prisma.Decimal('0.00') }),
              ],
            ]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).resolves.toBeDefined();
      });

      it('la sonda no bloqueada de Público general no re-consulta con FOR UPDATE (una sola llamada $queryRaw para el cliente)', async () => {
        const router = createQueryRawRouter({
          customer: makeGenericCustomerRow(),
          products: new Map([
            [
              PRODUCT_ID,
              makeProductRow({ salePrice: new Prisma.Decimal('0.00') }),
            ],
          ]),
        });
        prisma.tx.$queryRaw.mockImplementation(router);
        await service.createDirect(validDirectInput);
        const customerCalls = prisma.tx.$queryRaw.mock.calls.filter((call) =>
          call[0].strings.join(' ').includes('FROM customers'),
        );
        expect(customerCalls).toHaveLength(1);
      });

      it('cliente no genérico se bloquea con dos consultas (sonda + FOR UPDATE)', async () => {
        await service.createDirect(validDirectInput);
        const customerCalls = prisma.tx.$queryRaw.mock.calls.filter((call) =>
          call[0].strings.join(' ').includes('FROM customers'),
        );
        expect(customerCalls).toHaveLength(2);
        expect(customerCalls[1][0].strings.join(' ')).toContain('FOR UPDATE');
      });
    });

    describe('elegibilidad de producto', () => {
      it('producto inexistente -> 404', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map(),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('producto INACTIVE -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ productStatus: ProductStatus.INACTIVE }),
              ],
            ]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('categoría INACTIVE -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ categoryStatus: CategoryStatus.INACTIVE }),
              ],
            ]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('unidad INACTIVE -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ unitStatus: UnitStatus.INACTIVE })],
            ]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('producto (PRODUCT) inventariable admitido', async () => {
        await expect(
          service.createDirect(validDirectInput),
        ).resolves.toBeDefined();
      });

      it('producto no inventariable (isInventoryTracked=false): sin StockMovementEngine.apply y deliveryStatus NOT_APPLICABLE', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ isInventoryTracked: false })],
            ]),
          }),
        );
        prisma.tx.sale.create.mockResolvedValue(
          makeSaleDetailRow({
            deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
          }),
        );
        await service.createDirect(validDirectInput);
        expect(engine.apply).not.toHaveBeenCalled();
      });
    });

    describe('cantidades y unidad', () => {
      it('allowDecimal=false con cantidad fraccionaria -> 400', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ allowDecimal: false })],
            ]),
          }),
        );
        await expect(
          service.createDirect({
            ...validDirectInput,
            items: [{ productId: PRODUCT_ID, quantity: '1.5' }],
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('allowDecimal=false con cantidad entera -> OK', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ allowDecimal: false })],
            ]),
          }),
        );
        await expect(
          service.createDirect({
            ...validDirectInput,
            items: [{ productId: PRODUCT_ID, quantity: '2' }],
          }),
        ).resolves.toBeDefined();
      });

      it.each(['0', '-1', '1e3', '1,5', '1.2345'])(
        'cantidad malformada (%s) -> 400',
        async (quantity) => {
          await expect(
            service.createDirect({
              ...validDirectInput,
              items: [{ productId: PRODUCT_ID, quantity }],
            }),
          ).rejects.toBeInstanceOf(BadRequestException);
        },
      );
    });

    describe('precio/snapshot/totales', () => {
      it('unitPrice = Product.salePrice VIGENTE, nunca del cliente', async () => {
        const result = await service.createDirect(validDirectInput);
        expect(result.items[0].unitPrice).toBe('10.00');
      });

      it('snapshot de sku/nombre/unidad copiado del producto vigente', async () => {
        const result = await service.createDirect(validDirectInput);
        expect(result.items[0].productSku).toBe('SKU-1');
        expect(result.items[0].unitCode).toBe('UND');
      });

      it('descuento > subtotal -> 400', async () => {
        await expect(
          service.createDirect({
            ...validDirectInput,
            discountAmount: '999.00',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('sin descuento -> discountAmount 0.00', async () => {
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as { data: { discountAmount: Prisma.Decimal } };
          expect(created.data.discountAmount.toFixed(2)).toBe('0.00');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createDirect(validDirectInput);
      });

      describe('Bloque 10, B — descuento máximo configurado (venta DIRECTA)', () => {
        it('SettingsReader.getCurrent(tx) se llama exactamente una vez', async () => {
          await service.createDirect(validDirectInput);
          expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
          expect(settingsReader.getCurrent).toHaveBeenCalledWith(prisma.tx);
        });

        it('descuento por debajo del límite: permitido', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              maxDiscountPercent: new Prisma.Decimal('10.00'),
            }),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '0.50',
            }),
          ).resolves.toBeDefined();
        });

        it('descuento exactamente en el límite: permitido', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              maxDiscountPercent: new Prisma.Decimal('10.00'),
            }),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '1.00',
            }),
          ).resolves.toBeDefined();
        });

        it('descuento por encima del límite: 400', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              maxDiscountPercent: new Prisma.Decimal('10.00'),
            }),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '1.01',
            }),
          ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('max = 100%: descuento total del subtotal permitido', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              maxDiscountPercent: new Prisma.Decimal('100.00'),
            }),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '10.00',
            }),
          ).resolves.toBeDefined();
        });

        it('max = 0: cualquier descuento positivo se rechaza', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              maxDiscountPercent: new Prisma.Decimal('0.00'),
            }),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '0.01',
            }),
          ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('caso Decimal exacto, sin error de redondeo de punto flotante', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              maxDiscountPercent: new Prisma.Decimal('33.33'),
            }),
          );
          // subtotal 10.00 * 33.33% -> límite exacto 3.333; un descuento de
          // 3.33 (máximo representable en Decimal(14,2)) queda por debajo.
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '3.33',
            }),
          ).resolves.toBeDefined();
        });

        it('no cambia el comportamiento de impuestos: taxAmount sigue en 0.00', async () => {
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as { data: { taxAmount: Prisma.Decimal } };
            expect(created.data.taxAmount.toFixed(2)).toBe('0.00');
            return Promise.resolve(makeSaleDetailRow());
          });
          await service.createDirect(validDirectInput);
        });
      });

      describe('Bloque 10, C — IGV en la venta DIRECTA', () => {
        it('taxEnabled=false -> taxAmount 0.00', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({ taxEnabled: false }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
            };
            expect(created.data.taxAmount.toFixed(2)).toBe('0.00');
            expect(created.data.total.toFixed(2)).toBe('10.00');
            return Promise.resolve(makeSaleDetailRow());
          });
          await service.createDirect(validDirectInput);
        });

        it('R2-B4: taxEnabled=true, 18%: el IGV se DESGLOSA del precio final (10.00 -> 8.47 + 1.53), nunca se suma encima', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
            }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: {
                subtotal: Prisma.Decimal;
                taxAmount: Prisma.Decimal;
                total: Prisma.Decimal;
              };
            };
            expect(created.data.subtotal.toFixed(2)).toBe('8.47');
            expect(created.data.taxAmount.toFixed(2)).toBe('1.53');
            expect(created.data.total.toFixed(2)).toBe('10.00');
            return Promise.resolve(makeSaleDetailRow());
          });
          await service.createDirect(validDirectInput);
        });

        it('R2-B4: el descuento recibido es sobre el precio FINAL; se persiste su equivalente antes de impuesto', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
            }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: {
                subtotal: Prisma.Decimal;
                discountAmount: Prisma.Decimal;
                taxAmount: Prisma.Decimal;
                total: Prisma.Decimal;
              };
            };
            // total = 10.00 - 2.00 = 8.00; base 6.78; IGV 1.22;
            // descuento persistido = ROUND(2.00/1.18) = 1.69; subtotal 8.47.
            expect(created.data.total.toFixed(2)).toBe('8.00');
            expect(created.data.taxAmount.toFixed(2)).toBe('1.22');
            expect(created.data.discountAmount.toFixed(2)).toBe('1.69');
            expect(created.data.subtotal.toFixed(2)).toBe('8.47');
            return Promise.resolve(makeSaleDetailRow());
          });
          await service.createDirect({
            ...validDirectInput,
            discountAmount: '2.00',
          });
        });

        it('interacción con el máximo configurado: descuento válido bajo el límite con IGV activo', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
              maxDiscountPercent: new Prisma.Decimal('10.00'),
            }),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '1.00',
            }),
          ).resolves.toBeDefined();
        });

        it('interacción con el máximo configurado: descuento por encima del límite se rechaza incluso con IGV activo', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
              maxDiscountPercent: new Prisma.Decimal('10.00'),
            }),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '1.01',
            }),
          ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('descuento total -> taxableBase 0 -> taxAmount 0.00, sin anomalía', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
              maxDiscountPercent: new Prisma.Decimal('100.00'),
            }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
            };
            expect(created.data.taxAmount.toFixed(2)).toBe('0.00');
            expect(created.data.total.toFixed(2)).toBe('0.00');
            return Promise.resolve(makeSaleDetailRow());
          });
          await service.createDirect({
            ...validDirectInput,
            discountAmount: '10.00',
          });
        });

        it('R2-B4: redondeo Decimal determinista HALF_UP (base exactamente en la mitad)', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('100.00'),
            }),
          );
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow(),
              quote: makeQuoteRow(),
              sale: makeSaleLockRow(),
              products: new Map([
                [
                  PRODUCT_ID,
                  makeProductRow({ salePrice: new Prisma.Decimal('0.05') }),
                ],
              ]),
            }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: { subtotal: Prisma.Decimal; taxAmount: Prisma.Decimal };
            };
            // 0.05 / 2 = 0.025 -> HALF_UP -> 0.03 (nunca 0.02 de HALF_EVEN);
            // IGV por residuo = 0.02.
            expect(created.data.subtotal.toFixed(2)).toBe('0.03');
            expect(created.data.taxAmount.toFixed(2)).toBe('0.02');
            return Promise.resolve(makeSaleDetailRow());
          });
          await service.createDirect(validDirectInput);
        });

        it('R2-B4: tasa del 10%: 10.00 final -> base 9.09, IGV 0.91', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('10.00'),
            }),
          );
          await service.createDirect(validDirectInput);
          const created = prisma.tx.sale.create.mock.calls[0][0] as {
            data: Record<string, Prisma.Decimal>;
          };
          expect(created.data.subtotal.toFixed(2)).toBe('9.09');
          expect(created.data.taxAmount.toFixed(2)).toBe('0.91');
          expect(created.data.total.toFixed(2)).toBe('10.00');
        });

        it('R2-B4: 118.00 al 18% -> unitPrice/lineTotal 118.00, subtotal 100.00, IGV 18.00, total 118.00', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
            }),
          );
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow(),
              quote: makeQuoteRow(),
              sale: makeSaleLockRow(),
              products: new Map([
                [
                  PRODUCT_ID,
                  makeProductRow({ salePrice: new Prisma.Decimal('118.00') }),
                ],
              ]),
            }),
          );
          await service.createDirect(validDirectInput);
          const created = prisma.tx.sale.create.mock.calls[0][0] as {
            data: Record<string, unknown> & {
              items: {
                create: {
                  unitPrice: Prisma.Decimal;
                  lineTotal: Prisma.Decimal;
                }[];
              };
            };
          };
          expect(created.data.items.create[0].unitPrice.toFixed(2)).toBe(
            '118.00',
          );
          expect(created.data.items.create[0].lineTotal.toFixed(2)).toBe(
            '118.00',
          );
          expect((created.data.subtotal as Prisma.Decimal).toFixed(2)).toBe(
            '100.00',
          );
          expect(
            (created.data.discountAmount as Prisma.Decimal).toFixed(2),
          ).toBe('0.00');
          expect((created.data.taxAmount as Prisma.Decimal).toFixed(2)).toBe(
            '18.00',
          );
          expect((created.data.total as Prisma.Decimal).toFixed(2)).toBe(
            '118.00',
          );
          expect(created.data.pricesIncludeTax).toBe(true);
        });

        it('R2-B4: 118.00 con descuento 11.80 -> subtotal 100.00, descuento 10.00, IGV 16.20, total 106.20', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
            }),
          );
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow(),
              quote: makeQuoteRow(),
              sale: makeSaleLockRow(),
              products: new Map([
                [
                  PRODUCT_ID,
                  makeProductRow({ salePrice: new Prisma.Decimal('118.00') }),
                ],
              ]),
            }),
          );
          await service.createDirect({
            ...validDirectInput,
            discountAmount: '11.80',
          });
          const created = prisma.tx.sale.create.mock.calls[0][0] as {
            data: Record<string, Prisma.Decimal>;
          };
          expect(created.data.subtotal.toFixed(2)).toBe('100.00');
          expect(created.data.discountAmount.toFixed(2)).toBe('10.00');
          expect(created.data.taxAmount.toFixed(2)).toBe('16.20');
          expect(created.data.total.toFixed(2)).toBe('106.20');
        });

        it('R2-B4: IGV desactivado: total = precio final, IGV 0.00, indicador true', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({ taxEnabled: false }),
          );
          await service.createDirect(validDirectInput);
          const created = prisma.tx.sale.create.mock.calls[0][0] as {
            data: Record<string, unknown>;
          };
          expect((created.data.total as Prisma.Decimal).toFixed(2)).toBe(
            '10.00',
          );
          expect((created.data.taxAmount as Prisma.Decimal).toFixed(2)).toBe(
            '0.00',
          );
          expect(created.data.pricesIncludeTax).toBe(true);
        });

        it('R2-B4: descuento por encima del total de ítems -> 400 sin insertar la venta', async () => {
          await expect(
            service.createDirect({
              ...validDirectInput,
              discountAmount: '10.01',
            }),
          ).rejects.toBeInstanceOf(BadRequestException);
          expect(prisma.tx.sale.create).not.toHaveBeenCalled();
        });

        it('R2-B4: invariante de cabecera (CHECK sales_total_arithmetic) en lo persistido', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
            }),
          );
          await service.createDirect({
            ...validDirectInput,
            discountAmount: '3.33',
          });
          const created = prisma.tx.sale.create.mock.calls[0][0] as {
            data: Record<string, Prisma.Decimal>;
          };
          const { subtotal, discountAmount, taxAmount, total } = created.data;
          expect(
            total.equals(subtotal.minus(discountAmount).plus(taxAmount)),
          ).toBe(true);
          expect(discountAmount.lessThanOrEqualTo(subtotal)).toBe(true);
          expect(taxAmount.greaterThanOrEqualTo(0)).toBe(true);
        });

        it('SettingsReader.getCurrent(tx) se llama exactamente una vez (mismo snapshot para descuento máximo e IGV)', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({ taxEnabled: true }),
          );
          await service.createDirect(validDirectInput);
          expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
        });
      });
    });

    describe('resumen de pago y estado de entrega', () => {
      it('total > 0 -> UNPAID, paidAmount 0.00, balanceDue = total', async () => {
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: {
              paymentStatus: SalePaymentStatus;
              paidAmount: Prisma.Decimal;
              balanceDue: Prisma.Decimal;
            };
          };
          expect(created.data.paymentStatus).toBe(SalePaymentStatus.UNPAID);
          expect(created.data.paidAmount.toFixed(2)).toBe('0.00');
          expect(created.data.balanceDue.toFixed(2)).toBe('10.00');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createDirect(validDirectInput);
      });

      it('total = 0 -> PAID, paidAmount 0.00, balanceDue 0.00', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ salePrice: new Prisma.Decimal('0.00') }),
              ],
            ]),
          }),
        );
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: {
              paymentStatus: SalePaymentStatus;
              paidAmount: Prisma.Decimal;
              balanceDue: Prisma.Decimal;
            };
          };
          expect(created.data.paymentStatus).toBe(SalePaymentStatus.PAID);
          expect(created.data.balanceDue.toFixed(2)).toBe('0.00');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createDirect(validDirectInput);
      });

      it('nunca produce PARTIALLY_PAID', async () => {
        const result = await service.createDirect(validDirectInput);
        expect(result.paymentStatus).not.toBe(SalePaymentStatus.PARTIALLY_PAID);
      });

      it('algún ítem inventariable -> deliveryStatus PENDING', async () => {
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: { deliveryStatus: SaleDeliveryStatus };
          };
          expect(created.data.deliveryStatus).toBe(SaleDeliveryStatus.PENDING);
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createDirect(validDirectInput);
      });

      it('ningún ítem inventariable -> deliveryStatus NOT_APPLICABLE', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ isInventoryTracked: false })],
            ]),
          }),
        );
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: { deliveryStatus: SaleDeliveryStatus };
          };
          expect(created.data.deliveryStatus).toBe(
            SaleDeliveryStatus.NOT_APPLICABLE,
          );
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createDirect(validDirectInput);
      });
    });

    describe('stock', () => {
      it('stock suficiente -> 201/OK', async () => {
        await expect(
          service.createDirect(validDirectInput),
        ).resolves.toBeDefined();
      });

      it('stock insuficiente -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ stockCurrent: new Prisma.Decimal('0.500') }),
              ],
            ]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('servicio/no inventariable nunca valida stock', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({
                  isInventoryTracked: false,
                  stockCurrent: new Prisma.Decimal('0.000'),
                }),
              ],
            ]),
          }),
        );
        await expect(
          service.createDirect(validDirectInput),
        ).resolves.toBeDefined();
      });
    });

    describe('orquestación de locks y secuencia', () => {
      it('bloquea los productos en orden ascendente de productId, independientemente del orden de entrada', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ productId: PRODUCT_ID })],
              [PRODUCT_ID_2, makeProductRow({ productId: PRODUCT_ID_2 })],
            ]),
          }),
        );
        await service.createDirect({
          ...validDirectInput,
          items: [
            { productId: PRODUCT_ID_2, quantity: '1' },
            { productId: PRODUCT_ID, quantity: '1' },
          ],
        });
        const productCalls = prisma.tx.$queryRaw.mock.calls.filter((call) =>
          call[0].strings.join(' ').includes('FROM products'),
        );
        const order = productCalls.map((call) =>
          call[0] === undefined ? undefined : call[0].values[0],
        );
        expect(order).toEqual([PRODUCT_ID, PRODUCT_ID_2]);
      });

      it('invoca StockMovementEngine.apply en orden ascendente de productId para los ítems inventariables', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ productId: PRODUCT_ID })],
              [PRODUCT_ID_2, makeProductRow({ productId: PRODUCT_ID_2 })],
            ]),
          }),
        );
        await service.createDirect({
          ...validDirectInput,
          items: [
            { productId: PRODUCT_ID_2, quantity: '1' },
            { productId: PRODUCT_ID, quantity: '1' },
          ],
        });
        const calledProductIds = engine.apply.mock.calls.map(
          (call) => (call[1] as { productId: string }).productId,
        );
        expect(calledProductIds).toEqual([PRODUCT_ID, PRODUCT_ID_2]);
      });

      it('la secuencia NV se obtiene solo después de toda la validación (elegibilidad de cliente falla antes)', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({ status: CustomerStatus.INACTIVE }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(service.createDirect(validDirectInput)).rejects.toThrow();
        expect(sequenceService.next).not.toHaveBeenCalled();
      });

      it('la secuencia NV se obtiene solo después de la validación de stock', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ stockCurrent: new Prisma.Decimal('0.000') }),
              ],
            ]),
          }),
        );
        await expect(service.createDirect(validDirectInput)).rejects.toThrow();
        expect(sequenceService.next).not.toHaveBeenCalled();
      });

      it('la secuencia NV usa la MISMA transacción (tx) y DocumentType.SALE', async () => {
        await service.createDirect(validDirectInput);
        expect(sequenceService.next).toHaveBeenCalledWith(
          prisma.tx,
          DocumentType.SALE,
        );
      });
    });

    describe('promoción PROSPECT', () => {
      it('cliente PROSPECT se promueve a CUSTOMER en la misma transacción', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({
              customerStage: CustomerStage.PROSPECT,
            }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await service.createDirect(validDirectInput);
        expect(prisma.tx.customer.update).toHaveBeenCalledWith({
          where: { id: CUSTOMER_ID },
          data: { customerStage: CustomerStage.CUSTOMER },
        });
      });

      it('CUSTOMER_STAGE_CHANGED se audita exactamente una vez con el contrato existente', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({
              customerStage: CustomerStage.PROSPECT,
            }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await service.createDirect(validDirectInput);
        const stageCalls = auditService.record.mock.calls.filter(
          (call) => call[0].action === AuditAction.CUSTOMER_STAGE_CHANGED,
        );
        expect(stageCalls).toHaveLength(1);
        expect(stageCalls[0][0].metadata).toEqual({
          previousStage: CustomerStage.PROSPECT,
          customerStage: CustomerStage.CUSTOMER,
        });
      });

      it('cliente ya CUSTOMER: sin update de etapa ni auditoría de cambio', async () => {
        await service.createDirect(validDirectInput);
        expect(prisma.tx.customer.update).not.toHaveBeenCalled();
        const stageCalls = auditService.record.mock.calls.filter(
          (call) => call[0].action === AuditAction.CUSTOMER_STAGE_CHANGED,
        );
        expect(stageCalls).toHaveLength(0);
      });

      it('cliente genérico nunca se promueve', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeGenericCustomerRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ salePrice: new Prisma.Decimal('0.00') }),
              ],
            ]),
          }),
        );
        await service.createDirect(validDirectInput);
        expect(prisma.tx.customer.update).not.toHaveBeenCalled();
      });

      it('venta fallida no promueve (stock insuficiente)', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({
              customerStage: CustomerStage.PROSPECT,
              status: CustomerStatus.ACTIVE,
            }),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ stockCurrent: new Prisma.Decimal('0.000') }),
              ],
            ]),
          }),
        );
        await expect(service.createDirect(validDirectInput)).rejects.toThrow();
        expect(prisma.tx.customer.update).not.toHaveBeenCalled();
      });
    });

    describe('actor / sellerId / auditoría', () => {
      it('sellerId = actorUserId en venta directa', async () => {
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as { data: { sellerId: string } };
          expect(created.data.sellerId).toBe(ACTOR_ID);
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createDirect(validDirectInput);
      });

      it('SALE_CONFIRMED se audita con source=DIRECT, sin quoteId, en la misma tx', async () => {
        await service.createDirect(validDirectInput);
        const saleConfirmedCall = auditService.record.mock.calls.find(
          (call) => call[0].action === AuditAction.SALE_CONFIRMED,
        );
        expect(saleConfirmedCall).toBeDefined();
        expect(saleConfirmedCall?.[0].metadata).toEqual({
          saleNumber: 'NV-000001',
          source: 'DIRECT',
          itemCount: 1,
        });
        expect(saleConfirmedCall?.[0].metadata).not.toHaveProperty('quoteId');
        expect(saleConfirmedCall?.[0].client).toBe(prisma.tx);
      });

      it('no genera ninguna acción de auditoría de Payment', async () => {
        await service.createDirect(validDirectInput);
        const actions = auditService.record.mock.calls.map(
          (call) => call[0].action,
        );
        expect(actions).not.toContain('PAYMENT_REGISTERED');
        expect(actions).not.toContain('PAYMENT_CANCELLED');
      });
    });

    // ==================================================================
    // Pago inicial (Fase 7, Bloque B)
    // ==================================================================
    describe('pago inicial', () => {
      it('sin payment: preserva exactamente el comportamiento de la Fase 6 (UNPAID/0.00/total)', async () => {
        await service.createDirect(validDirectInput);
        const call = prisma.tx.sale.create.mock.calls[0][0] as {
          data: {
            paymentStatus: string;
            paidAmount: Prisma.Decimal;
            balanceDue: Prisma.Decimal;
          };
        };
        expect(call.data.paymentStatus).toBe(SalePaymentStatus.UNPAID);
        expect(call.data.paidAmount.toFixed(2)).toBe('0.00');
        expect(call.data.balanceDue.toFixed(2)).toBe('10.00');
        expect(paymentEngine.register).not.toHaveBeenCalled();
      });

      it('pago parcial: Sale se INSERTA ya con el resumen final (PARTIALLY_PAID), antes de registrar el pago', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('4.00'),
        );
        await service.createDirect({
          ...validDirectInput,
          payment: { method: 'CASH', amount: '4.00' },
        });
        const call = prisma.tx.sale.create.mock.calls[0][0] as {
          data: {
            paymentStatus: string;
            paidAmount: Prisma.Decimal;
            balanceDue: Prisma.Decimal;
          };
        };
        expect(call.data.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
        expect(call.data.paidAmount.toFixed(2)).toBe('4.00');
        expect(call.data.balanceDue.toFixed(2)).toBe('6.00');
      });

      it('pago total: PAID/total/0.00', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('10.00'),
        );
        await service.createDirect({
          ...validDirectInput,
          payment: { method: 'CASH', amount: '10.00' },
        });
        const call = prisma.tx.sale.create.mock.calls[0][0] as {
          data: {
            paymentStatus: string;
            paidAmount: Prisma.Decimal;
            balanceDue: Prisma.Decimal;
          };
        };
        expect(call.data.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(call.data.paidAmount.toFixed(2)).toBe('10.00');
        expect(call.data.balanceDue.toFixed(2)).toBe('0.00');
      });

      it('pago inicial > total -> 409, sin llegar a insertar la venta', async () => {
        await expect(
          service.createDirect({
            ...validDirectInput,
            payment: { method: 'CASH', amount: '999.00' },
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.tx.sale.create).not.toHaveBeenCalled();
      });

      it('PaymentEngine.register se invoca DESPUÉS del INSERT de Sale, con el mismo tx', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('4.00'),
        );
        const callOrder: string[] = [];
        prisma.tx.sale.create.mockImplementation(() => {
          callOrder.push('sale.create');
          return Promise.resolve(makeSaleDetailRow());
        });
        paymentEngine.register.mockImplementation(() => {
          callOrder.push('payment.register');
          return Promise.resolve(makePaymentRow());
        });
        await service.createDirect({
          ...validDirectInput,
          payment: { method: 'CASH', amount: '4.00' },
        });
        expect(callOrder).toEqual(['sale.create', 'payment.register']);
        expect(paymentEngine.register).toHaveBeenCalledWith(
          prisma.tx,
          expect.objectContaining({
            saleId: SALE_ID,
            saleNumber: 'NV-000001',
            method: 'CASH',
            actorUserId: ACTOR_ID,
          }),
        );
      });

      it('reconcilia SUM(ACTIVE) contra el paidAmount calculado: desajuste -> 409 y no continúa (aborta antes de mover stock)', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('999.00'),
        );
        await expect(
          service.createDirect({
            ...validDirectInput,
            payment: { method: 'CASH', amount: '4.00' },
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(engine.apply).not.toHaveBeenCalled();
      });

      it('SalesService nunca emite PAYMENT_REGISTERED directamente (PaymentEngine es el único emisor)', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('4.00'),
        );
        await service.createDirect({
          ...validDirectInput,
          payment: { method: 'CASH', amount: '4.00' },
        });
        const actions = auditService.record.mock.calls.map(
          (call) => call[0].action,
        );
        expect(actions).not.toContain(AuditAction.PAYMENT_REGISTERED);
      });

      describe('R1 — lote `payments`', () => {
        const batchFor10 = [
          { method: 'CASH', amount: '4.00' },
          { method: 'YAPE', amount: '4.00', reference: 'OP-1' },
          { method: 'CARD', amount: '2.00', reference: 'VCH-1' },
        ];

        it('registra cada pago en SECUENCIA, en el orden recibido, con el mismo tx; PAID 10/0', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          let inFlight = 0;
          let maxInFlight = 0;
          paymentEngine.register.mockImplementation(async () => {
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await Promise.resolve();
            inFlight -= 1;
            return makePaymentRow();
          });

          await service.createDirect({
            ...validDirectInput,
            payments: batchFor10,
          });

          expect(maxInFlight).toBe(1);
          expect(paymentEngine.register).toHaveBeenCalledTimes(3);
          const commands = paymentEngine.register.mock.calls.map(
            ([tx, command]) => {
              expect(tx).toBe(prisma.tx);
              return command as {
                method: string;
                amount: Prisma.Decimal;
                reference: string | null;
              };
            },
          );
          expect(
            commands.map((c) => [c.method, c.amount.toFixed(2), c.reference]),
          ).toEqual([
            ['CASH', '4.00', null],
            ['YAPE', '4.00', 'OP-1'],
            ['CARD', '2.00', 'VCH-1'],
          ]);
          const call = prisma.tx.sale.create.mock.calls[0][0] as {
            data: {
              paymentStatus: string;
              paidAmount: Prisma.Decimal;
              balanceDue: Prisma.Decimal;
            };
          };
          expect(call.data.paymentStatus).toBe(SalePaymentStatus.PAID);
          expect(call.data.paidAmount.toFixed(2)).toBe('10.00');
          expect(call.data.balanceDue.toFixed(2)).toBe('0.00');
          expect(paymentEngine.sumActiveForSale).toHaveBeenCalledTimes(1);
        });

        it('método repetido en el lote: se admite y se registra dos veces', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await service.createDirect({
            ...validDirectInput,
            payments: [
              { method: 'CASH', amount: '6.00' },
              { method: 'CASH', amount: '4.00' },
            ],
          });
          expect(paymentEngine.register).toHaveBeenCalledTimes(2);
        });

        it('lote parcial con cliente elegible: PARTIALLY_PAID', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('7.00'),
          );
          await service.createDirect({
            ...validDirectInput,
            payments: [
              { method: 'CASH', amount: '5.00' },
              { method: 'YAPE', amount: '2.00', reference: 'OP-2' },
            ],
          });
          const call = prisma.tx.sale.create.mock.calls[0][0] as {
            data: { paymentStatus: string; balanceDue: Prisma.Decimal };
          };
          expect(call.data.paymentStatus).toBe(
            SalePaymentStatus.PARTIALLY_PAID,
          );
          expect(call.data.balanceDue.toFixed(2)).toBe('3.00');
        });

        it('suma del lote > total -> 409 sin insertar la venta ni registrar pagos', async () => {
          await expect(
            service.createDirect({
              ...validDirectInput,
              payments: [
                { method: 'CASH', amount: '6.00' },
                { method: 'CASH', amount: '4.01' },
              ],
            }),
          ).rejects.toThrow(
            new ConflictException(
              'El monto del pago inicial no puede superar el total de la venta',
            ),
          );
          expect(prisma.tx.sale.create).not.toHaveBeenCalled();
          expect(paymentEngine.register).not.toHaveBeenCalled();
        });

        it('`payment` y `payments` a la vez -> 400 sin abrir transacción', async () => {
          await expect(
            service.createDirect({
              ...validDirectInput,
              payment: { method: 'CASH', amount: '10.00' },
              payments: [{ method: 'CASH', amount: '10.00' }],
            }),
          ).rejects.toBeInstanceOf(BadRequestException);
          expect(prisma.$transaction).not.toHaveBeenCalled();
        });

        it('`payments` vacío -> 400 sin abrir transacción', async () => {
          await expect(
            service.createDirect({ ...validDirectInput, payments: [] }),
          ).rejects.toBeInstanceOf(BadRequestException);
          expect(prisma.$transaction).not.toHaveBeenCalled();
        });

        it.each([2, 3])(
          'falla del pago #%i: la excepción se propaga, no se registran los siguientes ni se mueve stock ni se audita la venta',
          async (failingPosition) => {
            let calls = 0;
            paymentEngine.register.mockImplementation(() => {
              calls += 1;
              if (calls === failingPosition) {
                return Promise.reject(
                  new ConflictException('El método de pago "X" está inactivo'),
                );
              }
              return Promise.resolve(makePaymentRow());
            });

            await expect(
              service.createDirect({
                ...validDirectInput,
                payments: batchFor10,
              }),
            ).rejects.toThrow('El método de pago "X" está inactivo');

            expect(paymentEngine.register).toHaveBeenCalledTimes(
              failingPosition,
            );
            expect(paymentEngine.sumActiveForSale).not.toHaveBeenCalled();
            expect(engine.apply).not.toHaveBeenCalled();
            const actions = auditService.record.mock.calls.map(
              (call) => call[0].action,
            );
            expect(actions).not.toContain(AuditAction.SALE_CONFIRMED);
          },
        );

        it('reconciliación SUM(ACTIVE) también aplica al lote: desajuste -> 409', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('9.99'),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              payments: batchFor10,
            }),
          ).rejects.toThrow(
            'Inconsistencia interna en el resumen de pago al confirmar la venta',
          );
          expect(engine.apply).not.toHaveBeenCalled();
        });

        it('un único pago vía `payments` equivale al `payment` singular', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await service.createDirect({
            ...validDirectInput,
            payments: [{ method: 'CASH', amount: '10.00' }],
          });
          expect(paymentEngine.register).toHaveBeenCalledTimes(1);
          expect(paymentEngine.register).toHaveBeenCalledWith(
            prisma.tx,
            expect.objectContaining({
              saleId: SALE_ID,
              method: 'CASH',
              reference: null,
              actorUserId: ACTOR_ID,
            }),
          );
        });
      });

      describe('Público general', () => {
        function genericInput(overrides: Record<string, unknown> = {}) {
          return {
            ...validDirectInput,
            customerId: 'generic-customer',
            ...overrides,
          };
        }

        beforeEach(() => {
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeGenericCustomerRow(),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
        });

        it('sin pago -> 409', async () => {
          await expect(
            service.createDirect(genericInput()),
          ).rejects.toBeInstanceOf(ConflictException);
        });

        it('pago parcial -> 409', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('4.00'),
          );
          await expect(
            service.createDirect(
              genericInput({ payment: { method: 'CASH', amount: '4.00' } }),
            ),
          ).rejects.toBeInstanceOf(ConflictException);
        });

        it('R1: lote incompleto -> 409 sin insertar la venta ni registrar pagos', async () => {
          await expect(
            service.createDirect(
              genericInput({
                payments: [
                  { method: 'CASH', amount: '4.00' },
                  { method: 'YAPE', amount: '5.00', reference: 'OP-3' },
                ],
              }),
            ),
          ).rejects.toThrow(
            'El cliente "Público general" no puede generar una venta con saldo pendiente',
          );
          expect(prisma.tx.sale.create).not.toHaveBeenCalled();
          expect(paymentEngine.register).not.toHaveBeenCalled();
        });

        it('R1: lote que salda el total -> éxito', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await expect(
            service.createDirect(
              genericInput({
                payments: [
                  { method: 'CASH', amount: '5.00' },
                  { method: 'YAPE', amount: '5.00', reference: 'OP-4' },
                ],
              }),
            ),
          ).resolves.toBeDefined();
          expect(paymentEngine.register).toHaveBeenCalledTimes(2);
        });

        it('pago total -> éxito', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await expect(
            service.createDirect(
              genericInput({ payment: { method: 'CASH', amount: '10.00' } }),
            ),
          ).resolves.toBeDefined();
        });
      });

      describe('cliente BLOCKED', () => {
        function blockedInput(overrides: Record<string, unknown> = {}) {
          return { ...validDirectInput, ...overrides };
        }

        beforeEach(() => {
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow({ status: CustomerStatus.BLOCKED }),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
        });

        it('sin pago -> 409', async () => {
          await expect(
            service.createDirect(blockedInput()),
          ).rejects.toBeInstanceOf(ConflictException);
        });

        it('pago parcial -> 409', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('4.00'),
          );
          await expect(
            service.createDirect(
              blockedInput({ payment: { method: 'CASH', amount: '4.00' } }),
            ),
          ).rejects.toBeInstanceOf(ConflictException);
        });

        it('pago total -> éxito', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await expect(
            service.createDirect(
              blockedInput({ payment: { method: 'CASH', amount: '10.00' } }),
            ),
          ).resolves.toBeDefined();
        });
      });

      describe('cliente ACTIVE identificado con crédito deshabilitado (NR-02A)', () => {
        function noCreditInput(overrides: Record<string, unknown> = {}) {
          return { ...validDirectInput, ...overrides };
        }

        beforeEach(() => {
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow({ creditEnabled: false }),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
        });

        it('sin pago -> 409, sin crear Sale ni registrar pagos', async () => {
          await expect(service.createDirect(noCreditInput())).rejects.toThrow(
            'Este cliente no tiene crédito habilitado: no puede generar una venta con saldo pendiente',
          );
          expect(prisma.tx.sale.create).not.toHaveBeenCalled();
          expect(paymentEngine.register).not.toHaveBeenCalled();
        });

        it('pago parcial -> 409', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('4.00'),
          );
          await expect(
            service.createDirect(
              noCreditInput({ payment: { method: 'CASH', amount: '4.00' } }),
            ),
          ).rejects.toBeInstanceOf(ConflictException);
        });

        it('pago total -> éxito (0 saldo pendiente nunca depende de creditEnabled)', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await expect(
            service.createDirect(
              noCreditInput({ payment: { method: 'CASH', amount: '10.00' } }),
            ),
          ).resolves.toBeDefined();
        });
      });

      describe('cliente ACTIVE identificado con crédito habilitado (NR-02A: comportamiento preservado)', () => {
        beforeEach(() => {
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow({ creditEnabled: true }),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
        });

        it('sin pago -> éxito (crédito habilitado admite saldo pendiente total)', async () => {
          await expect(
            service.createDirect(validDirectInput),
          ).resolves.toBeDefined();
          expect(paymentEngine.register).not.toHaveBeenCalled();
        });

        it('pago parcial -> éxito', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('4.00'),
          );
          await expect(
            service.createDirect({
              ...validDirectInput,
              payment: { method: 'CASH', amount: '4.00' },
            }),
          ).resolves.toBeDefined();
        });
      });
    });

    it('NR-03: la venta directa nunca admite descuento de línea; el ítem creado siempre persiste discountType/discountValue/discountAmount en null/null/0.00', async () => {
      await service.createDirect(validDirectInput);
      const created = prisma.tx.sale.create.mock.calls[0][0] as {
        data: {
          items: {
            create: {
              discountType: unknown;
              discountValue: unknown;
              discountAmount: Prisma.Decimal;
            }[];
          };
        };
      };
      expect(created.data.items.create[0].discountType).toBeNull();
      expect(created.data.items.create[0].discountValue).toBeNull();
      expect(created.data.items.create[0].discountAmount.toFixed(2)).toBe(
        '0.00',
      );
    });
  });

  // ====================================================================
  // createFromQuote
  // ====================================================================
  describe('createFromQuote', () => {
    // ADMIN por defecto: sin restricción de propiedad (comportamiento previo).
    const validConvertInput = {
      quoteId: QUOTE_ID,
      actorUserId: ACTOR_ID,
      actorRole: RoleName.ADMIN,
      ipAddress: '10.0.0.1',
    };

    it('cotización inexistente -> 404', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          quote: null,
          products: new Map([[PRODUCT_ID, makeProductRow()]]),
        }),
      );
      await expect(
        service.createFromQuote(validConvertInput),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('PENDING: conversión exitosa', async () => {
      await expect(
        service.createFromQuote(validConvertInput),
      ).resolves.toBeDefined();
    });

    it('Fase 11, Bloque B: copia taxEnabled/taxRate VERBATIM de Quote, incluso si CompanySettings vigente ya difiere en esos dos campos', async () => {
      // La cotización quedó snapshoteada con taxEnabled=true/taxRate=20.00;
      // CompanySettings vigente al momento de la conversión es distinto en
      // AMBOS (false/18.00) — nunca debe usarse, ni siquiera leerse, para
      // estos 2 campos. currencyCode SÍ se compara desde A0-review (ver el
      // describe dedicado más abajo), así que aquí coincide a propósito
      // (USD/USD) para aislar la aserción de taxEnabled/taxRate.
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          quote: makeQuoteRow({
            currencyCode: 'USD',
            taxEnabled: true,
            taxRate: new Prisma.Decimal('20.00'),
          }),
          products: new Map([[PRODUCT_ID, makeProductRow()]]),
          companySettingsCurrencyCode: 'USD',
        }),
      );
      await service.createFromQuote(validConvertInput);
      const createArgs = prisma.tx.sale.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.currencyCode).toBe('USD');
      expect(createArgs.data.taxEnabled).toBe(true);
      expect(createArgs.data.taxRate).toEqual(new Prisma.Decimal('20.00'));
      // D18 aprobado (Fase 6): la conversión NUNCA llama a SettingsReader
      // para el snapshot comercial/fiscal — ni siquiera para leerlo y
      // descartarlo. El chequeo de moneda de A0-review usa su propia
      // consulta $queryRaw dedicada, nunca SettingsReader.
      expect(settingsReader.getCurrent).not.toHaveBeenCalled();
    });

    describe('A0-review — protección de moneda en la conversión', () => {
      it('Quote.currencyCode distinto de la moneda vigente de la empresa -> 409, sin crear nada', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow({ currencyCode: 'PEN' }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
            companySettingsCurrencyCode: 'USD',
          }),
        );

        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.tx.sale.create).not.toHaveBeenCalled();
        expect(prisma.tx.quote.update).not.toHaveBeenCalled();
        expect(accountingEngine.postSaleRecognition).not.toHaveBeenCalled();
      });

      it('Quote.currencyCode igual a la moneda vigente -> conversión permitida', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow({ currencyCode: 'USD' }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
            companySettingsCurrencyCode: 'USD',
          }),
        );

        await expect(
          service.createFromQuote(validConvertInput),
        ).resolves.toBeDefined();
      });

      it('toma el lock explícito (FOR UPDATE) sobre company_settings antes de comparar', async () => {
        await service.createFromQuote(validConvertInput);

        const lockCall = prisma.tx.$queryRaw.mock.calls.find((call) =>
          call[0].strings.join(' ').includes('company_settings'),
        );
        expect(lockCall).toBeDefined();
        expect((lockCall?.[0] as Prisma.Sql).strings.join(' ')).toContain(
          'FOR UPDATE',
        );
      });
    });

    it.each([false, true])(
      'R2-B1: copia pricesIncludeTax=%s VERBATIM de la Quote (nunca lo decide la conversión)',
      async (pricesIncludeTax) => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow({ pricesIncludeTax }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await service.createFromQuote(validConvertInput);
        const createArgs = prisma.tx.sale.create.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(createArgs.data.pricesIncludeTax).toBe(pricesIncludeTax);
      },
    );

    it('ACCEPTED: conversión exitosa', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          quote: makeQuoteRow({ status: QuoteStatus.ACCEPTED }),
          products: new Map([[PRODUCT_ID, makeProductRow()]]),
        }),
      );
      await expect(
        service.createFromQuote(validConvertInput),
      ).resolves.toBeDefined();
    });

    it('REJECTED -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          quote: makeQuoteRow({ status: QuoteStatus.REJECTED }),
          products: new Map([[PRODUCT_ID, makeProductRow()]]),
        }),
      );
      await expect(
        service.createFromQuote(validConvertInput),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('EXPIRED derivado (vencida por fecha) -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          quote: makeQuoteRow({
            status: QuoteStatus.PENDING,
            expirationDate: new Date('2026-03-01T00:00:00.000Z'),
          }),
          products: new Map([[PRODUCT_ID, makeProductRow()]]),
        }),
      );
      await expect(
        service.createFromQuote(validConvertInput),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('EXPIRED almacenado -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          quote: makeQuoteRow({ status: QuoteStatus.EXPIRED }),
          products: new Map([[PRODUCT_ID, makeProductRow()]]),
        }),
      );
      await expect(
        service.createFromQuote(validConvertInput),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('CONVERTED -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          quote: makeQuoteRow({ status: QuoteStatus.CONVERTED }),
          products: new Map([[PRODUCT_ID, makeProductRow()]]),
        }),
      );
      await expect(
        service.createFromQuote(validConvertInput),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('ya existe una venta para esa cotización -> 409', async () => {
      prisma.tx.sale.findUnique.mockResolvedValue({ id: 'existing-sale' });
      await expect(
        service.createFromQuote(validConvertInput),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('bloquea la cotización con FOR UPDATE', async () => {
      await service.createFromQuote(validConvertInput);
      const quoteCall = prisma.tx.$queryRaw.mock.calls.find((call) =>
        call[0].strings.join(' ').includes('FROM quotes'),
      );
      expect(quoteCall).toBeDefined();
      expect((quoteCall?.[0] as Prisma.Sql).strings.join(' ')).toContain(
        'FOR UPDATE',
      );
    });

    it('usa businessToday() (America/Lima) para el estado efectivo', async () => {
      await service.createFromQuote(validConvertInput);
      expect(businessDateModule.businessToday).toHaveBeenCalled();
    });

    describe('cliente vigente', () => {
      it('cliente inexistente -> 404', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: null,
            quote: makeQuoteRow(),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('cliente INACTIVE -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({ status: CustomerStatus.INACTIVE }),
            quote: makeQuoteRow(),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('estado imposible: cliente vigente ahora genérico -> 409 seguro', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeGenericCustomerRow(),
            quote: makeQuoteRow(),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('BLOCKED con deuda positiva (total del Quote > 0) -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({ status: CustomerStatus.BLOCKED }),
            quote: makeQuoteRow(),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('customerIsGeneric siempre false en Sale desde cotización', async () => {
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as { data: { customerIsGeneric: boolean } };
          expect(created.data.customerIsGeneric).toBe(false);
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });
    });

    describe('promoción PROSPECT en conversión', () => {
      it('promueve al cliente vigente si es PROSPECT', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow({
              customerStage: CustomerStage.PROSPECT,
            }),
            quote: makeQuoteRow(),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await service.createFromQuote(validConvertInput);
        expect(prisma.tx.customer.update).toHaveBeenCalledWith({
          where: { id: CUSTOMER_ID },
          data: { customerStage: CustomerStage.CUSTOMER },
        });
      });
    });

    describe('elegibilidad de producto/unidad vigente', () => {
      it('producto inexistente -> 404', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow(),
            products: new Map(),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('categoría/unidad inactivas -> 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ unitStatus: UnitStatus.INACTIVE })],
            ]),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('allowDecimal vigente=false con cantidad históricamente fraccionaria -> 409 (no 400)', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ allowDecimal: false })],
            ]),
          }),
        );
        prisma.tx.quoteItem.findMany.mockResolvedValue([
          makeQuoteItemRow({ quantity: new Prisma.Decimal('1.500') }),
        ]);
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('stock vigente insuficiente -> 409, sin confiar en Quote.stockInfo', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ stockCurrent: new Prisma.Decimal('0.000') }),
              ],
            ]),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });

    describe('snapshot y montos copiados exactamente (nunca repreciados)', () => {
      it('copia exactamente productSku/productName/unitCode/unitName/unitAbbreviation/quantity/unitPrice/lineTotal del QuoteItem', async () => {
        prisma.tx.quoteItem.findMany.mockResolvedValue([
          makeQuoteItemRow({
            productSku: 'SKU-HISTORICO',
            productName: 'Nombre histórico',
            unitPrice: new Prisma.Decimal('7.77'),
            lineTotal: new Prisma.Decimal('7.77'),
          }),
        ]);
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: {
              items: {
                create: {
                  productSku: string;
                  productName: string;
                  unitPrice: Prisma.Decimal;
                }[];
              };
            };
          };
          expect(created.data.items.create[0].productSku).toBe('SKU-HISTORICO');
          expect(created.data.items.create[0].productName).toBe(
            'Nombre histórico',
          );
          expect(created.data.items.create[0].unitPrice.toFixed(2)).toBe(
            '7.77',
          );
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      it('el precio de línea del Quote se preserva aunque Product.salePrice vigente sea distinto', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow(),
            products: new Map([
              [
                PRODUCT_ID,
                makeProductRow({ salePrice: new Prisma.Decimal('999.99') }),
              ],
            ]),
          }),
        );
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: { items: { create: { unitPrice: Prisma.Decimal }[] } };
          };
          expect(created.data.items.create[0].unitPrice.toFixed(2)).toBe(
            '10.00',
          );
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      it('subtotal/discountAmount/taxAmount/total copiados EXACTAMENTE del Quote, nunca recalculados', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow({
              subtotal: new Prisma.Decimal('55.50'),
              discountAmount: new Prisma.Decimal('5.50'),
              taxAmount: new Prisma.Decimal('0.00'),
              total: new Prisma.Decimal('50.00'),
            }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: {
              subtotal: Prisma.Decimal;
              discountAmount: Prisma.Decimal;
              total: Prisma.Decimal;
            };
          };
          expect(created.data.subtotal.toFixed(2)).toBe('55.50');
          expect(created.data.discountAmount.toFixed(2)).toBe('5.50');
          expect(created.data.total.toFixed(2)).toBe('50.00');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      it('NR-03: discountType/discountValue/discountAmount/lineTotal del QuoteItem se copian EXACTOS al SaleItem (FIXED), nunca recalculados', async () => {
        prisma.tx.quoteItem.findMany.mockResolvedValue([
          makeQuoteItemRow({
            discountType: LineDiscountType.FIXED,
            discountValue: new Prisma.Decimal('3.00'),
            discountAmount: new Prisma.Decimal('3.00'),
            lineTotal: new Prisma.Decimal('7.00'),
          }),
        ]);
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: {
              items: {
                create: {
                  discountType: LineDiscountType;
                  discountValue: Prisma.Decimal;
                  discountAmount: Prisma.Decimal;
                  lineTotal: Prisma.Decimal;
                }[];
              };
            };
          };
          const createdItem = created.data.items.create[0];
          expect(createdItem.discountType).toBe(LineDiscountType.FIXED);
          expect(createdItem.discountValue.toFixed(2)).toBe('3.00');
          expect(createdItem.discountAmount.toFixed(2)).toBe('3.00');
          expect(createdItem.lineTotal.toFixed(2)).toBe('7.00');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      it('NR-03: descuento de línea PERCENT también se copia EXACTO al SaleItem, incluso si maxDiscountPercent vigente ya no lo permitiría', async () => {
        // maxDiscountPercent vigente al 0%: si la conversión recalculara el
        // descuento de línea (en vez de copiarlo), esta línea sería
        // rechazada. La conversión nunca llama a calculateLineDiscount(), así
        // que el valor histórico se preserva igual.
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('0.00'),
          }),
        );
        prisma.tx.quoteItem.findMany.mockResolvedValue([
          makeQuoteItemRow({
            discountType: LineDiscountType.PERCENT,
            discountValue: new Prisma.Decimal('20.00'),
            discountAmount: new Prisma.Decimal('2.00'),
            lineTotal: new Prisma.Decimal('8.00'),
          }),
        ]);
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: {
              items: {
                create: {
                  discountType: LineDiscountType;
                  discountValue: Prisma.Decimal;
                  discountAmount: Prisma.Decimal;
                  lineTotal: Prisma.Decimal;
                }[];
              };
            };
          };
          const createdItem = created.data.items.create[0];
          expect(createdItem.discountType).toBe(LineDiscountType.PERCENT);
          expect(createdItem.discountValue.toFixed(2)).toBe('20.00');
          expect(createdItem.discountAmount.toFixed(2)).toBe('2.00');
          expect(createdItem.lineTotal.toFixed(2)).toBe('8.00');
          return Promise.resolve(makeSaleDetailRow());
        });
        await expect(
          service.createFromQuote(validConvertInput),
        ).resolves.toBeDefined();
      });

      it('NR-03: sin descuento de línea en el QuoteItem de origen: el SaleItem también persiste null/null/0.00', async () => {
        prisma.tx.quoteItem.findMany.mockResolvedValue([makeQuoteItemRow()]);
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: {
              items: {
                create: {
                  discountType: unknown;
                  discountValue: unknown;
                  discountAmount: Prisma.Decimal;
                }[];
              };
            };
          };
          const createdItem = created.data.items.create[0];
          expect(createdItem.discountType).toBeNull();
          expect(createdItem.discountValue).toBeNull();
          expect(createdItem.discountAmount.toFixed(2)).toBe('0.00');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      describe('Bloque 10, B — sin revalidación de descuento máximo (D18 aprobado)', () => {
        it('cero llamadas a SettingsReader durante la conversión', async () => {
          await service.createFromQuote(validConvertInput);
          expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        });

        it('cotización con 50% de descuento (creada bajo max=100%) convierte con éxito aunque el max VIGENTE ahora sea 10%', async () => {
          // El max vigente configurado en settingsReader ni siquiera
          // importa aquí (no se consulta), pero se fija a un valor bajo
          // para demostrar que, si SE consultara, la conversión igual
          // fallaría contra un descuento del 50% — y sin embargo el test
          // demuestra que la conversión IGUAL tiene éxito.
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              maxDiscountPercent: new Prisma.Decimal('10.00'),
            }),
          );
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow(),
              quote: makeQuoteRow({
                subtotal: new Prisma.Decimal('100.00'),
                discountAmount: new Prisma.Decimal('50.00'),
                taxAmount: new Prisma.Decimal('0.00'),
                total: new Prisma.Decimal('50.00'),
              }),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: {
                subtotal: Prisma.Decimal;
                discountAmount: Prisma.Decimal;
                taxAmount: Prisma.Decimal;
                total: Prisma.Decimal;
              };
            };
            expect(created.data.subtotal.toFixed(2)).toBe('100.00');
            expect(created.data.discountAmount.toFixed(2)).toBe('50.00');
            expect(created.data.taxAmount.toFixed(2)).toBe('0.00');
            expect(created.data.total.toFixed(2)).toBe('50.00');
            return Promise.resolve(makeSaleDetailRow());
          });

          await expect(
            service.createFromQuote(validConvertInput),
          ).resolves.toBeDefined();
          expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        });
      });

      describe('Bloque 10, C — snapshot de IGV sin revalidación (§24/§25 aprobados)', () => {
        it('Quote con IGV no-cero (creada al 18%) convierte copiando taxAmount EXACTO, con settings VIGENTES en 10%', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('10.00'),
            }),
          );
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow(),
              quote: makeQuoteRow({
                subtotal: new Prisma.Decimal('100.00'),
                discountAmount: new Prisma.Decimal('10.00'),
                taxAmount: new Prisma.Decimal('16.20'),
                total: new Prisma.Decimal('106.20'),
              }),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: {
                subtotal: Prisma.Decimal;
                discountAmount: Prisma.Decimal;
                taxAmount: Prisma.Decimal;
                total: Prisma.Decimal;
              };
            };
            // Snapshot EXACTO del 18% original, nunca recalculado al 10% vigente.
            expect(created.data.subtotal.toFixed(2)).toBe('100.00');
            expect(created.data.discountAmount.toFixed(2)).toBe('10.00');
            expect(created.data.taxAmount.toFixed(2)).toBe('16.20');
            expect(created.data.total.toFixed(2)).toBe('106.20');
            return Promise.resolve(makeSaleDetailRow());
          });

          await expect(
            service.createFromQuote(validConvertInput),
          ).resolves.toBeDefined();
          // Cero llamadas a SettingsReader para el descuento/impuesto de la
          // conversión, sin importar que ConfigurationModule esté importado.
          expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        });

        it('cotización con base imponible cero (descuento total, IGV activo) convierte copiando taxAmount 0.00 exacto', async () => {
          settingsReader.getCurrent.mockResolvedValue(
            makeSettingsSnapshot({
              taxEnabled: true,
              taxRate: new Prisma.Decimal('18.00'),
            }),
          );
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow(),
              quote: makeQuoteRow({
                subtotal: new Prisma.Decimal('100.00'),
                discountAmount: new Prisma.Decimal('100.00'),
                taxAmount: new Prisma.Decimal('0.00'),
                total: new Prisma.Decimal('0.00'),
              }),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
          prisma.tx.sale.create.mockImplementation((args: unknown) => {
            const created = args as {
              data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
            };
            expect(created.data.taxAmount.toFixed(2)).toBe('0.00');
            expect(created.data.total.toFixed(2)).toBe('0.00');
            return Promise.resolve(makeSaleDetailRow());
          });

          await expect(
            service.createFromQuote(validConvertInput),
          ).resolves.toBeDefined();
          expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        });
      });
    });

    describe('sellerId / entrega / secuencia / auditoría', () => {
      it('sellerId = Quote.sellerId, nunca el actor que convierte', async () => {
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as { data: { sellerId: string } };
          expect(created.data.sellerId).toBe(QUOTE_SELLER_ID);
          expect(created.data.sellerId).not.toBe(ACTOR_ID);
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      it('deliveryStatus se deriva del seguimiento VIGENTE del producto', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow(),
            products: new Map([
              [PRODUCT_ID, makeProductRow({ isInventoryTracked: false })],
            ]),
          }),
        );
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as {
            data: { deliveryStatus: SaleDeliveryStatus };
          };
          expect(created.data.deliveryStatus).toBe(
            SaleDeliveryStatus.NOT_APPLICABLE,
          );
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      it('la secuencia NV se obtiene después de todas las validaciones', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            customer: makeCustomerRow(),
            quote: makeQuoteRow({ status: QuoteStatus.REJECTED }),
            products: new Map([[PRODUCT_ID, makeProductRow()]]),
          }),
        );
        await expect(
          service.createFromQuote(validConvertInput),
        ).rejects.toThrow();
        expect(sequenceService.next).not.toHaveBeenCalled();
      });

      it('crea la Sale con quoteId vinculado', async () => {
        prisma.tx.sale.create.mockImplementation((args: unknown) => {
          const created = args as { data: { quoteId: string } };
          expect(created.data.quoteId).toBe(QUOTE_ID);
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.createFromQuote(validConvertInput);
      });

      it('aplica movimientos SALE/EXIT ascendentes solo para ítems inventariables', async () => {
        await service.createFromQuote(validConvertInput);
        expect(engine.apply).toHaveBeenCalledWith(
          prisma.tx,
          expect.objectContaining({
            movementType: 'EXIT',
            origin: 'SALE',
            referenceType: 'Sale',
          }),
        );
      });

      it('marca la cotización como CONVERTED en la misma transacción', async () => {
        await service.createFromQuote(validConvertInput);
        expect(prisma.tx.quote.update).toHaveBeenCalledWith({
          where: { id: QUOTE_ID },
          data: { status: QuoteStatus.CONVERTED },
        });
      });

      it('audita SALE_CONFIRMED con source=QUOTE y quoteId', async () => {
        await service.createFromQuote(validConvertInput);
        const saleConfirmedCall = auditService.record.mock.calls.find(
          (call) => call[0].action === AuditAction.SALE_CONFIRMED,
        );
        expect(saleConfirmedCall?.[0].metadata).toEqual({
          saleNumber: 'NV-000001',
          source: 'QUOTE',
          quoteId: QUOTE_ID,
          itemCount: 1,
        });
      });

      it('audita QUOTE_CONVERTED con quoteNumber/saleNumber, entityType Quote', async () => {
        await service.createFromQuote(validConvertInput);
        const quoteConvertedCall = auditService.record.mock.calls.find(
          (call) => call[0].action === AuditAction.QUOTE_CONVERTED,
        );
        expect(quoteConvertedCall).toBeDefined();
        expect(quoteConvertedCall?.[0].entityType).toBe('Quote');
        expect(quoteConvertedCall?.[0].entityId).toBe(QUOTE_ID);
        expect(quoteConvertedCall?.[0].metadata).toEqual({
          quoteNumber: 'COT-000001',
          saleNumber: 'NV-000001',
        });
      });

      it('todas las escrituras (Sale/SaleItems/movimiento/Quote/auditorías) ocurren en la misma tx', async () => {
        await service.createFromQuote(validConvertInput);
        for (const call of auditService.record.mock.calls) {
          expect(call[0].client).toBe(prisma.tx);
        }
      });

      it('sin operaciones de Payment', async () => {
        await service.createFromQuote(validConvertInput);
        const actions = auditService.record.mock.calls.map(
          (call) => call[0].action,
        );
        expect(actions).not.toContain('PAYMENT_REGISTERED');
      });
    });

    // ==================================================================
    // Pago inicial (Fase 7, Bloque B)
    // ==================================================================
    describe('pago inicial', () => {
      it('sin payment: preserva el comportamiento previo (UNPAID/0.00/total copiado del Quote)', async () => {
        await service.createFromQuote(validConvertInput);
        const call = prisma.tx.sale.create.mock.calls[0][0] as {
          data: {
            paymentStatus: string;
            paidAmount: Prisma.Decimal;
            balanceDue: Prisma.Decimal;
          };
        };
        expect(call.data.paymentStatus).toBe(SalePaymentStatus.UNPAID);
        expect(call.data.paidAmount.toFixed(2)).toBe('0.00');
        expect(call.data.balanceDue.toFixed(2)).toBe('10.00');
      });

      it('pago total: PAID/total/0.00; nunca repriecia montos del Quote', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('10.00'),
        );
        await service.createFromQuote({
          ...validConvertInput,
          payment: { method: 'CASH', amount: '10.00' },
        });
        const call = prisma.tx.sale.create.mock.calls[0][0] as {
          data: {
            paymentStatus: string;
            paidAmount: Prisma.Decimal;
            balanceDue: Prisma.Decimal;
            subtotal: Prisma.Decimal;
            total: Prisma.Decimal;
          };
        };
        expect(call.data.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(call.data.paidAmount.toFixed(2)).toBe('10.00');
        expect(call.data.balanceDue.toFixed(2)).toBe('0.00');
        expect(call.data.subtotal.toFixed(2)).toBe('10.00');
        expect(call.data.total.toFixed(2)).toBe('10.00');
      });

      it('R1: lote `payments` que salda el Quote: PAID, cada pago en orden y en el mismo tx', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('10.00'),
        );
        await service.createFromQuote({
          ...validConvertInput,
          payments: [
            { method: 'CASH', amount: '6.00' },
            { method: 'YAPE', amount: '4.00', reference: 'OP-Q' },
          ],
        });
        expect(paymentEngine.register).toHaveBeenCalledTimes(2);
        expect(
          paymentEngine.register.mock.calls.map(
            ([tx, command]) =>
              tx === prisma.tx && (command as { method: string }).method,
          ),
        ).toEqual(['CASH', 'YAPE']);
        const call = prisma.tx.sale.create.mock.calls[0][0] as {
          data: { paymentStatus: string; total: Prisma.Decimal };
        };
        expect(call.data.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(call.data.total.toFixed(2)).toBe('10.00');
      });

      it('R1: suma del lote > total del Quote -> 409, Quote NO se convierte ni se registran pagos', async () => {
        await expect(
          service.createFromQuote({
            ...validConvertInput,
            payments: [
              { method: 'CASH', amount: '6.00' },
              { method: 'CASH', amount: '6.00' },
            ],
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(paymentEngine.register).not.toHaveBeenCalled();
        expect(prisma.tx.quote.update).not.toHaveBeenCalled();
      });

      describe('permisos por vendedor (P6-A)', () => {
        const OTHER_SELLER_ID = 'seller-other';

        function sellerConvert(
          actorUserId: string,
          payments: Record<string, unknown>,
        ) {
          return service.createFromQuote({
            ...validConvertInput,
            actorUserId,
            actorRole: RoleName.SELLER,
            ...payments,
          });
        }

        function expectNoConversionEffects() {
          expect(sequenceService.next).not.toHaveBeenCalled();
          expect(prisma.tx.sale.create).not.toHaveBeenCalled();
          expect(engine.apply).not.toHaveBeenCalled();
          expect(paymentEngine.register).not.toHaveBeenCalled();
          expect(prisma.tx.quote.update).not.toHaveBeenCalled();
          expect(auditService.record).not.toHaveBeenCalled();
          expect(accountingEngine.postSaleRecognition).not.toHaveBeenCalled();
        }

        async function expectQuoteNotFound(promise: Promise<unknown>) {
          const error = await promise.catch((e: unknown) => e);
          expect(error).toBeInstanceOf(NotFoundException);
          expect((error as NotFoundException).message).toBe(
            'La cotización no existe',
          );
        }

        it('SELLER convierte su propia cotización con `payment`: PAID; el pago lo registra el SELLER', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await sellerConvert(QUOTE_SELLER_ID, {
            payment: { method: 'CASH', amount: '10.00' },
          });
          expect(paymentEngine.register).toHaveBeenCalledWith(
            prisma.tx,
            expect.objectContaining({ actorUserId: QUOTE_SELLER_ID }),
          );
          expect(
            (
              prisma.tx.sale.create.mock.calls[0][0] as {
                data: { sellerId: string };
              }
            ).data.sellerId,
          ).toBe(QUOTE_SELLER_ID);
        });

        it('SELLER convierte su propia cotización con `payments[]`', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await sellerConvert(QUOTE_SELLER_ID, {
            payments: [
              { method: 'CASH', amount: '6.00' },
              { method: 'CASH', amount: '4.00' },
            ],
          });
          expect(paymentEngine.register).toHaveBeenCalledTimes(2);
        });

        it('SELLER con cotización ajena y `payment`: 404 "La cotización no existe", sin ningún efecto', async () => {
          await expectQuoteNotFound(
            sellerConvert(OTHER_SELLER_ID, {
              payment: { method: 'CASH', amount: '10.00' },
            }),
          );
          expectNoConversionEffects();
        });

        it('SELLER con cotización ajena y `payments[]`: 404 sin ningún efecto', async () => {
          await expectQuoteNotFound(
            sellerConvert(OTHER_SELLER_ID, {
              payments: [
                { method: 'CASH', amount: '6.00' },
                { method: 'CASH', amount: '4.00' },
              ],
            }),
          );
          expectNoConversionEffects();
        });

        it('cotización ajena ya CONVERTED o REJECTED con pagos: 404 (nunca el 409 que revelaría su estado)', async () => {
          for (const status of [QuoteStatus.CONVERTED, QuoteStatus.REJECTED]) {
            prisma.tx.$queryRaw.mockImplementation(
              createQueryRawRouter({
                customer: makeCustomerRow(),
                quote: makeQuoteRow({ status }),
                products: new Map([[PRODUCT_ID, makeProductRow()]]),
              }),
            );
            await expectQuoteNotFound(
              sellerConvert(OTHER_SELLER_ID, {
                payment: { method: 'CASH', amount: '10.00' },
              }),
            );
          }
          expectNoConversionEffects();
        });

        it('cotización inexistente con pagos: exactamente el mismo 404', async () => {
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow(),
              quote: null,
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
          await expectQuoteNotFound(
            sellerConvert(OTHER_SELLER_ID, {
              payment: { method: 'CASH', amount: '10.00' },
            }),
          );
        });

        it('P6-B2: SELLER con cotización ajena SIN pagos también recibe 404, sin ningún efecto (ya no es comportamiento heredado)', async () => {
          await expectQuoteNotFound(sellerConvert(OTHER_SELLER_ID, {}));
          expectNoConversionEffects();
        });

        it('P6-B2: SELLER convierte su propia cotización SIN pagos: venta a su nombre, sin pagos', async () => {
          await sellerConvert(QUOTE_SELLER_ID, {});
          expect(
            (
              prisma.tx.sale.create.mock.calls[0][0] as {
                data: { sellerId: string };
              }
            ).data.sellerId,
          ).toBe(QUOTE_SELLER_ID);
          expect(paymentEngine.register).not.toHaveBeenCalled();
        });

        it('ADMIN convierte una cotización ajena con pago: sellerId = vendedor de la cotización, pago registrado por el ADMIN', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await service.createFromQuote({
            ...validConvertInput,
            actorUserId: OTHER_SELLER_ID,
            actorRole: RoleName.ADMIN,
            payment: { method: 'CASH', amount: '10.00' },
          });
          expect(
            (
              prisma.tx.sale.create.mock.calls[0][0] as {
                data: { sellerId: string };
              }
            ).data.sellerId,
          ).toBe(QUOTE_SELLER_ID);
          expect(paymentEngine.register).toHaveBeenCalledWith(
            prisma.tx,
            expect.objectContaining({ actorUserId: OTHER_SELLER_ID }),
          );
        });

        it.each([RoleName.MANAGEMENT, RoleName.WAREHOUSE])(
          '%s con pagos: 404 sin efectos (sin permisos nuevos)',
          async (role) => {
            await expectQuoteNotFound(
              service.createFromQuote({
                ...validConvertInput,
                actorUserId: QUOTE_SELLER_ID,
                actorRole: role,
                payment: { method: 'CASH', amount: '10.00' },
              }),
            );
            expectNoConversionEffects();
          },
        );
      });

      it('R1: `payment` y `payments` a la vez -> 400 sin abrir transacción', async () => {
        await expect(
          service.createFromQuote({
            ...validConvertInput,
            payment: { method: 'CASH', amount: '10.00' },
            payments: [{ method: 'CASH', amount: '10.00' }],
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('R1: falla del segundo pago del lote -> la excepción se propaga y la Quote no se marca CONVERTED', async () => {
        paymentEngine.register
          .mockResolvedValueOnce(makePaymentRow())
          .mockRejectedValueOnce(new ConflictException('caja cerrada'));
        await expect(
          service.createFromQuote({
            ...validConvertInput,
            payments: [
              { method: 'CASH', amount: '6.00' },
              { method: 'YAPE', amount: '4.00', reference: 'OP-Q2' },
            ],
          }),
        ).rejects.toThrow('caja cerrada');
        expect(prisma.tx.quote.update).not.toHaveBeenCalled();
        expect(engine.apply).not.toHaveBeenCalled();
      });

      it('pago inicial > total del Quote -> 409, Quote NO se convierte', async () => {
        await expect(
          service.createFromQuote({
            ...validConvertInput,
            payment: { method: 'CASH', amount: '999.00' },
          }),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.tx.quote.update).not.toHaveBeenCalled();
      });

      describe('cliente BLOCKED', () => {
        beforeEach(() => {
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow({ status: CustomerStatus.BLOCKED }),
              quote: makeQuoteRow(),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
        });

        it('pago parcial -> 409, Quote no se convierte', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('4.00'),
          );
          await expect(
            service.createFromQuote({
              ...validConvertInput,
              payment: { method: 'CASH', amount: '4.00' },
            }),
          ).rejects.toBeInstanceOf(ConflictException);
          expect(prisma.tx.quote.update).not.toHaveBeenCalled();
        });

        it('pago total -> éxito, Quote se convierte', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await expect(
            service.createFromQuote({
              ...validConvertInput,
              payment: { method: 'CASH', amount: '10.00' },
            }),
          ).resolves.toBeDefined();
          expect(prisma.tx.quote.update).toHaveBeenCalled();
        });
      });

      describe('cliente ACTIVE identificado con crédito deshabilitado (NR-02A)', () => {
        beforeEach(() => {
          prisma.tx.$queryRaw.mockImplementation(
            createQueryRawRouter({
              customer: makeCustomerRow({ creditEnabled: false }),
              quote: makeQuoteRow(),
              products: new Map([[PRODUCT_ID, makeProductRow()]]),
            }),
          );
        });

        it('sin pago -> 409, Quote no se convierte (mismo mecanismo que venta directa: assertCustomerDebtRules)', async () => {
          await expect(
            service.createFromQuote(validConvertInput),
          ).rejects.toThrow(
            'Este cliente no tiene crédito habilitado: no puede generar una venta con saldo pendiente',
          );
          expect(prisma.tx.quote.update).not.toHaveBeenCalled();
        });

        it('pago parcial -> 409, Quote no se convierte', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('4.00'),
          );
          await expect(
            service.createFromQuote({
              ...validConvertInput,
              payment: { method: 'CASH', amount: '4.00' },
            }),
          ).rejects.toBeInstanceOf(ConflictException);
          expect(prisma.tx.quote.update).not.toHaveBeenCalled();
        });

        it('pago total -> éxito, Quote se convierte', async () => {
          paymentEngine.sumActiveForSale.mockResolvedValue(
            new Prisma.Decimal('10.00'),
          );
          await expect(
            service.createFromQuote({
              ...validConvertInput,
              payment: { method: 'CASH', amount: '10.00' },
            }),
          ).resolves.toBeDefined();
          expect(prisma.tx.quote.update).toHaveBeenCalled();
        });
      });

      it('sellerId sigue siendo Quote.sellerId, nunca el actor de la conversión, con o sin pago inicial', async () => {
        paymentEngine.sumActiveForSale.mockResolvedValue(
          new Prisma.Decimal('10.00'),
        );
        await service.createFromQuote({
          ...validConvertInput,
          payment: { method: 'CASH', amount: '10.00' },
        });
        const call = prisma.tx.sale.create.mock.calls[0][0] as {
          data: { sellerId: string };
        };
        expect(call.data.sellerId).toBe(QUOTE_SELLER_ID);
        expect(call.data.sellerId).not.toBe(ACTOR_ID);
      });
    });
  });

  // ====================================================================
  // cancel
  // ====================================================================
  describe('cancel', () => {
    const validCancelInput = {
      saleId: SALE_ID,
      reason: 'Cliente se arrepintió del pedido',
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    it('venta inexistente -> 404', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({ sale: null }),
      );
      await expect(service.cancel(validCancelInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('ya CANCELLED -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({ status: SaleStatus.CANCELLED }),
        }),
      );
      await expect(service.cancel(validCancelInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('bloquea la venta con FOR UPDATE', async () => {
      await service.cancel(validCancelInput);
      const saleCall = prisma.tx.$queryRaw.mock.calls.find((call) =>
        call[0].strings.join(' ').includes('FROM sales'),
      );
      expect((saleCall?.[0] as Prisma.Sql).strings.join(' ')).toContain(
        'FOR UPDATE',
      );
    });

    describe('A0.3 — comprobante electrónico (ampliado en la revisión previa al commit, opción B)', () => {
      it('comprobante bloqueante encontrado -> 409, sin ninguna mutación (stock, pagos, contabilidad, auditoría)', async () => {
        prisma.tx.electronicDocument.findFirst.mockResolvedValue({
          id: 'edoc-1',
        });

        await expect(service.cancel(validCancelInput)).rejects.toBeInstanceOf(
          ConflictException,
        );

        expect(engine.apply).not.toHaveBeenCalled();
        expect(paymentEngine.cancelAllActiveForSale).not.toHaveBeenCalled();
        expect(
          accountingEngine.reverseOriginalForSource,
        ).not.toHaveBeenCalled();
        expect(prisma.tx.sale.update).not.toHaveBeenCalled();
        expect(auditService.record).not.toHaveBeenCalled();
      });

      it('consulta el comprobante exclusivamente por saleId + status IN (CREATED, SUBMITTED, SUBMISSION_FAILED, ACCEPTED) — REJECTED explícitamente fuera', async () => {
        await service.cancel(validCancelInput);

        expect(prisma.tx.electronicDocument.findFirst).toHaveBeenCalledWith({
          where: {
            saleId: SALE_ID,
            status: {
              in: ['CREATED', 'SUBMITTED', 'SUBMISSION_FAILED', 'ACCEPTED'],
            },
          },
          select: { id: true },
        });
      });

      it('sin comprobante bloqueante (REJECTED, o inexistente): la anulación procede normalmente', async () => {
        prisma.tx.electronicDocument.findFirst.mockResolvedValue(null);

        await expect(service.cancel(validCancelInput)).resolves.toBeDefined();

        expect(prisma.tx.sale.update).toHaveBeenCalled();
      });
    });

    describe('normalización de motivo', () => {
      it('motivo vacío -> 400', async () => {
        await expect(
          service.cancel({ ...validCancelInput, reason: '' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('motivo solo espacios -> 400', async () => {
        await expect(
          service.cancel({ ...validCancelInput, reason: '   ' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('motivo > 200 caracteres -> 400', async () => {
        await expect(
          service.cancel({ ...validCancelInput, reason: 'a'.repeat(201) }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('recorta espacios perimetrales antes de persistir', async () => {
        prisma.tx.sale.update.mockImplementation((args: unknown) => {
          const updated = args as { data: { cancellationReason: string } };
          expect(updated.data.cancellationReason).toBe('Motivo con espacios');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.cancel({
          ...validCancelInput,
          reason: '  Motivo con espacios  ',
        });
      });
    });

    describe('reversa dirigida por movimientos originales', () => {
      it('consulta los movimientos SALE/EXIT originales por referencia', async () => {
        await service.cancel(validCancelInput);
        expect(prisma.tx.inventoryMovement.findMany).toHaveBeenCalledWith(
          expect.objectContaining({
            where: {
              referenceType: 'Sale',
              referenceId: SALE_ID,
              origin: 'SALE',
              movementType: 'EXIT',
            },
          }),
        );
      });

      it('no infiere la reversa del isInventoryTracked vigente del producto: usa las cantidades de los movimientos originales', async () => {
        prisma.tx.inventoryMovement.findMany.mockResolvedValueOnce([
          { productId: PRODUCT_ID, quantity: new Prisma.Decimal('3.000') },
        ]);
        await service.cancel(validCancelInput);
        expect(engine.apply).toHaveBeenCalledWith(
          prisma.tx,
          expect.objectContaining({
            productId: PRODUCT_ID,
            movementType: 'ENTRY',
            origin: 'SALE_CANCELLATION',
          }),
        );
        const call = engine.apply.mock.calls[0][1] as {
          quantity: Prisma.Decimal;
        };
        expect(call.quantity.toFixed(3)).toBe('3.000');
      });

      it('aplica las reversas en orden ascendente de productId', async () => {
        prisma.tx.inventoryMovement.findMany.mockResolvedValueOnce([
          { productId: PRODUCT_ID, quantity: new Prisma.Decimal('1.000') },
          { productId: PRODUCT_ID_2, quantity: new Prisma.Decimal('2.000') },
        ]);
        await service.cancel(validCancelInput);
        const calledProductIds = engine.apply.mock.calls.map(
          (call) => (call[1] as { productId: string }).productId,
        );
        expect(calledProductIds).toEqual([PRODUCT_ID, PRODUCT_ID_2]);
      });

      it('cada reversa usa la MISMA referencia (Sale/saleId) que el movimiento original', async () => {
        prisma.tx.inventoryMovement.findMany.mockResolvedValueOnce([
          { productId: PRODUCT_ID, quantity: new Prisma.Decimal('1.000') },
        ]);
        await service.cancel(validCancelInput);
        const call = engine.apply.mock.calls[0][1] as {
          referenceType: string;
          referenceId: string;
        };
        expect(call.referenceType).toBe('Sale');
        expect(call.referenceId).toBe(SALE_ID);
      });

      it('venta sin movimientos originales (todos los ítems no inventariables) igual se puede anular', async () => {
        prisma.tx.inventoryMovement.findMany.mockResolvedValue([]);
        await expect(service.cancel(validCancelInput)).resolves.toBeDefined();
        expect(engine.apply).not.toHaveBeenCalled();
      });

      it('el ajuste de stock resultante queda delegado por completo al motor (SalesService nunca escribe stockCurrent)', async () => {
        await service.cancel(validCancelInput);
        // SalesService no debe tener ninguna vía de escritura directa de producto.
        expect(
          (prisma.tx as unknown as { product?: unknown }).product,
        ).toBeUndefined();
      });
    });

    describe('campos de anulación / estado', () => {
      it('fija status=CANCELLED, cancelledAt, cancellationReason, cancelledByUserId', async () => {
        prisma.tx.sale.update.mockImplementation((args: unknown) => {
          const updated = args as {
            data: {
              status: SaleStatus;
              cancelledAt: Date;
              cancellationReason: string;
              cancelledByUserId: string;
            };
          };
          expect(updated.data.status).toBe(SaleStatus.CANCELLED);
          expect(updated.data.cancelledAt).toBeInstanceOf(Date);
          expect(updated.data.cancellationReason).toBe(validCancelInput.reason);
          expect(updated.data.cancelledByUserId).toBe(ACTOR_ID);
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.cancel(validCancelInput);
      });

      it('no toca paymentStatus/paidAmount/balanceDue/deliveryStatus', async () => {
        prisma.tx.sale.update.mockImplementation((args: unknown) => {
          const updated = args as { data: Record<string, unknown> };
          expect(updated.data).not.toHaveProperty('paymentStatus');
          expect(updated.data).not.toHaveProperty('paidAmount');
          expect(updated.data).not.toHaveProperty('balanceDue');
          expect(updated.data).not.toHaveProperty('deliveryStatus');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.cancel(validCancelInput);
      });

      it('no toca quoteId ni el estado de la cotización', async () => {
        await service.cancel(validCancelInput);
        expect(prisma.tx.quote.update).not.toHaveBeenCalled();
      });
    });

    it('audita SALE_CANCELLED con saleNumber/previousStatus=ACTIVE, sin el motivo', async () => {
      await service.cancel(validCancelInput);
      const call = auditService.record.mock.calls.find(
        (c) => c[0].action === AuditAction.SALE_CANCELLED,
      );
      expect(call?.[0].metadata).toEqual({
        saleNumber: 'NV-000001',
        previousStatus: SaleStatus.ACTIVE,
      });
      expect(call?.[0].client).toBe(prisma.tx);
    });

    // ==================================================================
    // Pagos (Fase 7, Bloque B)
    // ==================================================================
    describe('anulación de pagos activos', () => {
      it('invoca PaymentEngine.cancelAllActiveForSale con el mismo tx y el actor de la anulación', async () => {
        await service.cancel(validCancelInput);
        expect(paymentEngine.cancelAllActiveForSale).toHaveBeenCalledWith(
          prisma.tx,
          expect.objectContaining({
            saleId: SALE_ID,
            saleNumber: 'NV-000001',
            actorUserId: ACTOR_ID,
          }),
        );
      });

      it('se invoca ANTES de marcar la venta como CANCELLED', async () => {
        const callOrder: string[] = [];
        paymentEngine.cancelAllActiveForSale.mockImplementation(() => {
          callOrder.push('payments.cancelAll');
          return Promise.resolve([]);
        });
        prisma.tx.sale.update.mockImplementation(() => {
          callOrder.push('sale.update');
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.cancel(validCancelInput);
        expect(callOrder).toEqual(['payments.cancelAll', 'sale.update']);
      });

      it('NUNCA llama a PaymentEngine.recalculateSaleSummary (el resumen de pago queda congelado)', async () => {
        await service.cancel(validCancelInput);
        expect(paymentEngine.recalculateSaleSummary).not.toHaveBeenCalled();
      });

      it('SalesService nunca emite PAYMENT_CANCELLED directamente (PaymentEngine es el único emisor)', async () => {
        await service.cancel(validCancelInput);
        const actions = auditService.record.mock.calls.map(
          (call) => call[0].action,
        );
        expect(actions).not.toContain(AuditAction.PAYMENT_CANCELLED);
      });

      it('venta sin pagos activos: no-op válido, la anulación de la venta continúa normalmente', async () => {
        paymentEngine.cancelAllActiveForSale.mockResolvedValue([]);
        await expect(service.cancel(validCancelInput)).resolves.toBeDefined();
      });
    });
  });

  // ====================================================================
  // Entrega
  // ====================================================================
  describe('markDelivered', () => {
    // ADMIN por defecto: sin restricción de propiedad (comportamiento previo).
    const input = {
      saleId: SALE_ID,
      actorUserId: ACTOR_ID,
      actorRole: RoleName.ADMIN,
      ipAddress: null,
    };

    it.each([SaleDeliveryStatus.PENDING, SaleDeliveryStatus.OBSERVED])(
      '%s -> DELIVERED',
      async (current) => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            sale: makeSaleLockRow({ deliveryStatus: current }),
          }),
        );
        prisma.tx.sale.update.mockImplementation((args: unknown) => {
          const updated = args as {
            data: { deliveryStatus: SaleDeliveryStatus };
          };
          expect(updated.data.deliveryStatus).toBe(
            SaleDeliveryStatus.DELIVERED,
          );
          return Promise.resolve(makeSaleDetailRow());
        });
        await service.markDelivered(input);
      },
    );

    it('NOT_APPLICABLE -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({
            deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
          }),
        }),
      );
      await expect(service.markDelivered(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('DELIVERED -> 409 (ya entregada)', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({
            deliveryStatus: SaleDeliveryStatus.DELIVERED,
          }),
        }),
      );
      await expect(service.markDelivered(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('venta CANCELLED -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({ status: SaleStatus.CANCELLED }),
        }),
      );
      await expect(service.markDelivered(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('venta inexistente -> 404', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({ sale: null }),
      );
      await expect(service.markDelivered(input)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('bloquea la venta con FOR UPDATE', async () => {
      await service.markDelivered(input);
      const saleCall = prisma.tx.$queryRaw.mock.calls.find((call) =>
        call[0].strings.join(' ').includes('FROM sales'),
      );
      expect((saleCall?.[0] as Prisma.Sql).strings.join(' ')).toContain(
        'FOR UPDATE',
      );
    });

    it('audita SALE_DELIVERY_STATUS_CHANGED en la misma tx', async () => {
      await service.markDelivered(input);
      const call = auditService.record.mock.calls.find(
        (c) => c[0].action === AuditAction.SALE_DELIVERY_STATUS_CHANGED,
      );
      expect(call?.[0].metadata).toEqual({
        saleNumber: 'NV-000001',
        previousDeliveryStatus: SaleDeliveryStatus.PENDING,
        deliveryStatus: SaleDeliveryStatus.DELIVERED,
      });
      expect(call?.[0].client).toBe(prisma.tx);
    });

    it('no invoca al motor de inventario', async () => {
      await service.markDelivered(input);
      expect(engine.apply).not.toHaveBeenCalled();
    });

    describe('permisos por vendedor (P3)', () => {
      const OTHER_SELLER_ID = 'seller-other';

      function sellerInput(actorUserId: string) {
        return {
          saleId: SALE_ID,
          actorUserId,
          actorRole: RoleName.SELLER,
          ipAddress: null,
        };
      }

      function deliveryAudits() {
        return auditService.record.mock.calls.filter(
          (c) => c[0].action === AuditAction.SALE_DELIVERY_STATUS_CHANGED,
        );
      }

      it('SELLER entrega su propia venta: DELIVERED y auditoría con su actor.id', async () => {
        await expect(
          service.markDelivered(sellerInput(ACTOR_ID)),
        ).resolves.toBeDefined();
        expect(prisma.tx.sale.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { deliveryStatus: SaleDeliveryStatus.DELIVERED },
          }),
        );
        expect(deliveryAudits()).toHaveLength(1);
        expect(deliveryAudits()[0][0].userId).toBe(ACTOR_ID);
      });

      it('SELLER sobre una venta ajena: 404 "Venta no encontrada", sin update ni auditoría', async () => {
        const error = await service
          .markDelivered(sellerInput(OTHER_SELLER_ID))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
        expect(prisma.tx.sale.update).not.toHaveBeenCalled();
        expect(deliveryAudits()).toHaveLength(0);
        expect(engine.apply).not.toHaveBeenCalled();
      });

      it('venta inexistente: exactamente el mismo 404 que una ajena', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({ sale: null }),
        );
        const error = await service
          .markDelivered(sellerInput(OTHER_SELLER_ID))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
      });

      it('la propiedad se comprueba sobre la fila bloqueada (FOR UPDATE con seller_id) y antes de validar estado', async () => {
        // Venta ajena y además anulada: debe ganar el 404 (nunca el 409),
        // para no revelar el estado de una venta ajena.
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            sale: makeSaleLockRow({ status: SaleStatus.CANCELLED }),
          }),
        );
        await expect(
          service.markDelivered(sellerInput(OTHER_SELLER_ID)),
        ).rejects.toBeInstanceOf(NotFoundException);
        const saleCall = prisma.tx.$queryRaw.mock.calls.find((call) =>
          call[0].strings.join(' ').includes('FROM sales'),
        );
        const sql = (saleCall?.[0] as Prisma.Sql).strings.join(' ');
        expect(sql).toContain('seller_id');
        expect(sql).toContain('FOR UPDATE');
      });

      it('ADMIN entrega una venta de otro vendedor (operación existente) y la auditoría registra al ADMIN real', async () => {
        await service.markDelivered({
          saleId: SALE_ID,
          actorUserId: OTHER_SELLER_ID,
          actorRole: RoleName.ADMIN,
          ipAddress: null,
        });
        expect(prisma.tx.sale.update).toHaveBeenCalled();
        expect(deliveryAudits()[0][0].userId).toBe(OTHER_SELLER_ID);
      });

      it.each([RoleName.MANAGEMENT, RoleName.WAREHOUSE])(
        '%s no obtiene permiso de entrega (404, sin efectos), ni siquiera sobre una venta a su nombre',
        async (role) => {
          await expect(
            service.markDelivered({
              saleId: SALE_ID,
              actorUserId: ACTOR_ID,
              actorRole: role,
              ipAddress: null,
            }),
          ).rejects.toBeInstanceOf(NotFoundException);
          expect(prisma.tx.sale.update).not.toHaveBeenCalled();
          expect(deliveryAudits()).toHaveLength(0);
        },
      );

      it('la entrega nunca modifica sellerId: solo actualiza deliveryStatus', async () => {
        await service.markDelivered(sellerInput(ACTOR_ID));
        const updateArgs = prisma.tx.sale.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(updateArgs.data).toEqual({
          deliveryStatus: SaleDeliveryStatus.DELIVERED,
        });
        expect(updateArgs.data).not.toHaveProperty('sellerId');
      });

      it('las demás validaciones siguen vigentes para el dueño (DELIVERED -> 409)', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            sale: makeSaleLockRow({
              deliveryStatus: SaleDeliveryStatus.DELIVERED,
            }),
          }),
        );
        await expect(
          service.markDelivered(sellerInput(ACTOR_ID)),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });
  });

  describe('markObserved', () => {
    // ADMIN por defecto: sin restricción de propiedad (comportamiento previo).
    const input = {
      saleId: SALE_ID,
      actorUserId: ACTOR_ID,
      actorRole: RoleName.ADMIN,
      ipAddress: null,
    };

    it('PENDING -> OBSERVED', async () => {
      prisma.tx.sale.update.mockImplementation((args: unknown) => {
        const updated = args as {
          data: { deliveryStatus: SaleDeliveryStatus };
        };
        expect(updated.data.deliveryStatus).toBe(SaleDeliveryStatus.OBSERVED);
        return Promise.resolve(makeSaleDetailRow());
      });
      await service.markObserved(input);
    });

    it.each([
      SaleDeliveryStatus.OBSERVED,
      SaleDeliveryStatus.DELIVERED,
      SaleDeliveryStatus.NOT_APPLICABLE,
    ])('%s -> 409', async (current) => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({ deliveryStatus: current }),
        }),
      );
      await expect(service.markObserved(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('venta CANCELLED -> 409', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({ status: SaleStatus.CANCELLED }),
        }),
      );
      await expect(service.markObserved(input)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('venta inexistente -> 404', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({ sale: null }),
      );
      await expect(service.markObserved(input)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('no invoca al motor de inventario', async () => {
      await service.markObserved(input);
      expect(engine.apply).not.toHaveBeenCalled();
    });

    it('audita SALE_DELIVERY_STATUS_CHANGED con previousDeliveryStatus=PENDING', async () => {
      await service.markObserved(input);
      const call = auditService.record.mock.calls.find(
        (c) => c[0].action === AuditAction.SALE_DELIVERY_STATUS_CHANGED,
      );
      expect(call?.[0].metadata).toEqual({
        saleNumber: 'NV-000001',
        previousDeliveryStatus: SaleDeliveryStatus.PENDING,
        deliveryStatus: SaleDeliveryStatus.OBSERVED,
      });
    });

    describe('permisos por vendedor (P6-D)', () => {
      const OTHER_SELLER_ID = 'seller-other';

      function sellerInput(actorUserId: string) {
        return {
          saleId: SALE_ID,
          actorUserId,
          actorRole: RoleName.SELLER,
          ipAddress: null,
        };
      }

      function deliveryAudits() {
        return auditService.record.mock.calls.filter(
          (c) => c[0].action === AuditAction.SALE_DELIVERY_STATUS_CHANGED,
        );
      }

      it('1. SELLER observa su propia venta: OBSERVED y auditoría con su actor.id', async () => {
        await expect(
          service.markObserved(sellerInput(ACTOR_ID)),
        ).resolves.toBeDefined();
        expect(prisma.tx.sale.update).toHaveBeenCalledWith(
          expect.objectContaining({
            data: { deliveryStatus: SaleDeliveryStatus.OBSERVED },
          }),
        );
        expect(deliveryAudits()).toHaveLength(1);
        expect(deliveryAudits()[0][0].userId).toBe(ACTOR_ID);
      });

      it('2. SELLER intenta observar la venta del ADMIN (ajena): 404 "Venta no encontrada", sin update ni auditoría', async () => {
        const error = await service
          .markObserved(sellerInput(OTHER_SELLER_ID))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
        expect(prisma.tx.sale.update).not.toHaveBeenCalled();
        expect(deliveryAudits()).toHaveLength(0);
        expect(engine.apply).not.toHaveBeenCalled();
      });

      it('3. SELLER intenta observar la venta de OTRO SELLER (ajena): 404', async () => {
        const error = await service
          .markObserved(sellerInput(OTHER_SELLER_ID))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
      });

      it('4. venta inexistente: exactamente el mismo 404 que una ajena', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({ sale: null }),
        );
        const error = await service
          .markObserved(sellerInput(OTHER_SELLER_ID))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
      });

      it('5. venta ajena CANCELLED (estado inválido) sigue respondiendo 404, nunca 409', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            sale: makeSaleLockRow({ status: SaleStatus.CANCELLED }),
          }),
        );
        await expect(
          service.markObserved(sellerInput(OTHER_SELLER_ID)),
        ).rejects.toBeInstanceOf(NotFoundException);
      });

      it('6/7. la propiedad se comprueba sobre la fila bloqueada (FOR UPDATE con seller_id) y antes de validar estado', async () => {
        // Venta ajena y además en estado no transicionable: debe ganar el
        // 404 (nunca el 409), para no revelar el estado de una venta ajena.
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            sale: makeSaleLockRow({
              deliveryStatus: SaleDeliveryStatus.DELIVERED,
            }),
          }),
        );
        await expect(
          service.markObserved(sellerInput(OTHER_SELLER_ID)),
        ).rejects.toBeInstanceOf(NotFoundException);
        const saleCall = prisma.tx.$queryRaw.mock.calls.find((call) =>
          call[0].strings.join(' ').includes('FROM sales'),
        );
        const sql = (saleCall?.[0] as Prisma.Sql).strings.join(' ');
        expect(sql).toContain('seller_id');
        expect(sql).toContain('FOR UPDATE');
      });

      it('8. una denegación no modifica la venta, no invoca inventario ni audita', async () => {
        await expect(
          service.markObserved(sellerInput(OTHER_SELLER_ID)),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.tx.sale.update).not.toHaveBeenCalled();
        expect(engine.apply).not.toHaveBeenCalled();
        expect(deliveryAudits()).toHaveLength(0);
      });

      it('9/10. ADMIN observa una venta de otro vendedor (operación existente) y la auditoría registra al ADMIN real', async () => {
        await service.markObserved({
          saleId: SALE_ID,
          actorUserId: OTHER_SELLER_ID,
          actorRole: RoleName.ADMIN,
          ipAddress: null,
        });
        expect(prisma.tx.sale.update).toHaveBeenCalled();
        expect(deliveryAudits()[0][0].userId).toBe(OTHER_SELLER_ID);
      });

      it('11. la observación nunca modifica sellerId: solo actualiza deliveryStatus', async () => {
        await service.markObserved(sellerInput(ACTOR_ID));
        const updateArgs = prisma.tx.sale.update.mock.calls[0][0] as {
          data: Record<string, unknown>;
        };
        expect(updateArgs.data).toEqual({
          deliveryStatus: SaleDeliveryStatus.OBSERVED,
        });
        expect(updateArgs.data).not.toHaveProperty('sellerId');
      });

      it.each([RoleName.MANAGEMENT, RoleName.WAREHOUSE])(
        '12. %s no obtiene permiso de observación (404, sin efectos), ni siquiera sobre una venta a su nombre',
        async (role) => {
          await expect(
            service.markObserved({
              saleId: SALE_ID,
              actorUserId: ACTOR_ID,
              actorRole: role,
              ipAddress: null,
            }),
          ).rejects.toBeInstanceOf(NotFoundException);
          expect(prisma.tx.sale.update).not.toHaveBeenCalled();
          expect(deliveryAudits()).toHaveLength(0);
        },
      );

      it('13. las demás validaciones siguen vigentes para el dueño (OBSERVED -> 409)', async () => {
        prisma.tx.$queryRaw.mockImplementation(
          createQueryRawRouter({
            sale: makeSaleLockRow({
              deliveryStatus: SaleDeliveryStatus.OBSERVED,
            }),
          }),
        );
        await expect(
          service.markObserved(sellerInput(ACTOR_ID)),
        ).rejects.toBeInstanceOf(ConflictException);
      });
    });
  });

  // ====================================================================
  // list
  // ====================================================================
  describe('list', () => {
    beforeEach(() => {
      prisma.sale.findMany.mockResolvedValue([
        {
          id: SALE_ID,
          number: 'NV-000001',
          status: SaleStatus.ACTIVE,
          paymentStatus: SalePaymentStatus.UNPAID,
          deliveryStatus: SaleDeliveryStatus.PENDING,
          customerId: CUSTOMER_ID,
          customerName: 'Cliente Uno',
          customerDocumentNumber: null,
          sellerId: ACTOR_ID,
          seller: {
            id: ACTOR_ID,
            username: 'admin',
            firstName: 'Ana',
            lastName: 'Admin',
          },
          subtotal: new Prisma.Decimal('10.00'),
          discountAmount: new Prisma.Decimal('0.00'),
          taxAmount: new Prisma.Decimal('0.00'),
          total: new Prisma.Decimal('10.00'),
          currencyCode: 'PEN',
          taxEnabled: false,
          taxRate: new Prisma.Decimal('18.00'),
          paidAmount: new Prisma.Decimal('0.00'),
          balanceDue: new Prisma.Decimal('10.00'),
          confirmedAt: new Date('2026-03-15T12:00:00.000Z'),
          createdAt: new Date('2026-03-15T12:00:00.000Z'),
          updatedAt: new Date('2026-03-15T12:00:00.000Z'),
          _count: { items: 1 },
        },
      ]);
      prisma.sale.count.mockResolvedValue(1);
    });

    it('Fase 9, Bloque A (R1): incluye seller con identidad segura mínima exacta, sellerId se conserva', async () => {
      const result = await service.list({}, asRole(RoleName.ADMIN));
      const row = result.data[0];
      expect(row.sellerId).toBe(ACTOR_ID);
      expect(row.seller).toEqual({
        id: ACTOR_ID,
        username: 'admin',
        firstName: 'Ana',
        lastName: 'Admin',
      });
      expect(Object.keys(row.seller).sort()).toEqual(
        ['id', 'username', 'firstName', 'lastName'].sort(),
      );
      const serialized = JSON.stringify(row.seller);
      expect(serialized).not.toMatch(
        /email|role|status|passwordHash|mustChangePassword|failedLoginAttempts|blockedAt|lastLoginAt/i,
      );
    });

    it('ADMIN: consulta y devuelve resultados paginados', async () => {
      const result = await service.list({}, asRole(RoleName.ADMIN));
      expect(result.data).toHaveLength(1);
      expect(prisma.sale.findMany).toHaveBeenCalled();
    });

    it('SELLER: consulta restringida a sus propias ventas (P2)', async () => {
      await service.list({}, asRole(RoleName.SELLER));
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        where: unknown;
      };
      expect(args.where).toEqual({ AND: [{ sellerId: ACTOR_ID }, {}] });
    });

    describe('permisos por vendedor (P2)', () => {
      const OWN_SELLER_ID = 'seller-own';
      const OTHER_SELLER_ID = 'seller-other';
      const seller = asRole(RoleName.SELLER, OWN_SELLER_ID);

      function whereOf(call: 'findMany' | 'count'): unknown {
        return (prisma.sale[call].mock.calls[0][0] as { where: unknown }).where;
      }

      it('SELLER lista únicamente sus ventas: el alcance sellerId=actor viaja en el where de Prisma', async () => {
        await service.list({}, seller);
        expect(whereOf('findMany')).toEqual({
          AND: [{ sellerId: OWN_SELLER_ID }, {}],
        });
      });

      it('SELLER que omite sellerId sigue limitado a sus ventas', async () => {
        await service.list({ status: SaleStatus.ACTIVE }, seller);
        expect(whereOf('findMany')).toEqual({
          AND: [
            { sellerId: OWN_SELLER_ID },
            { AND: [{ status: SaleStatus.ACTIVE }] },
          ],
        });
      });

      it('SELLER que pide el sellerId de otro vendedor: condición insatisfacible (AND), nunca reemplaza su alcance', async () => {
        await service.list({ sellerId: OTHER_SELLER_ID }, seller);
        expect(whereOf('findMany')).toEqual({
          AND: [
            { sellerId: OWN_SELLER_ID },
            { AND: [{ sellerId: OTHER_SELLER_ID }] },
          ],
        });
      });

      it('SELLER no amplía su alcance con el OR de búsqueda (queda dentro del AND)', async () => {
        await service.list({ search: 'NV-' }, seller);
        const where = whereOf('findMany') as {
          AND: [Record<string, unknown>, { AND: { OR?: unknown }[] }];
        };
        expect(where.AND[0]).toEqual({ sellerId: OWN_SELLER_ID });
        expect(where.AND[1].AND.some((c) => c.OR !== undefined)).toBe(true);
      });

      it('el total de paginación usa exactamente el mismo where restringido', async () => {
        await service.list(
          { sellerId: OTHER_SELLER_ID, status: SaleStatus.ACTIVE },
          seller,
        );
        expect(whereOf('count')).toEqual(whereOf('findMany'));
        expect((whereOf('count') as { AND: unknown[] }).AND[0]).toEqual({
          sellerId: OWN_SELLER_ID,
        });
      });

      it('ADMIN lista ventas de cualquier vendedor: los filtros se aplican tal cual (sin alcance de propiedad)', async () => {
        await service.list(
          { sellerId: OTHER_SELLER_ID },
          asRole(RoleName.ADMIN, OWN_SELLER_ID),
        );
        expect(whereOf('findMany')).toEqual({
          AND: [{ sellerId: OTHER_SELLER_ID }],
        });
      });

      it('MANAGEMENT conserva la lectura completa', async () => {
        await service.list({}, asRole(RoleName.MANAGEMENT, OWN_SELLER_ID));
        expect(whereOf('findMany')).toEqual({});
      });
    });

    it('MANAGEMENT: consulta todas', async () => {
      await service.list({}, asRole(RoleName.MANAGEMENT));
      expect(prisma.sale.findMany).toHaveBeenCalled();
    });

    it('WAREHOUSE: página vacía SIN consultar Prisma', async () => {
      const result = await service.list({}, asRole(RoleName.WAREHOUSE));
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      expect(prisma.sale.count).not.toHaveBeenCalled();
    });

    it('rol desconocido: mismo comportamiento fail-closed que WAREHOUSE', async () => {
      const result = await service.list(
        {},
        asRole('UNKNOWN' as unknown as RoleName),
      );
      expect(result.data).toEqual([]);
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
    });

    it('paginación: página/límite por defecto', async () => {
      const result = await service.list({}, asRole(RoleName.ADMIN));
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('paginación: respeta límite máximo de 100', async () => {
      await service.list({ limit: 500 }, asRole(RoleName.ADMIN));
      const args = prisma.sale.findMany.mock.calls[0][0] as { take: number };
      expect(args.take).toBe(100);
    });

    it('filtra por status/paymentStatus/deliveryStatus/customerId/sellerId/quoteId', async () => {
      await service.list(
        {
          status: SaleStatus.ACTIVE,
          paymentStatus: SalePaymentStatus.UNPAID,
          deliveryStatus: SaleDeliveryStatus.PENDING,
          customerId: CUSTOMER_ID,
          sellerId: ACTOR_ID,
          quoteId: QUOTE_ID,
        },
        asRole(RoleName.ADMIN),
      );
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(args.where.AND).toContainEqual({ status: SaleStatus.ACTIVE });
      expect(args.where.AND).toContainEqual({
        paymentStatus: SalePaymentStatus.UNPAID,
      });
      expect(args.where.AND).toContainEqual({
        deliveryStatus: SaleDeliveryStatus.PENDING,
      });
      expect(args.where.AND).toContainEqual({ customerId: CUSTOMER_ID });
      expect(args.where.AND).toContainEqual({ sellerId: ACTOR_ID });
      expect(args.where.AND).toContainEqual({ quoteId: QUOTE_ID });
    });

    it('acepta PARTIALLY_PAID como filtro válido (compatibilidad Fase 7)', async () => {
      await expect(
        service.list(
          { paymentStatus: SalePaymentStatus.PARTIALLY_PAID },
          asRole(RoleName.ADMIN),
        ),
      ).resolves.toBeDefined();
    });

    it('confirmedFrom/confirmedTo se traducen a límites UTC de America/Lima', async () => {
      await service.list(
        { confirmedFrom: '2026-03-01', confirmedTo: '2026-03-31' },
        asRole(RoleName.ADMIN),
      );
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: { confirmedAt?: { gte?: Date; lt?: Date } }[] };
      };
      const gte = args.where.AND.find((c) => c.confirmedAt?.gte)?.confirmedAt
        ?.gte;
      const lt = args.where.AND.find((c) => c.confirmedAt?.lt)?.confirmedAt?.lt;
      expect(gte?.toISOString()).toBe('2026-03-01T05:00:00.000Z');
      expect(lt?.toISOString()).toBe('2026-04-01T05:00:00.000Z');
    });

    it('confirmedFrom > confirmedTo -> 400', async () => {
      await expect(
        service.list(
          { confirmedFrom: '2026-03-31', confirmedTo: '2026-03-01' },
          asRole(RoleName.ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirmedFrom con formato inválido -> 400', async () => {
      await expect(
        service.list({ confirmedFrom: '2026/03/01' }, asRole(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('búsqueda por número/nombre/documento (case-insensitive contains)', async () => {
      await service.list({ search: 'nv-000' }, asRole(RoleName.ADMIN));
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: { OR?: unknown[] }[] };
      };
      const orClause = args.where.AND.find((c) => c.OR)?.OR;
      expect(orClause).toEqual([
        { number: { contains: 'nv-000', mode: 'insensitive' } },
        { customerName: { contains: 'nv-000', mode: 'insensitive' } },
        { customerDocumentNumber: { contains: 'nv-000', mode: 'insensitive' } },
      ]);
    });

    it('búsqueda en blanco se omite (sin cláusula OR)', async () => {
      await service.list({ search: '   ' }, asRole(RoleName.ADMIN));
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] } | Record<string, never>;
      };
      expect(args.where).toEqual({});
    });

    it('orden fijo: confirmedAt desc, id desc', async () => {
      await service.list({}, asRole(RoleName.ADMIN));
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(args.orderBy).toEqual([{ confirmedAt: 'desc' }, { id: 'desc' }]);
    });

    it('findMany y count usan el mismo where', async () => {
      await service.list({ status: SaleStatus.ACTIVE }, asRole(RoleName.ADMIN));
      const findManyWhere = (
        prisma.sale.findMany.mock.calls[0][0] as { where: unknown }
      ).where;
      const countWhere = (
        prisma.sale.count.mock.calls[0][0] as { where: unknown }
      ).where;
      expect(findManyWhere).toEqual(countWhere);
    });

    it('la forma de lista nunca incluye items/inventoryMovements', async () => {
      const result = await service.list({}, asRole(RoleName.ADMIN));
      expect(result.data[0]).not.toHaveProperty('items');
      expect(result.data[0]).not.toHaveProperty('inventoryMovements');
      expect(result.data[0].itemCount).toBe(1);
    });
  });

  // ====================================================================
  // NR-06 — exportSalesXlsx
  // ====================================================================
  describe('exportSalesXlsx', () => {
    function makeExportRow(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        id: SALE_ID,
        number: 'NV-000001',
        status: SaleStatus.ACTIVE,
        paymentStatus: SalePaymentStatus.UNPAID,
        deliveryStatus: SaleDeliveryStatus.PENDING,
        customerId: CUSTOMER_ID,
        customerName: 'Cliente Uno',
        customerDocumentNumber: '20123456789',
        sellerId: ACTOR_ID,
        seller: {
          id: ACTOR_ID,
          username: 'admin',
          firstName: 'Ana',
          lastName: 'Admin',
        },
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal('16.20'),
        total: new Prisma.Decimal('106.20'),
        currencyCode: 'PEN',
        taxEnabled: true,
        taxRate: new Prisma.Decimal('18.00'),
        paidAmount: new Prisma.Decimal('50.00'),
        balanceDue: new Prisma.Decimal('56.20'),
        confirmedAt: new Date('2026-03-15T12:00:00.000Z'),
        createdAt: new Date('2026-03-15T12:00:00.000Z'),
        updatedAt: new Date('2026-03-15T12:00:00.000Z'),
        _count: { items: 3 },
        ...overrides,
      };
    }

    async function readFirstDataRow(buffer: Buffer) {
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- desajuste conocido entre Buffer<ArrayBufferLike> (@types/node reciente) y el Buffer no genérico de los tipos de exceljs; verificado en runtime, solo de tipos.
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      return { sheet, dataRow: sheet.getRow(2), headerRow: sheet.getRow(1) };
    }

    it('genera un .xlsx real con los encabezados exactos, en orden', async () => {
      prisma.sale.findMany.mockResolvedValue([makeExportRow()]);
      prisma.sale.count.mockResolvedValue(1);

      const buffer = await service.exportSalesXlsx({}, asRole(RoleName.ADMIN));
      const { headerRow } = await readFirstDataRow(buffer);
      const headers: unknown[] = [];
      headerRow.eachCell((cell) => headers.push(cell.value));
      expect(headers).toEqual([
        'Número',
        'Estado',
        'Estado de pago',
        'Estado de entrega',
        'Cliente',
        'Documento del cliente',
        'Vendedor',
        'Subtotal',
        'Descuento del documento',
        'IGV',
        'Total',
        'Moneda',
        'Pagado',
        'Saldo pendiente',
        'Cantidad de ítems',
        'Fecha de confirmación',
      ]);
    });

    it('usa los montos YA persistidos como celdas numéricas, sin recalcular nada', async () => {
      prisma.sale.findMany.mockResolvedValue([makeExportRow()]);
      prisma.sale.count.mockResolvedValue(1);

      const buffer = await service.exportSalesXlsx({}, asRole(RoleName.ADMIN));
      const { dataRow } = await readFirstDataRow(buffer);
      expect(dataRow.getCell(8).value).toBe(100); // Subtotal
      expect(dataRow.getCell(9).value).toBe(10); // Descuento
      expect(dataRow.getCell(10).value).toBe(16.2); // IGV
      expect(dataRow.getCell(11).value).toBe(106.2); // Total
      expect(dataRow.getCell(13).value).toBe(50); // Pagado
      expect(dataRow.getCell(14).value).toBe(56.2); // Saldo pendiente
      expect(dataRow.getCell(15).value).toBe(3); // Cantidad de ítems
    });

    it('reutiliza el alcance de list(): SELLER exporta solo sus propias ventas', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);

      await service.exportSalesXlsx({}, asRole(RoleName.SELLER));
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        where: unknown;
      };
      expect(args.where).toEqual({ AND: [{ sellerId: ACTOR_ID }, {}] });
    });

    it('resultado por encima del máximo (20 000): 400, sin construir ningún workbook ni pedir más páginas', async () => {
      prisma.sale.findMany.mockResolvedValue([makeExportRow()]);
      prisma.sale.count.mockResolvedValue(20001);

      await expect(
        service.exportSalesXlsx({}, asRole(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(BadRequestException);
      // Solo la primera página (para conocer el total) — nunca una segunda.
      expect(prisma.sale.findMany).toHaveBeenCalledTimes(1);
    });

    it('resultado exactamente en el máximo (20 000): permitido', async () => {
      prisma.sale.findMany.mockResolvedValue([makeExportRow()]);
      prisma.sale.count.mockResolvedValue(20000);

      await expect(
        service.exportSalesXlsx({}, asRole(RoleName.ADMIN)),
      ).resolves.toBeInstanceOf(Buffer);
    });

    it('más de una página de resultados: recorre todas en lotes, sin duplicar ni omitir', async () => {
      prisma.sale.findMany
        .mockResolvedValueOnce([
          makeExportRow({ id: 'sale-a', number: 'NV-A' }),
        ])
        .mockResolvedValueOnce([
          makeExportRow({ id: 'sale-b', number: 'NV-B' }),
        ]);
      prisma.sale.count.mockResolvedValue(101);

      const buffer = await service.exportSalesXlsx({}, asRole(RoleName.ADMIN));
      expect(prisma.sale.findMany).toHaveBeenCalledTimes(2);
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- desajuste conocido entre Buffer<ArrayBufferLike> (@types/node reciente) y el Buffer no genérico de los tipos de exceljs; verificado en runtime, solo de tipos.
      await workbook.xlsx.load(buffer as any);
      const sheet = workbook.worksheets[0];
      expect(sheet.rowCount).toBe(3); // encabezado + 2 filas
      expect(sheet.getRow(2).getCell(1).value).toBe('NV-A');
      expect(sheet.getRow(3).getCell(1).value).toBe('NV-B');
    });

    it('conjunto vacío: workbook válido con solo encabezado, sin lanzar', async () => {
      prisma.sale.findMany.mockResolvedValue([]);
      prisma.sale.count.mockResolvedValue(0);

      const buffer = await service.exportSalesXlsx({}, asRole(RoleName.ADMIN));
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- desajuste conocido entre Buffer<ArrayBufferLike> (@types/node reciente) y el Buffer no genérico de los tipos de exceljs; verificado en runtime, solo de tipos.
      await workbook.xlsx.load(buffer as any);
      expect(workbook.worksheets[0].rowCount).toBe(1);
    });

    it('WAREHOUSE (sin alcance de lectura de ventas): workbook vacío, sin tocar Prisma', async () => {
      const buffer = await service.exportSalesXlsx(
        {},
        asRole(RoleName.WAREHOUSE),
      );
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
      const workbook = new ExcelJS.Workbook();
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- desajuste conocido entre Buffer<ArrayBufferLike> (@types/node reciente) y el Buffer no genérico de los tipos de exceljs; verificado en runtime, solo de tipos.
      await workbook.xlsx.load(buffer as any);
      expect(workbook.worksheets[0].rowCount).toBe(1);
    });

    it('documento del cliente con ceros a la izquierda se conserva como texto', async () => {
      prisma.sale.findMany.mockResolvedValue([
        makeExportRow({ customerDocumentNumber: '00123456' }),
      ]);
      prisma.sale.count.mockResolvedValue(1);

      const buffer = await service.exportSalesXlsx({}, asRole(RoleName.ADMIN));
      const { dataRow } = await readFirstDataRow(buffer);
      expect(dataRow.getCell(6).value).toBe('00123456');
    });

    it('nombre de cliente con prefijo de fórmula se neutraliza en la celda', async () => {
      prisma.sale.findMany.mockResolvedValue([
        makeExportRow({ customerName: '=cmd|/C calc' }),
      ]);
      prisma.sale.count.mockResolvedValue(1);

      const buffer = await service.exportSalesXlsx({}, asRole(RoleName.ADMIN));
      const { dataRow } = await readFirstDataRow(buffer);
      expect(dataRow.getCell(5).value as string).toBe("'=cmd|/C calc");
    });
  });

  // ====================================================================
  // findOne
  // ====================================================================
  describe('findOne', () => {
    it('venta encontrada: devuelve SafeSale con movimientos', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([makeMovementRow()]);
      const result = await service.findOne(SALE_ID, asRole(RoleName.ADMIN));
      expect(result.id).toBe(SALE_ID);
      expect(result.inventoryMovements).toHaveLength(1);
    });

    it('venta inexistente -> 404', async () => {
      prisma.sale.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne(SALE_ID, asRole(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ADMIN/SELLER/MANAGEMENT pueden ver el detalle', async () => {
      for (const role of [
        RoleName.ADMIN,
        RoleName.SELLER,
        RoleName.MANAGEMENT,
      ]) {
        await expect(
          service.findOne(SALE_ID, asRole(role)),
        ).resolves.toBeDefined();
      }
    });

    it('WAREHOUSE -> 404 SIN consultar Sale', async () => {
      await expect(
        service.findOne(SALE_ID, asRole(RoleName.WAREHOUSE)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sale.findUnique).not.toHaveBeenCalled();
    });

    it('rol desconocido -> 404 sin consultar', async () => {
      await expect(
        service.findOne(SALE_ID, asRole('UNKNOWN' as unknown as RoleName)),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sale.findUnique).not.toHaveBeenCalled();
    });

    it('la segunda consulta de movimientos filtra por referenceType=Sale/referenceId y origin SALE/SALE_CANCELLATION', async () => {
      await service.findOne(SALE_ID, asRole(RoleName.ADMIN));
      expect(prisma.inventoryMovement.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            referenceType: 'Sale',
            referenceId: SALE_ID,
            origin: { in: ['SALE', 'SALE_CANCELLATION'] },
          },
          orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        }),
      );
    });

    it('vendedor/anulador seguros, referencia de cotización, ítems presentes', async () => {
      prisma.sale.findUnique.mockResolvedValue(
        makeSaleDetailRow({
          quote: { id: QUOTE_ID, number: 'COT-000001' },
          cancelledBy: {
            id: 'admin-1',
            username: 'admin',
            firstName: 'Ana',
            lastName: 'Admin',
          },
        }),
      );
      const result = await service.findOne(SALE_ID, asRole(RoleName.ADMIN));
      expect(result.seller).toEqual({
        id: ACTOR_ID,
        username: 'admin',
        firstName: 'Ana',
        lastName: 'Admin',
      });
      expect(result.quote).toEqual({ id: QUOTE_ID, number: 'COT-000001' });
      expect(result.items).toHaveLength(1);
    });

    describe('permisos por vendedor (P2)', () => {
      const OTHER_SELLER_ID = 'seller-other';

      function findUniqueWhere(): unknown {
        return (prisma.sale.findUnique.mock.calls[0][0] as { where: unknown })
          .where;
      }

      it('SELLER consulta su propia venta: 200; el alcance viaja en la consulta', async () => {
        const result = await service.findOne(SALE_ID, asRole(RoleName.SELLER));
        expect(result.id).toBe(SALE_ID);
        expect(findUniqueWhere()).toEqual({
          id: SALE_ID,
          AND: [{ sellerId: ACTOR_ID }],
        });
      });

      it('SELLER consulta una venta ajena: la consulta con alcance no la encuentra -> 404 "Venta no encontrada", sin leer movimientos', async () => {
        prisma.sale.findUnique.mockResolvedValue(null);
        const error = await service
          .findOne(SALE_ID, asRole(RoleName.SELLER, OTHER_SELLER_ID))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
        expect(findUniqueWhere()).toEqual({
          id: SALE_ID,
          AND: [{ sellerId: OTHER_SELLER_ID }],
        });
        expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
      });

      it('defensa en profundidad: aunque la fila llegara, una venta ajena responde 404 sin exponer datos', async () => {
        // ACTOR_ID es el vendedor de la fila fixture; el solicitante es otro.
        const error = await service
          .findOne(SALE_ID, asRole(RoleName.SELLER, OTHER_SELLER_ID))
          .catch((e: unknown) => e);
        expect(error).toBeInstanceOf(NotFoundException);
        expect((error as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
        expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
      });

      it('SELLER con un ID inexistente recibe exactamente el mismo 404', async () => {
        prisma.sale.findUnique.mockResolvedValue(null);
        const missing = await service
          .findOne(SALE_ID, asRole(RoleName.SELLER))
          .catch((e: unknown) => e);
        expect(missing).toBeInstanceOf(NotFoundException);
        expect((missing as NotFoundException).message).toBe(
          'Venta no encontrada',
        );
      });

      it('ADMIN y MANAGEMENT consultan ventas de otro vendedor (sin condición de propiedad)', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.sale.findUnique.mockClear();
          const result = await service.findOne(
            SALE_ID,
            asRole(role, OTHER_SELLER_ID),
          );
          expect(result.id).toBe(SALE_ID);
          expect(findUniqueWhere()).toEqual({ id: SALE_ID, AND: [{}] });
        }
      });

      it('la lectura nunca modifica el vendedor original de la venta', async () => {
        const result = await service.findOne(
          SALE_ID,
          asRole(RoleName.ADMIN, OTHER_SELLER_ID),
        );
        // El vendedor expuesto es el persistido (ACTOR_ID), no el solicitante.
        expect(result.seller.id).toBe(ACTOR_ID);
      });
    });
  });

  // ======================================================================
  // Fase 8, Bloque B — integración contable
  // ======================================================================
  describe('Fase 8, Bloque B — integración contable en createDirect', () => {
    it('venta económicamente activa: postSaleRecognition se llama exactamente una vez, mismo tx, con subtotal/discount/tax/total/actor/ip correctos', async () => {
      await service.createDirect(validDirectInput);
      expect(accountingEngine.postSaleRecognition).toHaveBeenCalledTimes(1);
      const [calledTx, command] =
        accountingEngine.postSaleRecognition.mock.calls[0];
      expect(calledTx).toBe(prisma.tx);
      const typedCommand = command as {
        subtotal: Prisma.Decimal;
        discountAmount: Prisma.Decimal;
        taxAmount: Prisma.Decimal;
        total: Prisma.Decimal;
        actorUserId: string;
        ipAddress: string | null;
        postedAt: Date;
      };
      expect(typedCommand.subtotal.toFixed(2)).toBe('10.00');
      expect(typedCommand.discountAmount.toFixed(2)).toBe('0.00');
      expect(typedCommand.taxAmount.toFixed(2)).toBe('0.00');
      expect(typedCommand.total.toFixed(2)).toBe('10.00');
      expect(typedCommand.actorUserId).toBe(ACTOR_ID);
      expect(typedCommand.ipAddress).toBe('10.0.0.1');
      expect(typedCommand.postedAt).toBeInstanceOf(Date);
    });

    it('IGV activo (Fase 10, Bloque C): postSaleRecognition recibe el taxAmount calculado, no un cero fijo', async () => {
      settingsReader.getCurrent.mockResolvedValue(
        makeSettingsSnapshot({
          taxEnabled: true,
          taxRate: new Prisma.Decimal('18.00'),
        }),
      );
      await service.createDirect(validDirectInput);
      const command = accountingEngine.postSaleRecognition.mock.calls[0][1] as {
        subtotal: Prisma.Decimal;
        taxAmount: Prisma.Decimal;
        total: Prisma.Decimal;
      };
      // R2-B4: montos con IGV incluido (10.00 final -> 8.47 + 1.53).
      expect(command.subtotal.toFixed(2)).toBe('8.47');
      expect(command.taxAmount.toFixed(2)).toBe('1.53');
      expect(command.total.toFixed(2)).toBe('10.00');
      expect(
        command.total.equals(command.subtotal.plus(command.taxAmount)),
      ).toBe(true);
    });

    it('postSaleRecognition usa EXACTAMENTE el mismo confirmedAt que el persistido en Sale', async () => {
      await service.createDirect(validDirectInput);
      const persistedConfirmedAt = (
        prisma.tx.sale.create.mock.calls[0][0] as {
          data: { confirmedAt: Date };
        }
      ).data.confirmedAt;
      const postedAt = (
        accountingEngine.postSaleRecognition.mock.calls[0][1] as {
          postedAt: Date;
        }
      ).postedAt;
      expect(postedAt).toBe(persistedConfirmedAt);
    });

    it('pago inicial: postSaleRecognition Y PaymentEngine.register se llaman ambos por separado, nunca combinados en un solo asiento', async () => {
      paymentEngine.sumActiveForSale.mockResolvedValue(
        new Prisma.Decimal('10.00'),
      );
      await service.createDirect({
        ...validDirectInput,
        payment: { method: 'CASH', amount: '10.00' },
      });
      expect(accountingEngine.postSaleRecognition).toHaveBeenCalledTimes(1);
      expect(paymentEngine.register).toHaveBeenCalledTimes(1);
    });

    it('venta sin actividad económica (producto de precio 0): SalesService igual delega en AccountingEngine, sin duplicar la lógica de no-op', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          customer: makeCustomerRow(),
          products: new Map([
            [
              PRODUCT_ID,
              makeProductRow({ salePrice: new Prisma.Decimal('0.00') }),
            ],
          ]),
        }),
      );
      await service.createDirect(validDirectInput);
      expect(accountingEngine.postSaleRecognition).toHaveBeenCalledTimes(1);
      const command = accountingEngine.postSaleRecognition.mock.calls[0][1] as {
        subtotal: Prisma.Decimal;
        total: Prisma.Decimal;
      };
      expect(command.subtotal.toFixed(2)).toBe('0.00');
      expect(command.total.toFixed(2)).toBe('0.00');
    });

    it('si AccountingEngine.postSaleRecognition rechaza, createDirect rechaza por completo', async () => {
      accountingEngine.postSaleRecognition.mockRejectedValue(
        new Error('fallo contable interno'),
      );
      await expect(service.createDirect(validDirectInput)).rejects.toThrow(
        'fallo contable interno',
      );
    });
  });

  describe('Fase 8, Bloque B — integración contable en createFromQuote', () => {
    // ADMIN por defecto: sin restricción de propiedad (comportamiento previo).
    const validConvertInput = {
      quoteId: QUOTE_ID,
      actorUserId: ACTOR_ID,
      actorRole: RoleName.ADMIN,
      ipAddress: '10.0.0.1',
    };

    it('venta económicamente activa: postSaleRecognition con subtotal/discount/tax/total EXACTOS de la cotización (nunca recalculados)', async () => {
      await service.createFromQuote(validConvertInput);
      expect(accountingEngine.postSaleRecognition).toHaveBeenCalledTimes(1);
      const command = accountingEngine.postSaleRecognition.mock.calls[0][1] as {
        subtotal: Prisma.Decimal;
        discountAmount: Prisma.Decimal;
        taxAmount: Prisma.Decimal;
        total: Prisma.Decimal;
      };
      expect(command.subtotal.toFixed(2)).toBe('10.00');
      expect(command.discountAmount.toFixed(2)).toBe('0.00');
      expect(command.taxAmount.toFixed(2)).toBe('0.00');
      expect(command.total.toFixed(2)).toBe('10.00');
    });

    it('postSaleRecognition usa el mismo confirmedAt persistido en la Sale convertida', async () => {
      await service.createFromQuote(validConvertInput);
      const persistedConfirmedAt = (
        prisma.tx.sale.create.mock.calls[0][0] as {
          data: { confirmedAt: Date };
        }
      ).data.confirmedAt;
      const postedAt = (
        accountingEngine.postSaleRecognition.mock.calls[0][1] as {
          postedAt: Date;
        }
      ).postedAt;
      expect(postedAt).toBe(persistedConfirmedAt);
    });

    it('pago inicial en conversión: ambos asientos (venta y cobro) se postean por separado', async () => {
      paymentEngine.sumActiveForSale.mockResolvedValue(
        new Prisma.Decimal('10.00'),
      );
      await service.createFromQuote({
        ...validConvertInput,
        payment: { method: 'CASH', amount: '10.00' },
      });
      expect(accountingEngine.postSaleRecognition).toHaveBeenCalledTimes(1);
      expect(paymentEngine.register).toHaveBeenCalledTimes(1);
    });

    it('si AccountingEngine.postSaleRecognition rechaza, createFromQuote rechaza por completo (la cotización no queda CONVERTED)', async () => {
      accountingEngine.postSaleRecognition.mockRejectedValue(
        new Error('fallo contable interno'),
      );
      await expect(service.createFromQuote(validConvertInput)).rejects.toThrow(
        'fallo contable interno',
      );
      expect(prisma.tx.quote.update).not.toHaveBeenCalled();
    });
  });

  describe('Fase 8, Bloque B — integración contable en cancel', () => {
    const validCancelInput = {
      saleId: SALE_ID,
      reason: 'Motivo de anulación de prueba contable',
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    it('venta económicamente activa (por defecto): reverseOriginalForSource se llama exactamente una vez, sourceType SALE/sourceId correctos', async () => {
      await service.cancel(validCancelInput);
      expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledTimes(
        1,
      );
      const command = accountingEngine.reverseOriginalForSource.mock
        .calls[0][1] as { sourceType: string; sourceId: string };
      expect(command.sourceType).toBe('SALE');
      expect(command.sourceId).toBe(SALE_ID);
    });

    it('el postedAt de la reversión de venta es EXACTAMENTE el mismo cancelledAt persistido en Sale.cancelledAt', async () => {
      await service.cancel(validCancelInput);
      const persistedCancelledAt = (
        prisma.tx.sale.update.mock.calls[0][0] as {
          data: { cancelledAt: Date };
        }
      ).data.cancelledAt;
      const postedAt = (
        accountingEngine.reverseOriginalForSource.mock.calls[0][1] as {
          postedAt: Date;
        }
      ).postedAt;
      expect(postedAt).toBe(persistedCancelledAt);
    });

    it('el MISMO cancelledAt de operación se pasa a PaymentEngine.cancelAllActiveForSale y a la reversión contable de venta', async () => {
      await service.cancel(validCancelInput);
      const cancelAllCommand = paymentEngine.cancelAllActiveForSale.mock
        .calls[0][1] as { cancelledAt: Date };
      const saleReversalPostedAt = (
        accountingEngine.reverseOriginalForSource.mock.calls[0][1] as {
          postedAt: Date;
        }
      ).postedAt;
      expect(cancelAllCommand.cancelledAt).toBe(saleReversalPostedAt);
    });

    it('venta SIN actividad económica (0/0/0/0): NO se revierte ningún asiento de venta (nunca existió un ORIGINAL que revertir)', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({
            subtotal: new Prisma.Decimal('0'),
            discountAmount: new Prisma.Decimal('0'),
            taxAmount: new Prisma.Decimal('0'),
            total: new Prisma.Decimal('0'),
          }),
        }),
      );
      await service.cancel(validCancelInput);
      expect(accountingEngine.reverseOriginalForSource).not.toHaveBeenCalled();
    });

    it('venta con DESCUENTO TOTAL (subtotal>0, discount=subtotal, total=0): SÍ se revierte el asiento de venta', async () => {
      prisma.tx.$queryRaw.mockImplementation(
        createQueryRawRouter({
          sale: makeSaleLockRow({
            subtotal: new Prisma.Decimal('100.00'),
            discountAmount: new Prisma.Decimal('100.00'),
            taxAmount: new Prisma.Decimal('0.00'),
            total: new Prisma.Decimal('0.00'),
          }),
        }),
      );
      await service.cancel(validCancelInput);
      expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledTimes(
        1,
      );
    });

    it('si AccountingEngine.reverseOriginalForSource rechaza, cancel rechaza por completo (nada se confirma)', async () => {
      accountingEngine.reverseOriginalForSource.mockRejectedValue(
        new Error('fallo contable interno'),
      );
      await expect(service.cancel(validCancelInput)).rejects.toThrow(
        'fallo contable interno',
      );
      expect(prisma.tx.sale.update).not.toHaveBeenCalled();
    });

    it('nunca recalcula paidAmount/balanceDue/paymentStatus (el resumen congelado sigue siendo responsabilidad exclusiva de la Fase 7)', async () => {
      await service.cancel(validCancelInput);
      expect(paymentEngine.recalculateSaleSummary).not.toHaveBeenCalled();
    });
  });
});
