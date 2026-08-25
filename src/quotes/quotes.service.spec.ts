import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  CustomerStatus,
  CustomerType,
  DocumentType,
  Prisma,
  ProductStatus,
  QuoteStatus,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import * as businessDateModule from '../common/date/business-date';
import { CompanySettingsSnapshot } from '../configuration/types/company-settings-snapshot';
import { SettingsReader } from '../configuration/settings-reader.service';
import { PrismaService } from '../database/prisma.service';
import { QuotesService } from './quotes.service';

const ACTOR_ID = 'actor-1';
const CUSTOMER_ID = 'customer-1';
const PRODUCT_ID = 'product-1';
const QUOTE_ID = 'quote-1';
const FIXED_TODAY = '2026-03-15';

function makeCustomerRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: CUSTOMER_ID,
    isGeneric: false,
    status: CustomerStatus.ACTIVE,
    customerType: CustomerType.PERSON,
    documentType: null,
    documentNumber: null,
    name: 'Cliente Uno',
    address: null,
    ...overrides,
  };
}

function makeProductRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PRODUCT_ID,
    sku: 'SKU-1',
    name: 'Producto Uno',
    salePrice: new Prisma.Decimal('10.00'),
    status: ProductStatus.ACTIVE,
    category: { status: CategoryStatus.ACTIVE },
    unit: {
      code: 'UND',
      name: 'Unidad',
      abbreviation: 'und',
      status: UnitStatus.ACTIVE,
      allowDecimal: false,
    },
    ...overrides,
  };
}

function makeQuoteDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
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
    sellerId: ACTOR_ID,
    seller: {
      id: ACTOR_ID,
      username: 'admin',
      firstName: 'Ana',
      lastName: 'Admin',
    },
    issueDate: new Date('2026-03-15T00:00:00.000Z'),
    expirationDate: new Date('2026-03-20T00:00:00.000Z'),
    subtotal: new Prisma.Decimal('10.00'),
    discountAmount: new Prisma.Decimal('0'),
    taxAmount: new Prisma.Decimal('0'),
    total: new Prisma.Decimal('10.00'),
    notes: null,
    items: [
      {
        id: 'item-1',
        productId: PRODUCT_ID,
        productSku: 'SKU-1',
        productName: 'Producto Uno',
        unitCode: 'UND',
        unitName: 'Unidad',
        unitAbbreviation: 'und',
        quantity: new Prisma.Decimal('1'),
        unitPrice: new Prisma.Decimal('10.00'),
        lineTotal: new Prisma.Decimal('10.00'),
        product: {
          stockCurrent: new Prisma.Decimal('50.000'),
          isInventoryTracked: true,
        },
      },
    ],
    createdAt: new Date('2026-03-15T00:00:00.000Z'),
    updatedAt: new Date('2026-03-15T00:00:00.000Z'),
    ...overrides,
  };
}

function makeLockedQuoteRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: QUOTE_ID,
    number: 'COT-000001',
    status: QuoteStatus.PENDING,
    issueDate: new Date('2026-03-15T00:00:00.000Z'),
    expirationDate: new Date('2026-03-20T00:00:00.000Z'),
    subtotal: new Prisma.Decimal('10.00'),
    discountAmount: new Prisma.Decimal('0'),
    taxAmount: new Prisma.Decimal('0'),
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    customer: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    product: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    quote: {
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    quoteItem: {
      deleteMany: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
  return {
    tx,
    quote: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
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

describe('QuotesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let sequenceService: ReturnType<typeof createSequenceServiceMock>;
  let settingsReader: ReturnType<typeof createSettingsReaderMock>;
  let service: QuotesService;

  beforeEach(() => {
    jest
      .spyOn(businessDateModule, 'businessToday')
      .mockReturnValue(FIXED_TODAY);

    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    sequenceService = createSequenceServiceMock();
    sequenceService.next.mockResolvedValue('COT-000001');
    settingsReader = createSettingsReaderMock();
    settingsReader.getCurrent.mockResolvedValue(makeSettingsSnapshot());

    service = new QuotesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      sequenceService,
      settingsReader as unknown as SettingsReader,
    );

    prisma.tx.customer.findUnique.mockResolvedValue(makeCustomerRow());
    prisma.tx.product.findUnique.mockResolvedValue(makeProductRow());
    prisma.tx.quote.create.mockResolvedValue(makeQuoteDetailRow());
    prisma.tx.quote.update.mockResolvedValue(makeQuoteDetailRow());
    prisma.tx.quoteItem.count.mockResolvedValue(1);
    prisma.tx.$queryRaw.mockResolvedValue([makeLockedQuoteRow()]);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  const validCreateInput = {
    customerId: CUSTOMER_ID,
    expirationDate: '2026-03-20',
    items: [{ productId: PRODUCT_ID, quantity: '1' }],
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
  };

  /** Mismo input válido, sin expirationDate (Bloque 10, B: dispara el cálculo por defecto). */
  const validCreateInputWithoutExpiration = {
    customerId: CUSTOMER_ID,
    items: [{ productId: PRODUCT_ID, quantity: '1' }],
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
  };

  describe('create', () => {
    it('PERSON: crea y devuelve la forma segura', async () => {
      const result = await service.create(validCreateInput);
      expect(result.id).toBe(QUOTE_ID);
    });

    it('COMPANY: crea normalmente', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ customerType: CustomerType.COMPANY }),
      );
      await expect(service.create(validCreateInput)).resolves.toBeDefined();
    });

    it('PROSPECT/CUSTOMER: no se valida customerStage (ambos elegibles)', async () => {
      await expect(service.create(validCreateInput)).resolves.toBeDefined();
    });

    it('BLOCKED: permitido', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ status: CustomerStatus.BLOCKED }),
      );
      await expect(service.create(validCreateInput)).resolves.toBeDefined();
    });

    it('INACTIVE: rechazado con 409', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ status: CustomerStatus.INACTIVE }),
      );
      await expect(service.create(validCreateInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('genérico (isGeneric=true): rechazado con 409', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ isGeneric: true, customerType: null }),
      );
      await expect(service.create(validCreateInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('cliente inexistente: 404', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(null);
      await expect(service.create(validCreateInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('snapshot sin documento (ambos null)', async () => {
      await service.create(validCreateInput);
      const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.customerDocumentType).toBeNull();
      expect(createArgs.data.customerDocumentNumber).toBeNull();
    });

    it('snapshot con documento', async () => {
      prisma.tx.customer.findUnique.mockResolvedValue(
        makeCustomerRow({ documentType: 'DNI', documentNumber: '12345678' }),
      );
      await service.create(validCreateInput);
      const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.customerDocumentType).toBe('DNI');
      expect(createArgs.data.customerDocumentNumber).toBe('12345678');
    });

    it('sellerId = actorUserId (actor SELLER)', async () => {
      await service.create({
        ...validCreateInput,
        actorUserId: 'seller-actor',
      });
      const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.sellerId).toBe('seller-actor');
    });

    it('sellerId = actorUserId también cuando el actor es ADMIN', async () => {
      await service.create({ ...validCreateInput, actorUserId: 'admin-actor' });
      const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.sellerId).toBe('admin-actor');
    });

    it('producto inactivo: 409', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(
        makeProductRow({ status: ProductStatus.INACTIVE }),
      );
      await expect(service.create(validCreateInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('categoría inactiva: 409', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(
        makeProductRow({ category: { status: CategoryStatus.INACTIVE } }),
      );
      await expect(service.create(validCreateInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('unidad inactiva: 409', async () => {
      const base = makeProductRow();
      prisma.tx.product.findUnique.mockResolvedValue(
        makeProductRow({
          unit: { ...(base.unit as object), status: UnitStatus.INACTIVE },
        }),
      );
      await expect(service.create(validCreateInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('producto inexistente: 404', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(null);
      await expect(service.create(validCreateInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('usa Product.salePrice, nunca un precio del cliente', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(
        makeProductRow({ salePrice: new Prisma.Decimal('99.99') }),
      );
      await service.create(validCreateInput);
      const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
        data: { items: { create: { unitPrice: Prisma.Decimal }[] } };
      };
      expect(createArgs.data.items.create[0].unitPrice.toFixed(2)).toBe(
        '99.99',
      );
    });

    it('snapshots de producto persistidos', async () => {
      await service.create(validCreateInput);
      const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
        data: {
          items: {
            create: {
              productSku: string;
              productName: string;
              unitCode: string;
              unitName: string;
              unitAbbreviation: string;
            }[];
          };
        };
      };
      const item = createArgs.data.items.create[0];
      expect(item.productSku).toBe('SKU-1');
      expect(item.productName).toBe('Producto Uno');
      expect(item.unitCode).toBe('UND');
      expect(item.unitName).toBe('Unidad');
      expect(item.unitAbbreviation).toBe('und');
    });

    it('cantidad fraccionaria con allowDecimal=false: 400', async () => {
      await expect(
        service.create({
          ...validCreateInput,
          items: [{ productId: PRODUCT_ID, quantity: '1.5' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cantidad fraccionaria con allowDecimal=true: aceptada', async () => {
      const base = makeProductRow();
      prisma.tx.product.findUnique.mockResolvedValue(
        makeProductRow({
          unit: { ...(base.unit as object), allowDecimal: true },
        }),
      );
      await expect(
        service.create({
          ...validCreateInput,
          items: [{ productId: PRODUCT_ID, quantity: '1.500' }],
        }),
      ).resolves.toBeDefined();
    });

    it('producto duplicado: 400 ANTES de abrir la transacción', async () => {
      await expect(
        service.create({
          ...validCreateInput,
          items: [
            { productId: PRODUCT_ID, quantity: '1' },
            { productId: PRODUCT_ID, quantity: '2' },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('cero ítems: 400 antes de abrir la transacción', async () => {
      await expect(
        service.create({ ...validCreateInput, items: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('vencimiento igual al día de negocio: permitido', async () => {
      await expect(
        service.create({ ...validCreateInput, expirationDate: FIXED_TODAY }),
      ).resolves.toBeDefined();
    });

    it('vencimiento anterior al día de negocio: 400', async () => {
      await expect(
        service.create({ ...validCreateInput, expirationDate: '2026-03-14' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('descuento aplicado y totales correctos', async () => {
      await service.create({ ...validCreateInput, discountAmount: '5.00' });
      const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
        data: {
          subtotal: Prisma.Decimal;
          discountAmount: Prisma.Decimal;
          total: Prisma.Decimal;
        };
      };
      expect(createArgs.data.subtotal.toFixed(2)).toBe('10.00');
      expect(createArgs.data.discountAmount.toFixed(2)).toBe('5.00');
      expect(createArgs.data.total.toFixed(2)).toBe('5.00');
    });

    it('descuento > subtotal: 400', async () => {
      await expect(
        service.create({ ...validCreateInput, discountAmount: '11.00' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    describe('Bloque 10, B — vigencia por defecto y descuento máximo configurado', () => {
      it('expirationDate omitido: usa issueDate + quoteValidityDays configurado', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ quoteValidityDays: 15 }),
        );
        await service.create(validCreateInputWithoutExpiration);
        const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: { expirationDate: Date };
        };
        // FIXED_TODAY = '2026-03-15' + 15 días calendario = '2026-03-30'.
        expect(createArgs.data.expirationDate.toISOString()).toBe(
          '2026-03-30T00:00:00.000Z',
        );
      });

      it('expirationDate explícito gana sobre el valor configurado', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ quoteValidityDays: 15 }),
        );
        await service.create({
          ...validCreateInput,
          expirationDate: '2026-12-25',
        });
        const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: { expirationDate: Date };
        };
        expect(createArgs.data.expirationDate.toISOString()).toBe(
          '2026-12-25T00:00:00.000Z',
        );
      });

      it('el mismo issueDate resuelto (businessDate) es la base del cálculo por defecto, nunca un segundo businessToday()', async () => {
        const businessTodaySpy = jest.spyOn(
          businessDateModule,
          'businessToday',
        );
        await service.create(validCreateInputWithoutExpiration);
        // Una sola invocación real de businessToday(): la resolución de la
        // fecha por defecto reutiliza la variable ya calculada, no vuelve a
        // preguntar "hoy".
        expect(businessTodaySpy).toHaveBeenCalledTimes(1);
      });

      it('SettingsReader.getCurrent(tx) se llama exactamente una vez, incluso con expirationDate explícito', async () => {
        await service.create({
          ...validCreateInput,
          expirationDate: '2026-04-01',
        });
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
        expect(settingsReader.getCurrent).toHaveBeenCalledWith(prisma.tx);
      });

      it('cambiar quoteValidityDays después no afecta una cotización ya creada (no hay backfill: cada creación resuelve su propio snapshot)', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ quoteValidityDays: 15 }),
        );
        await service.create(validCreateInputWithoutExpiration);
        const firstArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: { expirationDate: Date };
        };
        expect(firstArgs.data.expirationDate.toISOString()).toBe(
          '2026-03-30T00:00:00.000Z',
        );

        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ quoteValidityDays: 30 }),
        );
        await service.create(validCreateInputWithoutExpiration);
        const secondArgs = prisma.tx.quote.create.mock.calls[1][0] as {
          data: { expirationDate: Date };
        };
        expect(secondArgs.data.expirationDate.toISOString()).toBe(
          '2026-04-14T00:00:00.000Z',
        );
        // La primera cotización ya creada no se toca ni se recalcula.
        expect(firstArgs.data.expirationDate.toISOString()).toBe(
          '2026-03-30T00:00:00.000Z',
        );
      });

      it('max = 0, descuento 0: permitido', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('0.00'),
          }),
        );
        await expect(service.create(validCreateInput)).resolves.toBeDefined();
      });

      it('max = 10%, descuento exactamente en el límite: permitido', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.create({ ...validCreateInput, discountAmount: '1.00' }),
        ).resolves.toBeDefined();
      });

      it('max = 10%, descuento por encima del límite: 400', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.create({ ...validCreateInput, discountAmount: '1.01' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('max = 100%, descuento total del subtotal: permitido', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('100.00'),
          }),
        );
        await expect(
          service.create({ ...validCreateInput, discountAmount: '10.00' }),
        ).resolves.toBeDefined();
      });

      it('el tope absoluto (descuento > subtotal) sigue funcionando independientemente del máximo configurado al 100%', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('100.00'),
          }),
        );
        await expect(
          service.create({ ...validCreateInput, discountAmount: '10.01' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    describe('Bloque 10, C — IGV en la creación de la cotización', () => {
      it('taxEnabled=false -> taxAmount 0.00', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ taxEnabled: false }),
        );
        await service.create(validCreateInput);
        const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
        };
        expect(createArgs.data.taxAmount.toFixed(2)).toBe('0.00');
        expect(createArgs.data.total.toFixed(2)).toBe('10.00');
      });

      it('taxEnabled=true, 18% normal, sin descuento', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
          }),
        );
        await service.create(validCreateInput);
        const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: {
            subtotal: Prisma.Decimal;
            taxAmount: Prisma.Decimal;
            total: Prisma.Decimal;
          };
        };
        // subtotal = 10.00 (1 x 10.00), taxableBase = 10.00, tax = 1.80.
        expect(createArgs.data.subtotal.toFixed(2)).toBe('10.00');
        expect(createArgs.data.taxAmount.toFixed(2)).toBe('1.80');
        expect(createArgs.data.total.toFixed(2)).toBe('11.80');
      });

      it('el descuento reduce la base imponible ANTES del impuesto', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
          }),
        );
        await service.create({
          ...validCreateInput,
          discountAmount: '2.00',
        });
        const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: {
            discountAmount: Prisma.Decimal;
            taxAmount: Prisma.Decimal;
            total: Prisma.Decimal;
          };
        };
        // taxableBase = 10.00 - 2.00 = 8.00; tax = 8.00*18/100 = 1.44.
        expect(createArgs.data.discountAmount.toFixed(2)).toBe('2.00');
        expect(createArgs.data.taxAmount.toFixed(2)).toBe('1.44');
        expect(createArgs.data.total.toFixed(2)).toBe('9.44');
      });

      it('descuento total -> taxableBase 0 -> taxAmount 0.00, sin anomalía', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
            maxDiscountPercent: new Prisma.Decimal('100.00'),
          }),
        );
        await service.create({
          ...validCreateInput,
          discountAmount: '10.00',
        });
        const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
        };
        expect(createArgs.data.taxAmount.toFixed(2)).toBe('0.00');
        expect(createArgs.data.total.toFixed(2)).toBe('0.00');
      });

      it('SettingsReader.getCurrent(tx) se llama exactamente una vez (mismo snapshot para vigencia, descuento e impuesto)', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ taxEnabled: true }),
        );
        await service.create(validCreateInput);
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
      });

      it('el descuento máximo configurado se sigue aplicando con IGV activo', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.create({ ...validCreateInput, discountAmount: '1.01' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('la vigencia por defecto sigue aplicándose con IGV activo (expirationDate omitido)', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ taxEnabled: true, quoteValidityDays: 15 }),
        );
        await service.create(validCreateInputWithoutExpiration);
        const createArgs = prisma.tx.quote.create.mock.calls[0][0] as {
          data: { expirationDate: Date };
        };
        expect(createArgs.data.expirationDate.toISOString()).toBe(
          '2026-03-30T00:00:00.000Z',
        );
      });

      it('expirationDate explícito sigue funcionando con IGV activo', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ taxEnabled: true }),
        );
        await expect(
          service.create({
            ...validCreateInput,
            expirationDate: '2026-12-25',
          }),
        ).resolves.toBeDefined();
      });
    });

    it('llama a DocumentSequenceService.next() después de validar cliente/producto', async () => {
      await service.create(validCreateInput);
      expect(sequenceService.next).toHaveBeenCalledTimes(1);
      expect(prisma.tx.customer.findUnique).toHaveBeenCalled();
      expect(prisma.tx.product.findUnique).toHaveBeenCalled();
    });

    it('DocumentSequenceService.next() recibe el mismo tx', async () => {
      await service.create(validCreateInput);
      expect(sequenceService.next).toHaveBeenCalledWith(
        prisma.tx,
        DocumentType.QUOTE,
      );
    });

    it('la auditoría usa el mismo tx', async () => {
      await service.create(validCreateInput);
      const call = auditService.record.mock.calls[0][0] as { client: unknown };
      expect(call.client).toBe(prisma.tx);
    });

    it('nunca invoca product.update (la propiedad ni siquiera existe en el mock)', async () => {
      await service.create(validCreateInput);
      expect(
        (prisma.tx.product as unknown as { update?: unknown }).update,
      ).toBeUndefined();
    });

    it('registra auditoría QUOTE_CREATED con la whitelist esperada', async () => {
      await service.create(validCreateInput);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.QUOTE_CREATED,
          entityType: 'Quote',
          module: 'QUOTES',
          metadata: {
            quoteNumber: 'COT-000001',
            customerId: CUSTOMER_ID,
            itemCount: 1,
          },
        }),
      );
    });

    it('respuesta segura vía mapper', async () => {
      const result = await service.create(validCreateInput);
      expect(result.number).toBe('COT-000001');
      expect(result.status).toBe(QuoteStatus.PENDING);
    });

    it('stockInfo.sufficient=true cuando hay stock suficiente', async () => {
      const base = makeQuoteDetailRow();
      prisma.tx.quote.create.mockResolvedValue(
        makeQuoteDetailRow({
          items: [
            {
              ...((base.items as unknown[])[0] as Record<string, unknown>),
              product: {
                stockCurrent: new Prisma.Decimal('100.000'),
                isInventoryTracked: true,
              },
            },
          ],
        }),
      );
      const result = await service.create(validCreateInput);
      expect(result.items[0].stockInfo?.sufficient).toBe(true);
    });

    it('stockInfo.sufficient=false pero la creación igual tiene éxito', async () => {
      const base = makeQuoteDetailRow();
      prisma.tx.quote.create.mockResolvedValue(
        makeQuoteDetailRow({
          items: [
            {
              ...((base.items as unknown[])[0] as Record<string, unknown>),
              quantity: new Prisma.Decimal('5'),
              product: {
                stockCurrent: new Prisma.Decimal('1.000'),
                isInventoryTracked: true,
              },
            },
          ],
        }),
      );
      const result = await service.create(validCreateInput);
      expect(result.items[0].stockInfo?.sufficient).toBe(false);
      expect(result.id).toBe(QUOTE_ID);
    });

    it('producto no inventariable: stockInfo null', async () => {
      const base = makeQuoteDetailRow();
      prisma.tx.quote.create.mockResolvedValue(
        makeQuoteDetailRow({
          items: [
            {
              ...((base.items as unknown[])[0] as Record<string, unknown>),
              product: {
                stockCurrent: new Prisma.Decimal('0'),
                isInventoryTracked: false,
              },
            },
          ],
        }),
      );
      const result = await service.create(validCreateInput);
      expect(result.items[0].stockInfo).toBeNull();
    });
  });

  describe('update', () => {
    const baseUpdateInput = { quoteId: QUOTE_ID, actorUserId: ACTOR_ID };

    it('inexistente: 404', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.update({ ...baseUpdateInput, notes: 'x' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('PENDING: actualización exitosa', async () => {
      await expect(
        service.update({ ...baseUpdateInput, notes: 'Nota' }),
      ).resolves.toBeDefined();
    });

    it('ACCEPTED (almacenado, vigente): 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.ACCEPTED }),
      ]);
      await expect(
        service.update({ ...baseUpdateInput, notes: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('REJECTED: 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.REJECTED }),
      ]);
      await expect(
        service.update({ ...baseUpdateInput, notes: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('vencida efectivamente (PENDING almacenado, fecha pasada): 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({
          expirationDate: new Date('2026-03-01T00:00:00.000Z'),
        }),
      ]);
      await expect(
        service.update({ ...baseUpdateInput, notes: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('EXPIRED almacenado: 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.EXPIRED }),
      ]);
      await expect(
        service.update({ ...baseUpdateInput, notes: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('CONVERTED: 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.CONVERTED }),
      ]);
      await expect(
        service.update({ ...baseUpdateInput, notes: 'x' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('solo notes: subtotal/ítems no cambian', async () => {
      await service.update({ ...baseUpdateInput, notes: 'Solo notas' });
      const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
        data: {
          notes: string | null;
          items?: unknown;
          subtotal: Prisma.Decimal;
        };
      };
      expect(updateArgs.data.notes).toBe('Solo notas');
      expect(updateArgs.data.items).toBeUndefined();
      expect(updateArgs.data.subtotal.toFixed(2)).toBe('10.00');
    });

    it('solo discount: recalcula total, conserva subtotal/ítems', async () => {
      await service.update({ ...baseUpdateInput, discountAmount: '2.00' });
      const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
        data: {
          discountAmount: Prisma.Decimal;
          total: Prisma.Decimal;
          items?: unknown;
        };
      };
      expect(updateArgs.data.discountAmount.toFixed(2)).toBe('2.00');
      expect(updateArgs.data.total.toFixed(2)).toBe('8.00');
      expect(updateArgs.data.items).toBeUndefined();
    });

    it('solo expirationDate', async () => {
      await service.update({
        ...baseUpdateInput,
        expirationDate: '2026-04-01',
      });
      const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
        data: { expirationDate: Date };
      };
      expect(updateArgs.data.expirationDate.toISOString()).toBe(
        '2026-04-01T00:00:00.000Z',
      );
    });

    it('items omitido: conserva los ítems actuales (sin deleteMany)', async () => {
      await service.update({ ...baseUpdateInput, notes: 'x' });
      expect(prisma.tx.quoteItem.deleteMany).not.toHaveBeenCalled();
    });

    it('items reemplazados: deleteMany + create, snapshot desde el catálogo vigente', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(
        makeProductRow({ salePrice: new Prisma.Decimal('20.00') }),
      );
      await service.update({
        ...baseUpdateInput,
        items: [{ productId: PRODUCT_ID, quantity: '2' }],
      });
      expect(prisma.tx.quoteItem.deleteMany).toHaveBeenCalledWith({
        where: { quoteId: QUOTE_ID },
      });
      const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
        data: {
          items: { create: { unitPrice: Prisma.Decimal }[] };
          subtotal: Prisma.Decimal;
        };
      };
      expect(updateArgs.data.items.create[0].unitPrice.toFixed(2)).toBe(
        '20.00',
      );
      expect(updateArgs.data.subtotal.toFixed(2)).toBe('40.00');
    });

    it('items []: 400', async () => {
      await expect(
        service.update({ ...baseUpdateInput, items: [] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('productos duplicados en items: 400 antes de abrir la transacción', async () => {
      await expect(
        service.update({
          ...baseUpdateInput,
          items: [
            { productId: PRODUCT_ID, quantity: '1' },
            { productId: PRODUCT_ID, quantity: '1' },
          ],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('producto inválido en el reemplazo: propaga el error', async () => {
      prisma.tx.product.findUnique.mockResolvedValue(
        makeProductRow({ status: ProductStatus.INACTIVE }),
      );
      await expect(
        service.update({
          ...baseUpdateInput,
          items: [{ productId: PRODUCT_ID, quantity: '1' }],
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cantidad inválida para la unidad en el reemplazo', async () => {
      await expect(
        service.update({
          ...baseUpdateInput,
          items: [{ productId: PRODUCT_ID, quantity: '1.5' }],
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('snapshots de cliente/vendedor/número/estado no cambian', async () => {
      await service.update({ ...baseUpdateInput, notes: 'x' });
      const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArgs.data.customerId).toBeUndefined();
      expect(updateArgs.data.sellerId).toBeUndefined();
      expect(updateArgs.data.number).toBeUndefined();
      expect(updateArgs.data.status).toBeUndefined();
      expect(updateArgs.data.customerName).toBeUndefined();
    });

    it('usa el lock de fila (SELECT ... FOR UPDATE) exactamente una vez', async () => {
      await service.update({ ...baseUpdateInput, notes: 'x' });
      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('misma transacción para la escritura y la auditoría', async () => {
      await service.update({ ...baseUpdateInput, notes: 'x' });
      const call = auditService.record.mock.calls[0][0] as { client: unknown };
      expect(call.client).toBe(prisma.tx);
    });

    it('updatedFields contiene solo nombres de campo (incluye taxAmount cuando el cambio es comercial)', async () => {
      await service.update({
        ...baseUpdateInput,
        notes: 'x',
        discountAmount: '1.00',
      });
      const call = auditService.record.mock.calls[0][0] as {
        metadata: { updatedFields: string[] };
      };
      // discountAmount difiere del existente (0) -> cambio comercial ->
      // taxAmount se recalcula y se agrega a updatedFields (Fase 10, Bloque C).
      expect(call.metadata.updatedFields.sort()).toEqual(
        ['discountAmount', 'notes', 'taxAmount'].sort(),
      );
    });

    it('items reemplazados agrega "items" a updatedFields (nunca subtotal/total)', async () => {
      await service.update({
        ...baseUpdateInput,
        items: [{ productId: PRODUCT_ID, quantity: '1' }],
      });
      const call = auditService.record.mock.calls[0][0] as {
        metadata: { updatedFields: string[] };
      };
      expect(call.metadata.updatedFields).toContain('items');
      // Reemplazar items es un cambio comercial (Fase 10, Bloque C): el
      // impuesto se recalcula y también se refleja en updatedFields.
      expect(call.metadata.updatedFields).toContain('taxAmount');
      expect(call.metadata.updatedFields).not.toContain('subtotal');
      expect(call.metadata.updatedFields).not.toContain('total');
    });

    it('body sin campos efectivos: 400', async () => {
      await expect(
        service.update({ quoteId: QUOTE_ID, actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no muta stock (product.update no existe en el mock)', async () => {
      await service.update({ ...baseUpdateInput, notes: 'x' });
      expect(
        (prisma.tx.product as unknown as { update?: unknown }).update,
      ).toBeUndefined();
    });

    describe('Bloque 10, B — revalidación de descuento máximo solo ante cambio comercial efectivo', () => {
      it('actualización puramente no comercial (solo notes): cero llamadas a SettingsReader', async () => {
        await service.update({ ...baseUpdateInput, notes: 'x' });
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
      });

      it('actualización puramente no comercial (solo expirationDate): cero llamadas a SettingsReader', async () => {
        await service.update({
          ...baseUpdateInput,
          expirationDate: '2026-04-01',
        });
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
      });

      it('cotización histórica por encima del límite recién endurecido: una edición NO comercial sigue permitida (sin revalidar)', async () => {
        // Cotización almacenada: subtotal=10.00, discountAmount=0 (mock
        // base) — se simula "históricamente por encima" ajustando el mock
        // de lock a un descuento del 30% ya persistido.
        prisma.tx.$queryRaw.mockResolvedValue([
          makeLockedQuoteRow({ discountAmount: new Prisma.Decimal('3.00') }),
        ]);
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.update({ ...baseUpdateInput, notes: 'Solo una nota' }),
        ).resolves.toBeDefined();
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
      });

      it('discountAmount reenviado con el MISMO valor ya persistido: no se trata como cambio comercial (sin SettingsReader)', async () => {
        // makeLockedQuoteRow por defecto: discountAmount = 0.
        await service.update({ ...baseUpdateInput, discountAmount: '0.00' });
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
      });

      it('discountAmount cambiado a un valor distinto: revalida contra el máximo VIGENTE (una sola lectura)', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.update({ ...baseUpdateInput, discountAmount: '1.00' }),
        ).resolves.toBeDefined();
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
        expect(settingsReader.getCurrent).toHaveBeenCalledWith(prisma.tx);
      });

      it('discountAmount cambiado por encima del máximo vigente: 400', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.update({ ...baseUpdateInput, discountAmount: '1.01' }),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('items reemplazados (subtotal cambia): revalida contra el máximo vigente (una sola lectura), ratio por encima del límite -> 400', async () => {
        // 2 unidades x 10.00 = subtotal 20.00; descuento existente 0 se
        // mantiene (no se envía discountAmount), así que el ratio efectivo
        // es 0% -> dentro del límite. Se fuerza un discountAmount explícito
        // alto junto al reemplazo de items para probar el rechazo.
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.update({
            ...baseUpdateInput,
            items: [{ productId: PRODUCT_ID, quantity: '2' }],
            discountAmount: '3.00',
          }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
      });

      it('items reemplazados dentro del límite vigente: permitido', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            maxDiscountPercent: new Prisma.Decimal('10.00'),
          }),
        );
        await expect(
          service.update({
            ...baseUpdateInput,
            items: [{ productId: PRODUCT_ID, quantity: '2' }],
            discountAmount: '2.00',
          }),
        ).resolves.toBeDefined();
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
      });

      it('reemplazo de items siempre revalida, incluso si el subtotal resultante coincide por coincidencia con el anterior', async () => {
        // El producto por defecto cuesta 10.00; reemplazar por la misma
        // cantidad (1) produce el mismo subtotal (10.00), pero el
        // reemplazo de items SIEMPRE cuenta como cambio comercial (§14/§15
        // del plan aprobado): se evalúa igual, sin importar el resultado.
        await service.update({
          ...baseUpdateInput,
          items: [{ productId: PRODUCT_ID, quantity: '1' }],
        });
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
      });
    });

    describe('Bloque 10, C — IGV en la actualización de la cotización', () => {
      it('actualización NO comercial: cero SettingsReader, taxAmount histórico preservado exacto', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([
          makeLockedQuoteRow({ taxAmount: new Prisma.Decimal('1.80') }),
        ]);
        await service.update({ ...baseUpdateInput, notes: 'Solo una nota' });
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: { taxAmount?: Prisma.Decimal; total: Prisma.Decimal };
        };
        // taxAmount no se toca en absoluto (ni siquiera se envía al UPDATE).
        expect(updateArgs.data.taxAmount).toBeUndefined();
        // total = subtotal(10.00) - discount(0) + taxAmount histórico(1.80).
        expect(updateArgs.data.total.toFixed(2)).toBe('11.80');
      });

      it('transición tax deshabilitado -> habilitado: edición no comercial preserva el 0.00 histórico', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([
          makeLockedQuoteRow({ taxAmount: new Prisma.Decimal('0.00') }),
        ]);
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
          }),
        );
        await service.update({ ...baseUpdateInput, notes: 'x' });
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: { total: Prisma.Decimal };
        };
        expect(updateArgs.data.total.toFixed(2)).toBe('10.00');
      });

      it('cambio comercial (discountAmount): recalcula taxAmount con la configuración VIGENTE (una sola lectura)', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([
          makeLockedQuoteRow({ taxAmount: new Prisma.Decimal('1.80') }),
        ]);
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
          }),
        );
        await service.update({ ...baseUpdateInput, discountAmount: '2.00' });
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
        };
        // taxableBase = 10.00 - 2.00 = 8.00; tax = 1.44.
        expect(updateArgs.data.taxAmount.toFixed(2)).toBe('1.44');
        expect(updateArgs.data.total.toFixed(2)).toBe('9.44');
      });

      it('transición 18% -> 10% vigente: edición no comercial preserva el monto histórico al 18%', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([
          makeLockedQuoteRow({ taxAmount: new Prisma.Decimal('1.80') }),
        ]);
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('10.00'),
          }),
        );
        await service.update({ ...baseUpdateInput, notes: 'x' });
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: { total: Prisma.Decimal };
        };
        // Preserva EXACTO el histórico (1.80 al 18%), nunca recalcula al 10%.
        expect(updateArgs.data.total.toFixed(2)).toBe('11.80');
      });

      it('transición 18% -> 10% vigente: edición comercial SÍ recalcula al 10% actual', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([
          makeLockedQuoteRow({ taxAmount: new Prisma.Decimal('1.80') }),
        ]);
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('10.00'),
          }),
        );
        await service.update({ ...baseUpdateInput, discountAmount: '1.00' });
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
        };
        // taxableBase = 10.00 - 1.00 = 9.00; tax al 10% = 0.90.
        expect(updateArgs.data.taxAmount.toFixed(2)).toBe('0.90');
        expect(updateArgs.data.total.toFixed(2)).toBe('9.90');
      });

      it('reemplazo de items (cambio comercial): recalcula taxAmount con la configuración vigente', async () => {
        prisma.tx.product.findUnique.mockResolvedValue(
          makeProductRow({ salePrice: new Prisma.Decimal('20.00') }),
        );
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
          }),
        );
        await service.update({
          ...baseUpdateInput,
          items: [{ productId: PRODUCT_ID, quantity: '2' }],
        });
        expect(settingsReader.getCurrent).toHaveBeenCalledTimes(1);
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: {
            subtotal: Prisma.Decimal;
            taxAmount: Prisma.Decimal;
            total: Prisma.Decimal;
          };
        };
        // subtotal = 2 x 20.00 = 40.00; tax al 18% = 7.20.
        expect(updateArgs.data.subtotal.toFixed(2)).toBe('40.00');
        expect(updateArgs.data.taxAmount.toFixed(2)).toBe('7.20');
        expect(updateArgs.data.total.toFixed(2)).toBe('47.20');
      });

      it('descuento total en un cambio comercial: taxAmount recalculado a 0.00, sin anomalía', async () => {
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({
            taxEnabled: true,
            taxRate: new Prisma.Decimal('18.00'),
            maxDiscountPercent: new Prisma.Decimal('100.00'),
          }),
        );
        await service.update({ ...baseUpdateInput, discountAmount: '10.00' });
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: { taxAmount: Prisma.Decimal; total: Prisma.Decimal };
        };
        expect(updateArgs.data.taxAmount.toFixed(2)).toBe('0.00');
        expect(updateArgs.data.total.toFixed(2)).toBe('0.00');
      });

      it('no hay mutación retroactiva: una edición no comercial nunca escribe taxAmount aunque taxEnabled/taxRate hayan cambiado', async () => {
        prisma.tx.$queryRaw.mockResolvedValue([
          makeLockedQuoteRow({ taxAmount: new Prisma.Decimal('1.80') }),
        ]);
        settingsReader.getCurrent.mockResolvedValue(
          makeSettingsSnapshot({ taxEnabled: false }),
        );
        await service.update({
          ...baseUpdateInput,
          expirationDate: '2026-05-01',
        });
        expect(settingsReader.getCurrent).not.toHaveBeenCalled();
        const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
          data: { taxAmount?: Prisma.Decimal };
        };
        expect(updateArgs.data.taxAmount).toBeUndefined();
      });
    });
  });

  describe.each([
    ['accept', QuoteStatus.ACCEPTED, AuditAction.QUOTE_ACCEPTED] as const,
    ['reject', QuoteStatus.REJECTED, AuditAction.QUOTE_REJECTED] as const,
  ])('%s', (methodName, nextStatus, auditAction) => {
    const actionInput = { quoteId: QUOTE_ID, actorUserId: ACTOR_ID };

    it('PENDING vigente -> transición exitosa', async () => {
      const result = await service[methodName](actionInput);
      expect(result.id).toBe(QUOTE_ID);
      const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
        data: { status: QuoteStatus };
      };
      expect(updateArgs.data.status).toBe(nextStatus);
    });

    it('PENDING vencido (efectivo EXPIRED): 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({
          expirationDate: new Date('2026-03-01T00:00:00.000Z'),
        }),
      ]);
      await expect(service[methodName](actionInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('ACCEPTED: 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.ACCEPTED }),
      ]);
      await expect(service[methodName](actionInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('REJECTED: 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.REJECTED }),
      ]);
      await expect(service[methodName](actionInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('EXPIRED almacenado: 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.EXPIRED }),
      ]);
      await expect(service[methodName](actionInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('CONVERTED: 409', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedQuoteRow({ status: QuoteStatus.CONVERTED }),
      ]);
      await expect(service[methodName](actionInput)).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('inexistente: 404', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(service[methodName](actionInput)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('usa el lock de fila', async () => {
      await service[methodName](actionInput);
      expect(prisma.tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('registra auditoría con previousStatus=PENDING, mismo tx', async () => {
      await service[methodName](actionInput);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: auditAction,
          metadata: {
            quoteNumber: 'COT-000001',
            previousStatus: QuoteStatus.PENDING,
          },
          client: prisma.tx,
        }),
      );
    });

    it('nunca persiste EXPIRED ni CONVERTED', async () => {
      await service[methodName](actionInput);
      const updateArgs = prisma.tx.quote.update.mock.calls[0][0] as {
        data: { status: QuoteStatus };
      };
      expect(updateArgs.data.status).not.toBe(QuoteStatus.EXPIRED);
      expect(updateArgs.data.status).not.toBe(QuoteStatus.CONVERTED);
    });
  });

  describe('list', () => {
    beforeEach(() => {
      prisma.quote.findMany.mockResolvedValue([]);
      prisma.quote.count.mockResolvedValue(0);
    });

    it('paginación por defecto (page=1, limit=20)', async () => {
      await service.list({}, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        skip: number;
        take: number;
      };
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });

    it('límite máximo 100', async () => {
      await service.list({ limit: 500 }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as { take: number };
      expect(args.take).toBe(100);
    });

    it('filtra por customerId', async () => {
      await service.list({ customerId: CUSTOMER_ID }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({ customerId: CUSTOMER_ID });
    });

    it('filtra por sellerId', async () => {
      await service.list({ sellerId: ACTOR_ID }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({ sellerId: ACTOR_ID });
    });

    it('rango de issueDate', async () => {
      await service.list(
        { issueDateFrom: '2026-01-01', issueDateTo: '2026-01-31' },
        RoleName.ADMIN,
      );
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({
        issueDate: { gte: new Date('2026-01-01T00:00:00.000Z') },
      });
      expect(args.where.AND).toContainEqual({
        issueDate: { lte: new Date('2026-01-31T00:00:00.000Z') },
      });
    });

    it('rango de issueDate inválido (from > to): 400', async () => {
      await expect(
        service.list(
          { issueDateFrom: '2026-02-01', issueDateTo: '2026-01-01' },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('rango de expirationDate inválido (from > to): 400', async () => {
      await expect(
        service.list(
          { expirationDateFrom: '2026-02-01', expirationDateTo: '2026-01-01' },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('búsqueda genera OR sobre number/customerName/customerDocumentNumber', async () => {
      await service.list({ search: 'juan' }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({
        OR: [
          { number: { contains: 'juan', mode: 'insensitive' } },
          { customerName: { contains: 'juan', mode: 'insensitive' } },
          { customerDocumentNumber: { contains: 'juan', mode: 'insensitive' } },
        ],
      });
    });

    it('búsqueda de solo espacios se omite', async () => {
      await service.list({ search: '   ' }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND?: unknown[] };
      };
      expect(args.where.AND).toBeUndefined();
    });

    it('orden determinista fijo: createdAt desc, id desc', async () => {
      await service.list({}, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('status=EXPIRED usa el predicado OR con la fecha de negocio (no CURRENT_DATE)', async () => {
      await service.list({ status: QuoteStatus.EXPIRED }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({
        OR: [
          { status: QuoteStatus.EXPIRED },
          {
            status: { in: [QuoteStatus.PENDING, QuoteStatus.ACCEPTED] },
            expirationDate: { lt: new Date(`${FIXED_TODAY}T00:00:00.000Z`) },
          },
        ],
      });
    });

    it('status=PENDING excluye vencidas', async () => {
      await service.list({ status: QuoteStatus.PENDING }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({
        status: QuoteStatus.PENDING,
        expirationDate: { gte: new Date(`${FIXED_TODAY}T00:00:00.000Z`) },
      });
    });

    it('status=ACCEPTED excluye vencidas', async () => {
      await service.list({ status: QuoteStatus.ACCEPTED }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({
        status: QuoteStatus.ACCEPTED,
        expirationDate: { gte: new Date(`${FIXED_TODAY}T00:00:00.000Z`) },
      });
    });

    it('status=REJECTED sin condición de fecha (incluye histórico)', async () => {
      await service.list({ status: QuoteStatus.REJECTED }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({ status: QuoteStatus.REJECTED });
    });

    it('status=CONVERTED sin condición de fecha', async () => {
      await service.list({ status: QuoteStatus.CONVERTED }, RoleName.ADMIN);
      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: unknown[] };
      };
      expect(args.where.AND).toContainEqual({ status: QuoteStatus.CONVERTED });
    });

    it('findMany y count usan el mismo where', async () => {
      await service.list(
        { customerId: CUSTOMER_ID, search: 'ana' },
        RoleName.ADMIN,
      );
      const findManyWhere = (
        prisma.quote.findMany.mock.calls[0][0] as { where: unknown }
      ).where;
      const countWhere = (
        prisma.quote.count.mock.calls[0][0] as { where: unknown }
      ).where;
      expect(findManyWhere).toEqual(countWhere);
    });

    it.each([RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT])(
      '%s tiene acceso de lectura (consulta Prisma)',
      async (role) => {
        await service.list({}, role);
        expect(prisma.quote.findMany).toHaveBeenCalled();
      },
    );

    it('WAREHOUSE: página vacía sin consultar Prisma', async () => {
      const result = await service.list({}, RoleName.WAREHOUSE);
      expect(result).toEqual({
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      });
      expect(prisma.quote.findMany).not.toHaveBeenCalled();
      expect(prisma.quote.count).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado igual que WAREHOUSE', async () => {
      const result = await service.list({}, 'UNKNOWN' as RoleName);
      expect(result.data).toEqual([]);
      expect(prisma.quote.findMany).not.toHaveBeenCalled();
    });

    it('página vacía es válida (total=0 => totalPages=0)', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('findOne', () => {
    it('encontrada: devuelve forma segura', async () => {
      prisma.quote.findUnique.mockResolvedValue(makeQuoteDetailRow());
      const result = await service.findOne(QUOTE_ID, RoleName.ADMIN);
      expect(result.id).toBe(QUOTE_ID);
    });

    it('mapea el estado efectivo (vencida por fecha)', async () => {
      prisma.quote.findUnique.mockResolvedValue(
        makeQuoteDetailRow({
          expirationDate: new Date('2026-03-01T00:00:00.000Z'),
        }),
      );
      const result = await service.findOne(QUOTE_ID, RoleName.ADMIN);
      expect(result.status).toBe(QuoteStatus.EXPIRED);
    });

    it('stockInfo en vivo', async () => {
      prisma.quote.findUnique.mockResolvedValue(makeQuoteDetailRow());
      const result = await service.findOne(QUOTE_ID, RoleName.ADMIN);
      expect(result.items[0].stockInfo).not.toBeNull();
    });

    it('vendedor solo con campos seguros', async () => {
      prisma.quote.findUnique.mockResolvedValue(makeQuoteDetailRow());
      const result = await service.findOne(QUOTE_ID, RoleName.ADMIN);
      expect(Object.keys(result.seller).sort()).toEqual(
        ['id', 'username', 'firstName', 'lastName'].sort(),
      );
    });

    it('no filtra por Customer/Product/User más allá del vendedor seguro (sin leak)', async () => {
      prisma.quote.findUnique.mockResolvedValue(makeQuoteDetailRow());
      const result = await service.findOne(QUOTE_ID, RoleName.ADMIN);
      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/passwordHash|roleId|internalNotes/i);
    });

    it('inexistente: 404', async () => {
      prisma.quote.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne(QUOTE_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('WAREHOUSE: 404 sin consultar Prisma', async () => {
      await expect(
        service.findOne(QUOTE_ID, RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.quote.findUnique).not.toHaveBeenCalled();
    });

    it('rol desconocido: 404 (fail-closed)', async () => {
      await expect(
        service.findOne(QUOTE_ID, 'UNKNOWN' as RoleName),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
