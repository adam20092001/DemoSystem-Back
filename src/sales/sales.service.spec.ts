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
  Prisma,
  ProductStatus,
  QuoteStatus,
  RoleName,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
  UnitStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import * as businessDateModule from '../common/date/business-date';
import { PrismaService } from '../database/prisma.service';
import { StockMovementEngine } from '../inventory/stock-movement.engine';
import { SalesService } from './sales.service';

const ACTOR_ID = 'actor-1';
const CUSTOMER_ID = 'customer-1';
const PRODUCT_ID = 'product-1';
const PRODUCT_ID_2 = 'product-2';
const QUOTE_ID = 'quote-1';
const QUOTE_SELLER_ID = 'quote-seller-1';
const SALE_ID = 'sale-1';
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
    ...overrides,
  };
}

function makeSaleLockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: SALE_ID,
    number: 'NV-000001',
    status: SaleStatus.ACTIVE,
    deliveryStatus: SaleDeliveryStatus.PENDING,
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
    paidAmount: new Prisma.Decimal('0.00'),
    balanceDue: new Prisma.Decimal('10.00'),
    items: [makeSaleItemRow()],
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

// ----------------------------------------------------------------------
// Mocks
// ----------------------------------------------------------------------

interface QueryRawRouterConfig {
  customer?: Record<string, unknown> | null;
  quote?: Record<string, unknown> | null;
  sale?: Record<string, unknown> | null;
  products?: Map<string, Record<string, unknown>>;
}

