import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  Prisma,
  PurchaseAcquisitionKind,
  PurchaseInvoiceStatus,
  PurchaseLineTaxCategory,
  PurchasePurpose,
  RoleName,
  SupplierStatus,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import { PrismaService } from '../database/prisma.service';
import { PurchaseInvoicesService } from './purchase-invoices.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER_ID = '55555555-5555-4555-8555-555555555555';
const PURCHASE_INVOICE_ID = '99999999-9999-4999-8999-999999999999';
const PRODUCT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const NOW = new Date('2026-03-15T00:00:00.000Z');

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeLockedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PURCHASE_INVOICE_ID,
    status: PurchaseInvoiceStatus.DRAFT,
    postedEntryId: null,
    documentType: 'FACTURA',
    documentSeries: 'F001',
    documentNumber: '123',
    ...overrides,
  };
}

function makeSafeInvoiceRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PURCHASE_INVOICE_ID,
    supplierId: SUPPLIER_ID,
    documentType: 'FACTURA',
    documentSeries: 'F001',
    documentNumber: '123',
    issueDate: new Date('2026-03-01T00:00:00.000Z'),
    registrationDate: new Date('2026-03-01T00:00:00.000Z'),
    accountingDate: new Date('2026-03-01T00:00:00.000Z'),
    dueDate: null,
    paymentTermsDays: null,
    currencyCode: 'PEN',
    subtotal: d('100.00'),
    taxAmount: d('18.00'),
    totalAmount: d('118.00'),
    status: PurchaseInvoiceStatus.DRAFT,
    postedEntryId: null,
    createdByUserId: ACTOR_ID,
    confirmedAt: null,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    createdAt: NOW,
    updatedAt: NOW,
    lines: [],
    ...overrides,
  };
}

function makeDetailedInvoiceRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: PURCHASE_INVOICE_ID,
    documentType: 'FACTURA',
    documentSeries: 'F001',
    documentNumber: '123',
    accountingDate: new Date('2026-03-01T00:00:00.000Z'),
    supplier: { status: SupplierStatus.ACTIVE },
    lines: [
      {
        id: 'line-1',
        productId: null,
        acquisitionKind: PurchaseAcquisitionKind.SERVICE,
        purchasePurpose: PurchasePurpose.OPERATING_EXPENSE,
        taxableBaseAmount: d('100.00'),
        taxAmount: d('18.00'),
        creditableTaxAmount: d('18.00'),
      },
    ],
    ...overrides,
  };
}

