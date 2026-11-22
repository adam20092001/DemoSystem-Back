import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  AccountingSourceType,
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  PurchasePurpose,
  RoleName,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { StockMovementEngine } from '../inventory/stock-movement.engine';
import { InventoryValuationEngine } from '../inventory-valuation/inventory-valuation.engine';
import {
  PurchaseReceiptsService,
  WAREHOUSE_ACCOUNTING_CONFIG_MESSAGE,
} from './purchase-receipts.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const PURCHASE_INVOICE_ID = '99999999-9999-4999-8999-999999999999';
const PURCHASE_INVOICE_LINE_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const PRODUCT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const PURCHASE_RECEIPT_ID = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const PURCHASE_RECEIPT_LINE_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-03-20T00:00:00.000Z');

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeLockedInvoiceRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: PURCHASE_INVOICE_ID,
    status: 'CONFIRMED',
    postedEntryId: ENTRY_ID,
    documentType: 'FACTURA',
    documentSeries: 'F001',
    documentNumber: '123',
    ...overrides,
  };
}

function makeLockedLineRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PURCHASE_INVOICE_LINE_ID,
    purchaseInvoiceId: PURCHASE_INVOICE_ID,
    isReceiptEligible: true,
    quantity: d('10.000'),
    productId: PRODUCT_ID,
    purchasePurpose: PurchasePurpose.RESALE_INVENTORY,
    taxableBaseAmount: d('100.00'),
    taxAmount: d('18.00'),
    creditableTaxAmount: d('18.00'),
    ...overrides,
  };
}

function makeSafeReceiptRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PURCHASE_RECEIPT_ID,
    purchaseInvoiceId: PURCHASE_INVOICE_ID,
    receivedDate: new Date('2026-03-20T00:00:00.000Z'),
    status: 'ACTIVE',
    idempotencyKey: null,
    notes: null,
    createdByUserId: ACTOR_ID,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    reclassificationEntryId: null,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [
      {
        id: PURCHASE_RECEIPT_LINE_ID,
        purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
        quantity: d('4.000'),
        reclassifiedAmount: null,
        location: null,
      },
    ],
    ...overrides,
  };
}

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
    purchaseReceipt: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      create: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [unknown]>(),
    },
    purchaseReceiptLine: {
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    account: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    accountingEntryLine: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    importReceiptLink: {
      findFirst: jest.fn<Promise<unknown>, [unknown]>(),
    },
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    purchaseReceipt: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    purchaseInvoice: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    purchaseReceiptLine: {
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function createStockMovementEngineMock() {
  return {
    apply: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    // R2-ACT: bloqueo previo de catálogo; null/undefined => ubicación DEFAULT.
    lockLocationsShared: jest.fn(
      (_tx: unknown, requested: ReadonlyArray<string | null | undefined>) =>
        Promise.resolve(
          requested.map((id) => id ?? '77777777-7777-4777-8777-777777777777'),
        ),
    ),
  };
}

function createAccountingEngineMock() {
  return {
    postPurchaseReceiptReclassification: jest.fn<
      Promise<unknown>,
      [unknown, unknown]
    >(),
    reverseOriginalForSource: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

function createInventoryValuationEngineMock() {
  return {
    recordOriginal: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    reverseForReceiptLine: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

describe('PurchaseReceiptsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let stockMovementEngine: ReturnType<typeof createStockMovementEngineMock>;
  let accountingEngine: ReturnType<typeof createAccountingEngineMock>;
  let inventoryValuationEngine: ReturnType<
    typeof createInventoryValuationEngineMock
  >;
  let service: PurchaseReceiptsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    stockMovementEngine = createStockMovementEngineMock();
    stockMovementEngine.apply.mockResolvedValue({ id: 'movement-1' });
    accountingEngine = createAccountingEngineMock();
    // Por defecto (producto sin valuationMethod configurado): no-op,
    // mismo comportamiento que antes de A6.1.
    inventoryValuationEngine = createInventoryValuationEngineMock();
    inventoryValuationEngine.recordOriginal.mockResolvedValue(null);
    inventoryValuationEngine.reverseForReceiptLine.mockResolvedValue(null);
    // Por defecto (Fase B3): ningún vínculo de importación activo —
    // los tests dedicados a ese guardia lo sobrescriben.
    prisma.tx.importReceiptLink.findFirst.mockResolvedValue(null);

    service = new PurchaseReceiptsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      stockMovementEngine as unknown as StockMovementEngine,
      accountingEngine as unknown as AccountingEngine,
      inventoryValuationEngine as unknown as InventoryValuationEngine,
    );

    // Camino feliz por defecto: lock de factura, lock de línea, sin
    // recepciones previas, sin ninguna cuenta mapeada (sin reclasificación).
    prisma.tx.$queryRaw
      .mockResolvedValueOnce([makeLockedInvoiceRow()])
      .mockResolvedValueOnce([makeLockedLineRow()]);
    prisma.tx.purchaseReceiptLine.groupBy.mockResolvedValue([]);
    prisma.tx.account.findMany.mockResolvedValue([]);
    prisma.tx.purchaseReceipt.create.mockResolvedValue(makeSafeReceiptRow());
    prisma.tx.purchaseReceipt.findUniqueOrThrow.mockResolvedValue(
      makeSafeReceiptRow(),
    );
  });

  function createInput(
    overrides: Partial<Parameters<PurchaseReceiptsService['create']>[0]> = {},
  ) {
    return {
      purchaseInvoiceId: PURCHASE_INVOICE_ID,
      lines: [
        { purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID, quantity: '4.000' },
      ],
      requesterRole: RoleName.ADMIN,
      actorUserId: ACTOR_ID,
      ipAddress: null,
      ...overrides,
    };
  }

  // ====================================================================
  // Permisos
  // ====================================================================
  describe('permisos', () => {
    function cancelInput(role: RoleName) {
      return {
        purchaseReceiptId: PURCHASE_RECEIPT_ID,
        reason: 'motivo',
        requesterRole: role,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      };
    }

    it('SELLER no puede leer ni escribir', async () => {
      await expect(
        service.findOne(PURCHASE_RECEIPT_ID, RoleName.SELLER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.listByInvoice(PURCHASE_INVOICE_ID, RoleName.SELLER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.create(createInput({ requesterRole: RoleName.SELLER })),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(
        service.cancel(cancelInput(RoleName.SELLER)),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.tx.purchaseReceipt.create).not.toHaveBeenCalled();
    });

    it.each([RoleName.MANAGEMENT, RoleName.ACCOUNTANT, RoleName.PURCHASING])(
      '%s puede leer pero nunca registrar ni anular',
      async (role) => {
        prisma.purchaseReceipt.findUnique.mockResolvedValue(
          makeSafeReceiptRow(),
        );
        await expect(
          service.findOne(PURCHASE_RECEIPT_ID, role),
        ).resolves.toBeDefined();
        await expect(
          service.create(createInput({ requesterRole: role })),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.cancel(cancelInput(role))).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(prisma.tx.purchaseReceipt.create).not.toHaveBeenCalled();
      },
    );

    it('R1: WAREHOUSE puede leer y registrar la recepción física, pero nunca anularla', async () => {
      prisma.purchaseReceipt.findUnique.mockResolvedValue(makeSafeReceiptRow());
      await expect(
        service.findOne(PURCHASE_RECEIPT_ID, RoleName.WAREHOUSE),
      ).resolves.toBeDefined();
      await expect(
        service.create(createInput({ requesterRole: RoleName.WAREHOUSE })),
      ).resolves.toBeDefined();
      await expect(
        service.cancel(cancelInput(RoleName.WAREHOUSE)),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('anular es exclusivo de ADMIN: pasa la guardia y llega a la lógica de negocio', async () => {
      prisma.tx.$queryRaw.mockReset();
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.cancel(cancelInput(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  // ====================================================================
  // R1: protección financiera (WAREHOUSE nunca recibe importes)
  // ====================================================================
  describe('R1: visibilidad financiera por rol', () => {
    const financialRow = () =>
      makeSafeReceiptRow({
        reclassificationEntryId: ENTRY_ID,
        lines: [
          {
            id: PURCHASE_RECEIPT_LINE_ID,
            purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
            quantity: d('4.000'),
            reclassifiedAmount: d('33.33'),
          },
        ],
      });

    it('WAREHOUSE: findOne omite reclassificationEntryId y reclassifiedAmount (las claves no existen)', async () => {
      prisma.purchaseReceipt.findUnique.mockResolvedValue(financialRow());
      const result = await service.findOne(
        PURCHASE_RECEIPT_ID,
        RoleName.WAREHOUSE,
      );
      expect(result).not.toHaveProperty('reclassificationEntryId');
      expect(result.lines[0]).not.toHaveProperty('reclassifiedAmount');
      expect(JSON.stringify(result)).not.toContain('33.33');
      expect(JSON.stringify(result)).not.toContain(ENTRY_ID);
      expect(result.lines[0].quantity).toBe('4.000');
    });

    it.each([
      RoleName.ADMIN,
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
      RoleName.PURCHASING,
    ])('%s: findOne conserva los campos financieros actuales', async (role) => {
      prisma.purchaseReceipt.findUnique.mockResolvedValue(financialRow());
      const result = await service.findOne(PURCHASE_RECEIPT_ID, role);
      expect(result.reclassificationEntryId).toBe(ENTRY_ID);
      expect(result.lines[0].reclassifiedAmount).toBe('33.33');
    });

    it('WAREHOUSE: listByInvoice omite los campos financieros de cada recepción anidada', async () => {
      prisma.purchaseInvoice.findUnique.mockResolvedValue({
        id: PURCHASE_INVOICE_ID,
        lines: [
          {
            id: PURCHASE_INVOICE_LINE_ID,
            quantity: d('10.000'),
            isReceiptEligible: true,
          },
        ],
      });
      prisma.purchaseReceipt.findMany.mockResolvedValue([financialRow()]);
      prisma.purchaseReceiptLine.groupBy.mockResolvedValue([
        {
          purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
          _sum: { quantity: d('4.000') },
        },
      ]);
      const result = await service.listByInvoice(
        PURCHASE_INVOICE_ID,
        RoleName.WAREHOUSE,
      );
      expect(result.receipts[0]).not.toHaveProperty('reclassificationEntryId');
      expect(result.receipts[0].lines[0]).not.toHaveProperty(
        'reclassifiedAmount',
      );
      expect(result.lines[0]).toEqual({
        purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
        invoicedQuantity: '10.000',
        receivedQuantity: '4.000',
        pendingQuantity: '6.000',
        status: 'PARTIAL',
      });
    });

    it('WAREHOUSE: create devuelve la recepción creada sin campos financieros, incluso en un reintento idempotente', async () => {
      prisma.tx.purchaseReceipt.findUniqueOrThrow.mockResolvedValue(
        financialRow(),
      );
      const created = await service.create(
        createInput({ requesterRole: RoleName.WAREHOUSE }),
      );
      expect(created).not.toHaveProperty('reclassificationEntryId');
      expect(created.lines[0]).not.toHaveProperty('reclassifiedAmount');
    });
  });

  // ====================================================================
  // create — validaciones
  // ====================================================================
  describe('create', () => {
    it('factura inexistente (lockInvoice no encuentra la fila): NotFoundException', async () => {
      prisma.tx.$queryRaw.mockReset().mockResolvedValueOnce([]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('factura no CONFIRMED: ConflictException', async () => {
      prisma.tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([makeLockedInvoiceRow({ status: 'DRAFT' })]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(stockMovementEngine.apply).not.toHaveBeenCalled();
    });

    it('línea duplicada en la misma recepción: BadRequestException', async () => {
      await expect(
        service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '1.000',
              },
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '2.000',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('línea no elegible (isReceiptEligible=false): BadRequestException, sin movimientos de stock', async () => {
      prisma.tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([makeLockedInvoiceRow()])
        .mockResolvedValueOnce([
          makeLockedLineRow({ isReceiptEligible: false }),
        ]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(stockMovementEngine.apply).not.toHaveBeenCalled();
    });

    it('línea que no pertenece a la factura indicada: BadRequestException', async () => {
      prisma.tx.$queryRaw
        .mockReset()
        .mockResolvedValueOnce([makeLockedInvoiceRow()])
        .mockResolvedValueOnce([
          makeLockedLineRow({ purchaseInvoiceId: 'otra-factura' }),
        ]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('sobre-recepción (4 ya recibidas + 7 nuevas > 10 facturadas): ConflictException', async () => {
      prisma.tx.purchaseReceiptLine.groupBy.mockResolvedValue([
        {
          purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
          _sum: { quantity: d('4.000') },
        },
      ]);
      await expect(
        service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '7.000',
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(stockMovementEngine.apply).not.toHaveBeenCalled();
    });

    it('recepción parcial 4 de 10: camino feliz, un movimiento ENTRY', async () => {
      const result = await service.create(createInput());
      expect(result.id).toBe(PURCHASE_RECEIPT_ID);
      expect(stockMovementEngine.apply).toHaveBeenCalledTimes(1);
      const call = stockMovementEngine.apply.mock.calls[0][1] as {
        productId: string;
        quantity: Prisma.Decimal;
        movementType: InventoryMovementType;
        origin: InventoryMovementOrigin;
      };
      expect(call.productId).toBe(PRODUCT_ID);
      expect(call.quantity.toFixed(3)).toBe('4.000');
      expect(call.movementType).toBe(InventoryMovementType.ENTRY);
      expect(call.origin).toBe(InventoryMovementOrigin.PURCHASE_RECEIPT);
    });

    it('segunda recepción 6 de 10 (tras 4 ya ACTIVE): permitida, completa el total facturado', async () => {
      prisma.tx.purchaseReceiptLine.groupBy.mockResolvedValue([
        {
          purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
          _sum: { quantity: d('4.000') },
        },
      ]);
      await expect(
        service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '6.000',
              },
            ],
          }),
        ),
      ).resolves.toBeDefined();
    });

    describe('R2-ACT: ubicación y orden de bloqueos (D1)', () => {
      const LINE_A = '00000000-0000-4000-8000-0000000000a1';
      const LINE_B = '00000000-0000-4000-8000-0000000000a2';
      const PRODUCT_LOW = '00000000-0000-4000-8000-000000000001';
      const PRODUCT_HIGH = '00000000-0000-4000-8000-000000000009';

      /** Líneas bloqueadas por id ascendente (A, B) con productId en ORDEN INVERSO. */
      function setupTwoLinesInverseProductOrder(): void {
        prisma.tx.$queryRaw.mockReset();
        prisma.tx.$queryRaw
          .mockResolvedValueOnce([makeLockedInvoiceRow()])
          .mockResolvedValueOnce([
            makeLockedLineRow({ id: LINE_A, productId: PRODUCT_HIGH }),
            makeLockedLineRow({ id: LINE_B, productId: PRODUCT_LOW }),
          ]);
        prisma.tx.purchaseReceipt.create.mockResolvedValue(
          makeSafeReceiptRow({
            lines: [
              {
                id: 'r-line-a',
                purchaseInvoiceLineId: LINE_A,
                quantity: d('1.000'),
                reclassifiedAmount: null,
              },
              {
                id: 'r-line-b',
                purchaseInvoiceLineId: LINE_B,
                quantity: d('1.000'),
                reclassifiedAmount: null,
              },
            ],
          }),
        );
      }

      const twoLinesInput = () =>
        createInput({
          lines: [
            { purchaseInvoiceLineId: LINE_A, quantity: '1.000' },
            { purchaseInvoiceLineId: LINE_B, quantity: '1.000' },
          ],
        });

      it('D1: aplica las entradas en orden ascendente de productId, no en el orden de las líneas', async () => {
        setupTwoLinesInverseProductOrder();

        await service.create(twoLinesInput());

        const products = stockMovementEngine.apply.mock.calls.map(
          (call) => (call[1] as { productId: string }).productId,
        );
        expect(products).toEqual([PRODUCT_LOW, PRODUCT_HIGH]);
      });

      it('bloquea almacén y ubicación (MAIN/DEFAULT) ANTES de la primera entrada', async () => {
        await service.create(createInput());

        expect(stockMovementEngine.lockLocationsShared).toHaveBeenCalledTimes(
          1,
        );
        expect(
          stockMovementEngine.lockLocationsShared.mock.calls[0][1],
        ).toEqual([null]);
        expect(
          stockMovementEngine.lockLocationsShared.mock.invocationCallOrder[0],
        ).toBeLessThan(stockMovementEngine.apply.mock.invocationCallOrder[0]);
      });

      it('persiste locationId en cada línea de recepción y lo usa en el movimiento', async () => {
        await service.create(createInput());

        const createArgs = prisma.tx.purchaseReceipt.create.mock
          .calls[0][0] as {
          data: { lines: { create: { locationId: string }[] } };
        };
        expect(createArgs.data.lines.create[0].locationId).toBe(
          '77777777-7777-4777-8777-777777777777',
        );
        const call = stockMovementEngine.apply.mock.calls[0][1] as {
          locationId?: string;
        };
        expect(call.locationId).toBe('77777777-7777-4777-8777-777777777777');
      });
    });

    describe('R2-B2: ubicación de destino por línea', () => {
      const LINE_A = '00000000-0000-4000-8000-0000000000a1';
      const LINE_B = '00000000-0000-4000-8000-0000000000a2';
      const PRODUCT_LOW = '00000000-0000-4000-8000-000000000001';
      const PRODUCT_HIGH = '00000000-0000-4000-8000-000000000009';
      const LOC_A = '10000000-0000-4000-8000-00000000000a';
      const LOC_B = '10000000-0000-4000-8000-00000000000b';

      /** A (id menor) -> producto ALTO; B -> producto BAJO: el orden por producto invierte el de las líneas. */
      function setupInverse(): void {
        prisma.tx.$queryRaw.mockReset();
        prisma.tx.$queryRaw
          .mockResolvedValueOnce([makeLockedInvoiceRow()])
          .mockResolvedValueOnce([
            makeLockedLineRow({ id: LINE_A, productId: PRODUCT_HIGH }),
            makeLockedLineRow({ id: LINE_B, productId: PRODUCT_LOW }),
          ]);
        prisma.tx.purchaseReceipt.create.mockResolvedValue(
          makeSafeReceiptRow({
            lines: [
              {
                id: 'r-line-a',
                purchaseInvoiceLineId: LINE_A,
                quantity: d('1.000'),
                reclassifiedAmount: null,
                location: null,
              },
              {
                id: 'r-line-b',
                purchaseInvoiceLineId: LINE_B,
                quantity: d('1.000'),
                reclassifiedAmount: null,
                location: null,
              },
            ],
          }),
        );
      }

      it('pasa a lockLocationsShared la ubicación solicitada de cada línea (null si se omite)', async () => {
        setupInverse();
        await service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: LINE_A,
                quantity: '1.000',
                locationId: LOC_A,
              },
              { purchaseInvoiceLineId: LINE_B, quantity: '1.000' },
            ],
          }),
        );
        expect(
          stockMovementEngine.lockLocationsShared.mock.calls[0][1],
        ).toEqual([LOC_A, null]);
      });

      it('asocia cada ubicación a SU línea aunque el orden de proceso (por productId) sea inverso', async () => {
        setupInverse();
        // Solicitud con las líneas en orden B, A: cada una con destino propio.
        await service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: LINE_B,
                quantity: '1.000',
                locationId: LOC_B,
              },
              {
                purchaseInvoiceLineId: LINE_A,
                quantity: '1.000',
                locationId: LOC_A,
              },
            ],
          }),
        );

        const created = prisma.tx.purchaseReceipt.create.mock.calls[0][0] as {
          data: {
            lines: {
              create: { purchaseInvoiceLineId: string; locationId: string }[];
            };
          };
        };
        const persisted = new Map(
          created.data.lines.create.map((l) => [
            l.purchaseInvoiceLineId,
            l.locationId,
          ]),
        );
        expect(persisted.get(LINE_A)).toBe(LOC_A);
        expect(persisted.get(LINE_B)).toBe(LOC_B);

        // Los ENTRY se procesan por productId ascendente (B->BAJO primero) y
        // cada uno usa la ubicación de SU línea.
        const calls = stockMovementEngine.apply.mock.calls.map(
          (c) => c[1] as { productId: string; locationId?: string },
        );
        expect(calls).toEqual([
          expect.objectContaining({
            productId: PRODUCT_LOW,
            locationId: LOC_B,
          }),
          expect.objectContaining({
            productId: PRODUCT_HIGH,
            locationId: LOC_A,
          }),
        ]);
      });

      it('sin locationId: persiste y usa la ubicación predeterminada resuelta por el motor', async () => {
        await service.create(createInput());
        const call = stockMovementEngine.apply.mock.calls[0][1] as {
          locationId?: string;
        };
        expect(call.locationId).toBe('77777777-7777-4777-8777-777777777777');
      });

      it('si el motor rechaza la ubicación no se crea nada ni se mueve stock', async () => {
        stockMovementEngine.lockLocationsShared.mockRejectedValueOnce(
          new NotFoundException('Ubicación no encontrada'),
        );
        await expect(
          service.create(
            createInput({
              lines: [
                {
                  purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                  quantity: '1.000',
                  locationId: LOC_A,
                },
              ],
            }),
          ),
        ).rejects.toBeInstanceOf(NotFoundException);
        expect(prisma.tx.purchaseReceipt.create).not.toHaveBeenCalled();
        expect(stockMovementEngine.apply).not.toHaveBeenCalled();
      });

      it('idempotencia: un reintento con otra ubicación devuelve la recepción original sin bloquear ni mover nada', async () => {
        prisma.tx.purchaseReceipt.findUnique.mockResolvedValue(
          makeSafeReceiptRow({ idempotencyKey: 'retry-loc' }),
        );
        await service.create(
          createInput({
            idempotencyKey: 'retry-loc',
            lines: [
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '4.000',
                locationId: LOC_B,
              },
            ],
          }),
        );
        expect(stockMovementEngine.lockLocationsShared).not.toHaveBeenCalled();
        expect(stockMovementEngine.apply).not.toHaveBeenCalled();
        expect(prisma.tx.purchaseReceipt.create).not.toHaveBeenCalled();
      });
    });

    it('idempotencyKey ya usada: devuelve la MISMA recepción existente, sin crear nada nuevo', async () => {
      const existing = makeSafeReceiptRow({ idempotencyKey: 'retry-1' });
      prisma.tx.purchaseReceipt.findUnique.mockResolvedValue(existing);

      const result = await service.create(
        createInput({ idempotencyKey: 'retry-1' }),
      );

      expect(result.id).toBe(PURCHASE_RECEIPT_ID);
      expect(prisma.tx.purchaseReceipt.create).not.toHaveBeenCalled();
      expect(stockMovementEngine.apply).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('audita PURCHASE_RECEIPT_CREATED exactamente una vez', async () => {
      await service.create(createInput());
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
      };
      expect(call.action).toBe(AuditAction.PURCHASE_RECEIPT_CREATED);
    });

    // ------------------------------------------------------------------
    // Reclasificación contable opcional
    // ------------------------------------------------------------------
    describe('reclasificación contable', () => {
      const SOURCE_ACCOUNT_ID = 'source-account-1';
      const TARGET_ACCOUNT_ID = 'target-account-1';

      function makeSourceAccount(
        overrides: Partial<Record<string, unknown>> = {},
      ) {
        return {
          id: SOURCE_ACCOUNT_ID,
          code: 'PURCH-RESALE',
          systemKey: 'PURCHASE_RESALE_INVENTORY',
          receiptReclassificationTargetAccountId: TARGET_ACCOUNT_ID,
          ...overrides,
        };
      }

      function makeTargetAccount(
        overrides: Partial<Record<string, unknown>> = {},
      ) {
        return {
          id: TARGET_ACCOUNT_ID,
          code: 'INVENTORY-FINAL',
          status: AccountStatus.ACTIVE,
          isPostable: true,
          receiptReclassificationTargetAccountId: null,
          ...overrides,
        };
      }

      beforeEach(() => {
        prisma.tx.account.findMany.mockResolvedValue([makeSourceAccount()]);
        prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
          { accountId: SOURCE_ACCOUNT_ID },
        ]);
        prisma.tx.account.findUnique.mockResolvedValue(makeTargetAccount());
        // Por defecto: ninguna recepción previa de esta línea (es la
        // primera) — los tests de acumulación la sobrescriben.
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([]);
        accountingEngine.postPurchaseReceiptReclassification.mockResolvedValue({
          id: ENTRY_ID,
        });
      });

      it('sin ninguna cuenta configurada como tránsito: nunca llama a AccountingEngine (caso predeterminado)', async () => {
        prisma.tx.account.findMany.mockResolvedValue([
          makeSourceAccount({ receiptReclassificationTargetAccountId: null }),
        ]);
        await service.create(createInput());
        expect(
          accountingEngine.postPurchaseReceiptReclassification,
        ).not.toHaveBeenCalled();
      });

      it('cuenta configurada como tránsito: postea la reclasificación proporcional y persiste reclassifiedAmount', async () => {
        await service.create(createInput());

        expect(
          accountingEngine.postPurchaseReceiptReclassification,
        ).toHaveBeenCalledTimes(1);
        const command = accountingEngine.postPurchaseReceiptReclassification
          .mock.calls[0][1] as {
          purchaseReceiptId: string;
          lines: {
            accountId: string;
            debitAmount: Prisma.Decimal;
            creditAmount: Prisma.Decimal;
          }[];
        };
        expect(command.purchaseReceiptId).toBe(PURCHASE_RECEIPT_ID);
        const byAccount = new Map(command.lines.map((l) => [l.accountId, l]));
        // destinationAmount = 100 + (18-18) = 100; proporción 4/10 = 40.00
        expect(byAccount.get(TARGET_ACCOUNT_ID)?.debitAmount.toFixed(2)).toBe(
          '40.00',
        );
        expect(byAccount.get(SOURCE_ACCOUNT_ID)?.creditAmount.toFixed(2)).toBe(
          '40.00',
        );

        expect(prisma.tx.purchaseReceiptLine.update).toHaveBeenCalledWith({
          where: { id: PURCHASE_RECEIPT_LINE_ID },
          data: { reclassifiedAmount: expect.anything() as unknown },
        });
        expect(prisma.tx.purchaseReceipt.update).toHaveBeenCalledWith({
          where: { id: PURCHASE_RECEIPT_ID },
          data: { reclassificationEntryId: ENTRY_ID },
        });
      });

      it('tres recepciones parciales (1+1+1 de 3, destinationAmount=100.00) con fracción de céntimo: la suma reclasificada coincide exactamente, sin drift', async () => {
        const invoicedQty = d('3.000');
        const lineRow = makeLockedLineRow({
          quantity: invoicedQty,
          taxableBaseAmount: d('100.00'),
          taxAmount: d('0.00'),
          creditableTaxAmount: d('0.00'),
        });

        function queueLocks(): void {
          prisma.tx.$queryRaw
            .mockResolvedValueOnce([makeLockedInvoiceRow()])
            .mockResolvedValueOnce([lineRow]);
        }

        const recorded: string[] = [];
        prisma.tx.purchaseReceiptLine.update.mockImplementation(
          (args: { data: { reclassifiedAmount: Prisma.Decimal } }) => {
            recorded.push(args.data.reclassifiedAmount.toFixed(2));
            return Promise.resolve({});
          },
        );

        // --- Recepción 1: cumulative=1/3, target=33.33, residual=33.33 ---
        prisma.tx.$queryRaw.mockReset();
        queueLocks();
        prisma.tx.purchaseReceiptLine.groupBy.mockResolvedValue([]);
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([]);
        await service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '1.000',
              },
            ],
          }),
        );

        // --- Recepción 2: cumulative=2/3, target=66.67, residual=33.34 ---
        prisma.tx.$queryRaw.mockReset();
        queueLocks();
        prisma.tx.purchaseReceiptLine.groupBy.mockResolvedValue([
          {
            purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
            _sum: { quantity: d('1.000') },
          },
        ]);
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([
          { reclassifiedAmount: d('33.33') },
        ]);
        await service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '1.000',
              },
            ],
          }),
        );

        // --- Recepción 3 (completa la línea): target=100.00 EXACTO, residual=33.33 ---
        prisma.tx.$queryRaw.mockReset();
        queueLocks();
        prisma.tx.purchaseReceiptLine.groupBy.mockResolvedValue([
          {
            purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
            _sum: { quantity: d('2.000') },
          },
        ]);
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([
          { reclassifiedAmount: d('33.33') },
          { reclassifiedAmount: d('33.34') },
        ]);
        await service.create(
          createInput({
            lines: [
              {
                purchaseInvoiceLineId: PURCHASE_INVOICE_LINE_ID,
                quantity: '1.000',
              },
            ],
          }),
        );

        expect(recorded).toEqual(['33.33', '33.34', '33.33']);
        const total = recorded.reduce((sum, v) => sum.plus(v), d('0'));
        expect(total.toFixed(2)).toBe('100.00');
      });

      it('recepción previa de la misma línea sin reclasificar (política cambiada entre recepciones): ConflictException', async () => {
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([
          { reclassifiedAmount: null },
        ]);
        await expect(service.create(createInput())).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(stockMovementEngine.apply).not.toHaveBeenCalled();
      });

      it('mapeo contable cambiado desde la confirmación (cuenta origen no coincide con la realmente debitada): ConflictException, bloquea TODA la recepción', async () => {
        prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
          { accountId: 'otra-cuenta-distinta' },
        ]);
        await expect(service.create(createInput())).rejects.toBeInstanceOf(
          ConflictException,
        );
        expect(stockMovementEngine.apply).not.toHaveBeenCalled();
      });

      it('cuenta de reclasificación configurada pero inactiva: ConflictException', async () => {
        prisma.tx.account.findUnique.mockResolvedValue(
          makeTargetAccount({ status: AccountStatus.INACTIVE }),
        );
        await expect(service.create(createInput())).rejects.toBeInstanceOf(
          ConflictException,
        );
      });

      describe('R1: mensaje 409 según rol (cuenta destino inactiva)', () => {
        beforeEach(() => {
          prisma.tx.account.findUnique.mockResolvedValue(
            makeTargetAccount({ status: AccountStatus.INACTIVE }),
          );
        });

        it('WAREHOUSE: 409 con mensaje funcional, sin código de cuenta, y el detalle queda en el log interno', async () => {
          const warn = jest
            .spyOn(Logger.prototype, 'warn')
            .mockImplementation(() => undefined);
          try {
            const error: unknown = await service
              .create(createInput({ requesterRole: RoleName.WAREHOUSE }))
              .catch((e: unknown) => e);
            expect(error).toBeInstanceOf(ConflictException);
            const message = (error as ConflictException).message;
            expect(message).toBe(WAREHOUSE_ACCOUNTING_CONFIG_MESSAGE);
            expect(message).not.toContain('PURCH-RESALE');
            expect(
              JSON.stringify((error as ConflictException).getResponse()),
            ).not.toContain('PURCH-RESALE');
            expect(warn).toHaveBeenCalledWith(
              expect.stringContaining('PURCH-RESALE'),
            );
          } finally {
            warn.mockRestore();
          }
        });

        it('ADMIN: conserva el mensaje original con el código de cuenta', async () => {
          await expect(
            service.create(createInput({ requesterRole: RoleName.ADMIN })),
          ).rejects.toThrow(/PURCH-RESALE/);
        });
      });

      it('cadena de reclasificación (la cuenta destino también tiene su propio objetivo): InternalServerErrorException', async () => {
        prisma.tx.account.findUnique.mockResolvedValue(
          makeTargetAccount({
            receiptReclassificationTargetAccountId: 'otra-mas',
          }),
        );
        await expect(service.create(createInput())).rejects.toBeInstanceOf(
          InternalServerErrorException,
        );
      });
    });
  });

  // ====================================================================
  // cancel
  // ====================================================================
  describe('cancel', () => {
    function cancelInput(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        purchaseReceiptId: PURCHASE_RECEIPT_ID,
        reason: 'Mercadería dañada',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: null,
        ...overrides,
      };
    }

    function setupLockedReceipt(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      prisma.tx.$queryRaw.mockReset().mockResolvedValueOnce([
        {
          id: PURCHASE_RECEIPT_ID,
          status: 'ACTIVE',
          purchaseInvoiceId: PURCHASE_INVOICE_ID,
          reclassificationEntryId: null,
          ...overrides,
        },
      ]);
    }

    beforeEach(() => {
      setupLockedReceipt();
      prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([
        {
          purchaseInvoiceLine: { productId: PRODUCT_ID },
          quantity: d('4.000'),
        },
      ]);
      prisma.tx.purchaseReceipt.update.mockResolvedValue(
        makeSafeReceiptRow({ status: 'CANCELLED' }),
      );
    });

    it('reason en blanco: BadRequestException', async () => {
      await expect(
        service.cancel(cancelInput({ reason: '   ' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no existe: NotFoundException', async () => {
      prisma.tx.$queryRaw.mockReset().mockResolvedValueOnce([]);
      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('ya CANCELLED (doble anulación): ConflictException', async () => {
      setupLockedReceipt({ status: 'CANCELLED' });
      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(stockMovementEngine.apply).not.toHaveBeenCalled();
    });

    it('con vínculo de importación ACTIVO (Fase B3): ConflictException, nunca revierte stock ni contabilidad', async () => {
      prisma.tx.importReceiptLink.findFirst.mockResolvedValue({
        id: 'import-receipt-link-1',
      });
      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(stockMovementEngine.apply).not.toHaveBeenCalled();
      expect(prisma.tx.purchaseReceipt.update).not.toHaveBeenCalled();
    });

    describe('R2-ACT: ubicación y orden de bloqueos en la anulación (D1)', () => {
      const LOCATION_X = '88888888-8888-4888-8888-888888888888';
      const PRODUCT_LOW = '00000000-0000-4000-8000-000000000001';
      const PRODUCT_HIGH = '00000000-0000-4000-8000-000000000009';

      it('D1: procesa las salidas en orden ascendente de productId (desempate por id de línea)', async () => {
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([
          {
            id: 'line-1',
            purchaseInvoiceLine: { productId: PRODUCT_HIGH },
            quantity: d('1.000'),
            locationId: null,
          },
          {
            id: 'line-2',
            purchaseInvoiceLine: { productId: PRODUCT_LOW },
            quantity: d('1.000'),
            locationId: null,
          },
        ]);

        await service.cancel(cancelInput());

        const products = stockMovementEngine.apply.mock.calls.map(
          (call) => (call[1] as { productId: string }).productId,
        );
        expect(products).toEqual([PRODUCT_LOW, PRODUCT_HIGH]);
      });

      it('retira de la ubicación de cada línea y bloquea el catálogo antes de la primera salida', async () => {
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([
          {
            id: 'line-1',
            purchaseInvoiceLine: { productId: PRODUCT_LOW },
            quantity: d('2.000'),
            locationId: LOCATION_X,
          },
        ]);

        await service.cancel(cancelInput());

        expect(stockMovementEngine.lockLocationsShared).toHaveBeenCalledWith(
          prisma.tx,
          [LOCATION_X],
        );
        const call = stockMovementEngine.apply.mock.calls[0][1] as {
          locationId?: string;
        };
        expect(call.locationId).toBe(LOCATION_X);
        expect(
          stockMovementEngine.lockLocationsShared.mock.invocationCallOrder[0],
        ).toBeLessThan(stockMovementEngine.apply.mock.invocationCallOrder[0]);
      });

      it('una línea histórica sin ubicación (NULL) sale de MAIN/DEFAULT (el motor resuelve el default)', async () => {
        prisma.tx.purchaseReceiptLine.findMany.mockResolvedValue([
          {
            id: 'line-1',
            purchaseInvoiceLine: { productId: PRODUCT_LOW },
            quantity: d('2.000'),
            locationId: null,
          },
        ]);

        await service.cancel(cancelInput());

        expect(stockMovementEngine.lockLocationsShared).toHaveBeenCalledWith(
          prisma.tx,
          [null],
        );
        const call = stockMovementEngine.apply.mock.calls[0][1] as {
          locationId?: string;
        };
        expect(call.locationId).toBeUndefined();
      });
    });

    it('camino feliz: un movimiento EXIT compensatorio, marca CANCELLED', async () => {
      const result = await service.cancel(cancelInput());
      expect(result.status).toBe('CANCELLED');
      expect(stockMovementEngine.apply).toHaveBeenCalledTimes(1);
      const call = stockMovementEngine.apply.mock.calls[0][1] as {
        movementType: InventoryMovementType;
        origin: InventoryMovementOrigin;
        quantity: Prisma.Decimal;
      };
      expect(call.movementType).toBe(InventoryMovementType.EXIT);
      expect(call.origin).toBe(
        InventoryMovementOrigin.PURCHASE_RECEIPT_CANCELLATION,
      );
      expect(call.quantity.toFixed(3)).toBe('4.000');
    });

    it('stock insuficiente para la reversa: el error de StockMovementEngine se propaga (nunca se omite esa protección)', async () => {
      stockMovementEngine.apply.mockRejectedValue(
        new ConflictException('Stock insuficiente'),
      );
      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.purchaseReceipt.update).not.toHaveBeenCalled();
    });

    it('sin reclassificationEntryId: nunca llama a AccountingEngine.reverseOriginalForSource', async () => {
      await service.cancel(cancelInput());
      expect(accountingEngine.reverseOriginalForSource).not.toHaveBeenCalled();
    });

    it('con reclassificationEntryId: revierte vía AccountingEngine con sourceType=PURCHASE_RECEIPT', async () => {
      setupLockedReceipt({ reclassificationEntryId: ENTRY_ID });
      accountingEngine.reverseOriginalForSource.mockResolvedValue({
        id: 'reversal-1',
      });

      await service.cancel(cancelInput());

      expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledWith(
        prisma.tx,
        expect.objectContaining({
          sourceType: AccountingSourceType.PURCHASE_RECEIPT,
          sourceId: PURCHASE_RECEIPT_ID,
        }),
      );
    });

    it('audita PURCHASE_RECEIPT_CANCELLED con el motivo', async () => {
      await service.cancel(cancelInput());
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
      };
      expect(call.action).toBe(AuditAction.PURCHASE_RECEIPT_CANCELLED);
      expect(call.metadata.reason).toBe('Mercadería dañada');
    });
  });
});