/**
 * `$queryRaw` se enruta por el contenido literal del SQL (nunca por orden
 * de llamada): SalesService ejecuta varias consultas raw distintas dentro
 * de una misma transacción (cliente, producto por producto, cotización,
 * venta), así que un único mockResolvedValue no alcanza.
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

describe('SalesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let sequenceService: ReturnType<typeof createSequenceServiceMock>;
  let engine: ReturnType<typeof createEngineMock>;
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

    service = new SalesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      sequenceService,
      engine as unknown as StockMovementEngine,
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
  });

  // ====================================================================
  // createFromQuote
  // ====================================================================
  describe('createFromQuote', () => {
    const validConvertInput = {
      quoteId: QUOTE_ID,
      actorUserId: ACTOR_ID,
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
  });

  // ====================================================================
  // Entrega
  // ====================================================================
  describe('markDelivered', () => {
    const input = { saleId: SALE_ID, actorUserId: ACTOR_ID, ipAddress: null };

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
  });

  describe('markObserved', () => {
    const input = { saleId: SALE_ID, actorUserId: ACTOR_ID, ipAddress: null };

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
          subtotal: new Prisma.Decimal('10.00'),
          discountAmount: new Prisma.Decimal('0.00'),
          taxAmount: new Prisma.Decimal('0.00'),
          total: new Prisma.Decimal('10.00'),
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

    it('ADMIN: consulta y devuelve resultados paginados', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data).toHaveLength(1);
      expect(prisma.sale.findMany).toHaveBeenCalled();
    });

    it('SELLER: consulta sin filtro de propiedad', async () => {
      await service.list({}, RoleName.SELLER);
      expect(prisma.sale.findMany).toHaveBeenCalled();
    });

    it('MANAGEMENT: consulta todas', async () => {
      await service.list({}, RoleName.MANAGEMENT);
      expect(prisma.sale.findMany).toHaveBeenCalled();
    });

    it('WAREHOUSE: página vacía SIN consultar Prisma', async () => {
      const result = await service.list({}, RoleName.WAREHOUSE);
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
      const result = await service.list({}, 'UNKNOWN' as unknown as RoleName);
      expect(result.data).toEqual([]);
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
    });

    it('paginación: página/límite por defecto', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
    });

    it('paginación: respeta límite máximo de 100', async () => {
      await service.list({ limit: 500 }, RoleName.ADMIN);
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
        RoleName.ADMIN,
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
          RoleName.ADMIN,
        ),
      ).resolves.toBeDefined();
    });

    it('confirmedFrom/confirmedTo se traducen a límites UTC de America/Lima', async () => {
      await service.list(
        { confirmedFrom: '2026-03-01', confirmedTo: '2026-03-31' },
        RoleName.ADMIN,
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
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('confirmedFrom con formato inválido -> 400', async () => {
      await expect(
        service.list({ confirmedFrom: '2026/03/01' }, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('búsqueda por número/nombre/documento (case-insensitive contains)', async () => {
      await service.list({ search: 'nv-000' }, RoleName.ADMIN);
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
      await service.list({ search: '   ' }, RoleName.ADMIN);
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] } | Record<string, never>;
      };
      expect(args.where).toEqual({});
    });

    it('orden fijo: confirmedAt desc, id desc', async () => {
      await service.list({}, RoleName.ADMIN);
      const args = prisma.sale.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(args.orderBy).toEqual([{ confirmedAt: 'desc' }, { id: 'desc' }]);
    });

    it('findMany y count usan el mismo where', async () => {
      await service.list({ status: SaleStatus.ACTIVE }, RoleName.ADMIN);
      const findManyWhere = (
        prisma.sale.findMany.mock.calls[0][0] as { where: unknown }
      ).where;
      const countWhere = (
        prisma.sale.count.mock.calls[0][0] as { where: unknown }
      ).where;
      expect(findManyWhere).toEqual(countWhere);
    });

    it('la forma de lista nunca incluye items/inventoryMovements', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0]).not.toHaveProperty('items');
      expect(result.data[0]).not.toHaveProperty('inventoryMovements');
      expect(result.data[0].itemCount).toBe(1);
    });
  });

  // ====================================================================
  // findOne
  // ====================================================================
  describe('findOne', () => {
    it('venta encontrada: devuelve SafeSale con movimientos', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([makeMovementRow()]);
      const result = await service.findOne(SALE_ID, RoleName.ADMIN);
      expect(result.id).toBe(SALE_ID);
      expect(result.inventoryMovements).toHaveLength(1);
    });

    it('venta inexistente -> 404', async () => {
      prisma.sale.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne(SALE_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ADMIN/SELLER/MANAGEMENT pueden ver el detalle', async () => {
      for (const role of [
        RoleName.ADMIN,
        RoleName.SELLER,
        RoleName.MANAGEMENT,
      ]) {
        await expect(service.findOne(SALE_ID, role)).resolves.toBeDefined();
      }
    });

    it('WAREHOUSE -> 404 SIN consultar Sale', async () => {
      await expect(
        service.findOne(SALE_ID, RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sale.findUnique).not.toHaveBeenCalled();
    });

    it('rol desconocido -> 404 sin consultar', async () => {
      await expect(
        service.findOne(SALE_ID, 'UNKNOWN' as unknown as RoleName),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.sale.findUnique).not.toHaveBeenCalled();
    });

    it('la segunda consulta de movimientos filtra por referenceType=Sale/referenceId y origin SALE/SALE_CANCELLATION', async () => {
      await service.findOne(SALE_ID, RoleName.ADMIN);
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
      const result = await service.findOne(SALE_ID, RoleName.ADMIN);
      expect(result.seller).toEqual({
        id: ACTOR_ID,
        username: 'admin',
        firstName: 'Ana',
        lastName: 'Admin',
      });
      expect(result.quote).toEqual({ id: QUOTE_ID, number: 'COT-000001' });
      expect(result.items).toHaveLength(1);
    });

    it('no filtra ownership por SELLER (misma consulta que ADMIN)', async () => {
      await service.findOne(SALE_ID, RoleName.SELLER);
      const sellerArgs = prisma.sale.findUnique.mock.calls[0][0];
      prisma.sale.findUnique.mockClear();
      await service.findOne(SALE_ID, RoleName.ADMIN);
      const adminArgs = prisma.sale.findUnique.mock.calls[0][0];
      expect(sellerArgs).toEqual(adminArgs);
    });
  });
});