function createTxMock() {
  return {
    supplier: { findUnique: jest.fn<Promise<unknown>, [unknown]>() },
    product: { findMany: jest.fn<Promise<unknown[]>, [unknown]>() },
    purchaseInvoice: {
      create: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    purchaseInvoiceLine: {
      deleteMany: jest.fn<Promise<unknown>, [unknown]>(),
      createMany: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
    },
    // Fase A5.2b: guardia de cancel() contra recepciones ACTIVE.
    purchaseReceipt: {
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    // Fase A5.3: guardia de cancel() contra pagos ACTIVE asignados.
    supplierPaymentAllocation: {
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    purchaseInvoice: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function createAccountingEngineMock() {
  return {
    postPurchaseRecognition: jest.fn<Promise<unknown>, [unknown, unknown]>(),
    reverseOriginalForSource: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

function createSettingsReaderMock() {
  return { getCurrent: jest.fn<Promise<unknown>, [unknown?]>() };
}

describe('PurchaseInvoicesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let accountingEngine: ReturnType<typeof createAccountingEngineMock>;
  let settingsReader: ReturnType<typeof createSettingsReaderMock>;
  let service: PurchaseInvoicesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    accountingEngine = createAccountingEngineMock();
    settingsReader = createSettingsReaderMock();

    service = new PurchaseInvoicesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      accountingEngine as unknown as AccountingEngine,
      settingsReader as unknown as SettingsReader,
    );

    prisma.purchaseInvoice.findMany.mockResolvedValue([]);
    prisma.purchaseInvoice.count.mockResolvedValue(0);
    prisma.purchaseInvoice.findUnique.mockResolvedValue(makeSafeInvoiceRow());

    prisma.tx.supplier.findUnique.mockResolvedValue({
      id: SUPPLIER_ID,
      status: SupplierStatus.ACTIVE,
    });
    prisma.tx.product.findMany.mockResolvedValue([]);
    prisma.tx.purchaseReceipt.count.mockResolvedValue(0);
    prisma.tx.supplierPaymentAllocation.count.mockResolvedValue(0);
    prisma.tx.$queryRaw.mockResolvedValue([makeLockedRow()]);
    prisma.tx.purchaseInvoice.create.mockResolvedValue(makeSafeInvoiceRow());
    prisma.tx.purchaseInvoice.update.mockResolvedValue(makeSafeInvoiceRow());
    prisma.tx.purchaseInvoice.findUniqueOrThrow.mockImplementation((args) =>
      Promise.resolve(
        'include' in args ? makeDetailedInvoiceRow() : makeSafeInvoiceRow(),
      ),
    );

    settingsReader.getCurrent.mockResolvedValue({
      currencyCode: 'PEN',
      currencySymbol: 'S/',
      taxEnabled: true,
      taxRate: d('18'),
      quoteValidityDays: 15,
      maxDiscountPercent: d('20'),
    });

    accountingEngine.postPurchaseRecognition.mockResolvedValue({
      id: ENTRY_ID,
      sourceType: AccountingSourceType.PURCHASE,
      sourceId: PURCHASE_INVOICE_ID,
      journalNumber: 1,
      accountingDate: new Date('2026-03-01T00:00:00.000Z'),
    });
    accountingEngine.reverseOriginalForSource.mockResolvedValue({
      id: 'reversal-entry-1',
      sourceType: AccountingSourceType.PURCHASE,
      sourceId: PURCHASE_INVOICE_ID,
    });
  });

  // ====================================================================
  // Permisos
  // ====================================================================
  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer: ForbiddenException sin tocar Prisma',
      async (role) => {
        await expect(service.listDrafts({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          service.findOne(PURCHASE_INVOICE_ID, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.purchaseInvoice.findMany).not.toHaveBeenCalled();
      },
    );

    it.each([RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s puede leer',
      async (role) => {
        await expect(service.listDrafts({}, role)).resolves.toBeDefined();
      },
    );

    it.each([
      RoleName.MANAGEMENT,
      RoleName.ACCOUNTANT,
      RoleName.SELLER,
      RoleName.WAREHOUSE,
    ])(
      '%s nunca puede escribir (solo ADMIN administra el ciclo de vida en A5.2a)',
      async (role) => {
        await expect(
          service.create(makeCreateInput({ requesterRole: role })),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.update({
            purchaseInvoiceId: PURCHASE_INVOICE_ID,
            documentNumber: 'X',
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.confirm({
            purchaseInvoiceId: PURCHASE_INVOICE_ID,
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.cancel({
            purchaseInvoiceId: PURCHASE_INVOICE_ID,
            reason: 'motivo',
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.tx.purchaseInvoice.create).not.toHaveBeenCalled();
      },
    );
  });

  function makeCreateInput(
    overrides: Partial<Parameters<PurchaseInvoicesService['create']>[0]> = {},
  ) {
    return {
      supplierId: SUPPLIER_ID,
      documentType: 'FACTURA' as const,
      documentNumber: '123',
      issueDate: '2026-03-01',
      lines: [
        {
          description: 'Servicio de mantenimiento',
          acquisitionKind: PurchaseAcquisitionKind.SERVICE,
          purchasePurpose: PurchasePurpose.OPERATING_EXPENSE,
          quantity: '1.000',
          unitCost: '100.00',
          taxCategory: PurchaseLineTaxCategory.TAXED,
          taxBasis: 'TAX_EXCLUDED' as const,
          creditableTaxAmount: '18.00',
        },
      ],
      requesterRole: RoleName.ADMIN,
      actorUserId: ACTOR_ID,
      ipAddress: null,
      ...overrides,
    };
  }

  // ====================================================================
  // create
  // ====================================================================
  describe('create', () => {
    it('proveedor inexistente: BadRequestException, sin crear nada', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(null);
      await expect(service.create(makeCreateInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.tx.purchaseInvoice.create).not.toHaveBeenCalled();
    });

    it('proveedor INACTIVE: ConflictException', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue({
        id: SUPPLIER_ID,
        status: SupplierStatus.INACTIVE,
      });
      await expect(service.create(makeCreateInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.purchaseInvoice.create).not.toHaveBeenCalled();
    });

    it('línea sin productId y sin description: BadRequestException', async () => {
      await expect(
        service.create(
          makeCreateInput({
            lines: [
              {
                acquisitionKind: PurchaseAcquisitionKind.SERVICE,
                purchasePurpose: PurchasePurpose.OPERATING_EXPENSE,
                quantity: '1.000',
                unitCost: '100.00',
                taxCategory: PurchaseLineTaxCategory.EXEMPT,
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('camino feliz: crea con currencyCode de CompanySettings (nunca del cliente), totales calculados, audita PURCHASE_INVOICE_CREATED', async () => {
      await service.create(makeCreateInput());

      const call = prisma.tx.purchaseInvoice.create.mock.calls[0][0] as {
        data: { currencyCode: string; subtotal: Prisma.Decimal };
      };
      expect(call.data.currencyCode).toBe('PEN');
      expect(call.data.subtotal.toFixed(2)).toBe('100.00');

      expect(auditService.record).toHaveBeenCalledTimes(1);
      const auditCall = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
      };
      expect(auditCall.action).toBe(AuditAction.PURCHASE_INVOICE_CREATED);
    });
  });

  // ====================================================================
  // update
  // ====================================================================
  describe('update', () => {
    it('payload vacío: BadRequestException', async () => {
      await expect(
        service.update({
          purchaseInvoiceId: PURCHASE_INVOICE_ID,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no existe (lockInvoice no encuentra la fila): NotFoundException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.update({
          purchaseInvoiceId: PURCHASE_INVOICE_ID,
          documentNumber: 'X',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ya no está en DRAFT: ConflictException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: PurchaseInvoiceStatus.CONFIRMED }),
      ]);
      await expect(
        service.update({
          purchaseInvoiceId: PURCHASE_INVOICE_ID,
          documentNumber: 'X',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.purchaseInvoice.update).not.toHaveBeenCalled();
    });

    it('camino feliz: reemplaza documentNumber, audita PURCHASE_INVOICE_UPDATED', async () => {
      await service.update({
        purchaseInvoiceId: PURCHASE_INVOICE_ID,
        documentNumber: '456',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      const call = prisma.tx.purchaseInvoice.update.mock.calls[0][0] as {
        data: { documentNumber: string };
      };
      expect(call.data.documentNumber).toBe('456');
      const auditCall = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
      };
      expect(auditCall.action).toBe(AuditAction.PURCHASE_INVOICE_UPDATED);
    });

    it('lines presente: reemplaza el arreglo completo (deleteMany + createMany)', async () => {
      await service.update({
        purchaseInvoiceId: PURCHASE_INVOICE_ID,
        lines: [
          {
            description: 'Otro concepto',
            acquisitionKind: PurchaseAcquisitionKind.OTHER,
            purchasePurpose: PurchasePurpose.OTHER,
            quantity: '2.000',
            unitCost: '10.00',
            taxCategory: PurchaseLineTaxCategory.EXEMPT,
          },
        ],
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(prisma.tx.purchaseInvoiceLine.deleteMany).toHaveBeenCalledWith({
        where: { purchaseInvoiceId: PURCHASE_INVOICE_ID },
      });
      expect(prisma.tx.purchaseInvoiceLine.createMany).toHaveBeenCalledTimes(1);
    });
  });

  // ====================================================================
  // confirm
  // ====================================================================
  describe('confirm', () => {
    function confirmInput(role: RoleName = RoleName.ADMIN) {
      return {
        purchaseInvoiceId: PURCHASE_INVOICE_ID,
        requesterRole: role,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      };
    }

    it('no existe: NotFoundException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(service.confirm(confirmInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('ya no está en DRAFT: ConflictException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: PurchaseInvoiceStatus.CANCELLED }),
      ]);
      await expect(service.confirm(confirmInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(accountingEngine.postPurchaseRecognition).not.toHaveBeenCalled();
    });

    it('proveedor ya no está activo: ConflictException', async () => {
      prisma.tx.purchaseInvoice.findUniqueOrThrow.mockResolvedValue(
        makeDetailedInvoiceRow({
          supplier: { status: SupplierStatus.INACTIVE },
        }),
      );
      await expect(service.confirm(confirmInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('sin líneas: BadRequestException', async () => {
      prisma.tx.purchaseInvoice.findUniqueOrThrow.mockResolvedValue(
        makeDetailedInvoiceRow({ lines: [] }),
      );
      await expect(service.confirm(confirmInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('congela isReceiptEligible=true únicamente para línea GOOD+productId+Product.isInventoryTracked=true', async () => {
      prisma.tx.purchaseInvoice.findUniqueOrThrow.mockResolvedValue(
        makeDetailedInvoiceRow({
          lines: [
            {
              id: 'line-good-tracked',
              productId: PRODUCT_ID,
              acquisitionKind: PurchaseAcquisitionKind.GOOD,
              purchasePurpose: PurchasePurpose.RESALE_INVENTORY,
              taxableBaseAmount: d('100.00'),
              taxAmount: d('18.00'),
              creditableTaxAmount: d('18.00'),
            },
            {
              id: 'line-service',
              productId: null,
              acquisitionKind: PurchaseAcquisitionKind.SERVICE,
              purchasePurpose: PurchasePurpose.OPERATING_EXPENSE,
              taxableBaseAmount: d('50.00'),
              taxAmount: d('9.00'),
              creditableTaxAmount: d('9.00'),
            },
          ],
        }),
      );
      prisma.tx.product.findMany.mockResolvedValue([
        { id: PRODUCT_ID, isInventoryTracked: true },
      ]);

      await service.confirm(confirmInput());

      const updateCalls = prisma.tx.purchaseInvoiceLine.update.mock.calls as [
        { where: { id: string }; data: { isReceiptEligible: boolean } },
      ][];
      const byId = new Map(
        updateCalls.map(([args]) => [
          args.where.id,
          args.data.isReceiptEligible,
        ]),
      );
      expect(byId.get('line-good-tracked')).toBe(true);
      expect(byId.get('line-service')).toBe(false);
    });

    it('camino feliz: llama a AccountingEngine.postPurchaseRecognition, marca CONFIRMED, audita', async () => {
      await service.confirm(confirmInput());

      expect(accountingEngine.postPurchaseRecognition).toHaveBeenCalledTimes(1);
      const postCall = accountingEngine.postPurchaseRecognition.mock
        .calls[0][1] as {
        purchaseInvoiceId: string;
        accountingDateOnly: string;
      };
      expect(postCall.purchaseInvoiceId).toBe(PURCHASE_INVOICE_ID);
      expect(postCall.accountingDateOnly).toBe('2026-03-01');

      const updateCall = prisma.tx.purchaseInvoice.update.mock.calls.find(
        ([args]) =>
          (args as { data: { status?: string } }).data.status ===
          PurchaseInvoiceStatus.CONFIRMED,
      );
      expect(updateCall).toBeDefined();

      const auditCall = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
      };
      expect(auditCall.action).toBe(AuditAction.PURCHASE_INVOICE_CONFIRMED);
    });

    it('AccountingEngine rechaza por mapeo contable faltante (409): se propaga, nunca marca CONFIRMED', async () => {
      accountingEngine.postPurchaseRecognition.mockRejectedValue(
        new ConflictException('falta el mapeo contable'),
      );
      await expect(service.confirm(confirmInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(
        (
          prisma.tx.purchaseInvoice.update.mock.calls as [
            { data: { status?: string } },
          ][]
        ).some(
          ([args]) => args.data.status === PurchaseInvoiceStatus.CONFIRMED,
        ),
      ).toBe(false);
    });
  });

  // ====================================================================
  // cancel
  // ====================================================================
  describe('cancel', () => {
    function cancelInput(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        purchaseInvoiceId: PURCHASE_INVOICE_ID,
        reason: 'Factura registrada con el proveedor incorrecto',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: null,
        ...overrides,
      };
    }

    it('reason en blanco: BadRequestException', async () => {
      await expect(
        service.cancel(cancelInput({ reason: '   ' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no existe: NotFoundException', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('no está CONFIRMED (todavía DRAFT): ConflictException', async () => {
      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(accountingEngine.reverseOriginalForSource).not.toHaveBeenCalled();
    });

    it('camino feliz: revierte vía AccountingEngine, marca CANCELLED, audita con el motivo', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: PurchaseInvoiceStatus.CONFIRMED }),
      ]);

      await service.cancel(cancelInput());

      expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledWith(
        prisma.tx,
        expect.objectContaining({ sourceType: AccountingSourceType.PURCHASE }),
      );
      const auditCall = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
      };
      expect(auditCall.action).toBe(AuditAction.PURCHASE_INVOICE_CANCELLED);
      expect(auditCall.metadata.reason).toBe(
        'Factura registrada con el proveedor incorrecto',
      );
    });

    it('Fase A5.2b: factura con recepciones ACTIVE: ConflictException, nunca anula en cascada', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: PurchaseInvoiceStatus.CONFIRMED }),
      ]);
      prisma.tx.purchaseReceipt.count.mockResolvedValue(1);

      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(accountingEngine.reverseOriginalForSource).not.toHaveBeenCalled();
      expect(prisma.tx.purchaseInvoice.update).not.toHaveBeenCalled();
    });

    it('Fase A5.2b: sin recepciones ACTIVE (0 o solo CANCELLED, ya filtradas por el where): anula con normalidad', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: PurchaseInvoiceStatus.CONFIRMED }),
      ]);
      prisma.tx.purchaseReceipt.count.mockResolvedValue(0);

      await expect(service.cancel(cancelInput())).resolves.toBeDefined();
      expect(prisma.tx.purchaseReceipt.count).toHaveBeenCalledWith({
        where: { purchaseInvoiceId: PURCHASE_INVOICE_ID, status: 'ACTIVE' },
      });
    });

    it('Fase A5.3: factura con pagos ACTIVE asignados: ConflictException, nunca anula en cascada', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: PurchaseInvoiceStatus.CONFIRMED }),
      ]);
      prisma.tx.supplierPaymentAllocation.count.mockResolvedValue(1);

      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(accountingEngine.reverseOriginalForSource).not.toHaveBeenCalled();
      expect(prisma.tx.purchaseInvoice.update).not.toHaveBeenCalled();
    });

    it('Fase A5.3: sin pagos ACTIVE asignados: anula con normalidad, filtrando por supplierPayment.status=ACTIVE', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        makeLockedRow({ status: PurchaseInvoiceStatus.CONFIRMED }),
      ]);
      prisma.tx.supplierPaymentAllocation.count.mockResolvedValue(0);

      await expect(service.cancel(cancelInput())).resolves.toBeDefined();
      expect(prisma.tx.supplierPaymentAllocation.count).toHaveBeenCalledWith({
        where: {
          purchaseInvoiceId: PURCHASE_INVOICE_ID,
          supplierPayment: { status: 'ACTIVE' },
        },
      });
    });
  });
});
