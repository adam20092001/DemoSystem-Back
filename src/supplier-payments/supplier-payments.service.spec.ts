import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingSourceType,
  PaymentMethodAccountingDestination,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AccountingEngine } from '../accounting/accounting.engine';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { SettingsReader } from '../configuration/settings-reader.service';
import { PaymentMethodReader } from '../payment-methods/payment-method-reader.service';
import { SupplierPaymentsService } from './supplier-payments.service';

const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SUPPLIER_ID = '99999999-9999-4999-8999-999999999999';
const INVOICE_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const INVOICE_ID_2 = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const LIABILITY_ACCOUNT_ID = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const LIABILITY_ACCOUNT_ID_2 = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const POSTED_ENTRY_ID = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const POSTED_ENTRY_ID_2 = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const SUPPLIER_PAYMENT_ID = '11111111-1111-4111-8111-111111111111';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeLockedInvoiceRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: INVOICE_ID,
    supplierId: SUPPLIER_ID,
    status: 'CONFIRMED',
    currencyCode: 'PEN',
    totalAmount: d('150.00'),
    postedEntryId: POSTED_ENTRY_ID,
    ...overrides,
  };
}

function makeSafeMethod(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'method-cash',
    code: 'CASH',
    name: 'Efectivo',
    active: true,
    requiresReference: false,
    accountingDestination: PaymentMethodAccountingDestination.CASH,
    ...overrides,
  };
}

function makeSafeSupplierPaymentRow(
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id: SUPPLIER_PAYMENT_ID,
    supplierId: SUPPLIER_ID,
    paymentDate: new Date('2026-03-20T00:00:00.000Z'),
    amount: d('150.00'),
    currencyCode: 'PEN',
    paymentMethodId: 'method-cash',
    paymentMethodCode: 'CASH',
    paymentMethodName: 'Efectivo',
    reference: null,
    idempotencyKey: null,
    status: 'ACTIVE',
    postedEntryId: POSTED_ENTRY_ID,
    createdByUserId: ACTOR_ID,
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    createdAt: new Date('2026-03-20T00:00:00.000Z'),
    updatedAt: new Date('2026-03-20T00:00:00.000Z'),
    allocations: [
      { id: 'alloc-1', purchaseInvoiceId: INVOICE_ID, amount: d('150.00') },
    ],
    ...overrides,
  };
}

function createTxMock() {
  return {
    supplier: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [unknown]>(),
    },
    supplierPayment: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      create: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
    },
    supplierPaymentAllocation: {
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    accountingEntryLine: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    supplierPayment: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
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
    postSupplierPaymentCollection: jest.fn<
      Promise<unknown>,
      [unknown, unknown]
    >(),
    reverseOriginalForSource: jest.fn<Promise<unknown>, [unknown, unknown]>(),
  };
}

function createSettingsReaderMock() {
  return { getCurrent: jest.fn<Promise<unknown>, [unknown?]>() };
}

function createPaymentMethodReaderMock() {
  return { findByCode: jest.fn<Promise<unknown>, [string, unknown]>() };
}

describe('SupplierPaymentsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let accountingEngine: ReturnType<typeof createAccountingEngineMock>;
  let settingsReader: ReturnType<typeof createSettingsReaderMock>;
  let paymentMethodReader: ReturnType<typeof createPaymentMethodReaderMock>;
  let service: SupplierPaymentsService;

  function queueInvoiceLock(rows: unknown[]) {
    prisma.tx.$queryRaw
      .mockReset()
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]);
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    accountingEngine = createAccountingEngineMock();
    settingsReader = createSettingsReaderMock();
    paymentMethodReader = createPaymentMethodReaderMock();

    service = new SupplierPaymentsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
      accountingEngine as unknown as AccountingEngine,
      settingsReader as unknown as SettingsReader,
      paymentMethodReader as unknown as PaymentMethodReader,
    );

    prisma.tx.supplier.findUnique.mockResolvedValue({
      id: SUPPLIER_ID,
      legalName: 'Acme SAC',
    });
    prisma.tx.supplierPayment.findUnique.mockResolvedValue(null);
    queueInvoiceLock([makeLockedInvoiceRow()]);
    settingsReader.getCurrent.mockResolvedValue({ currencyCode: 'PEN' });
    prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([]);
    paymentMethodReader.findByCode.mockResolvedValue(makeSafeMethod());
    prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
      { entryId: POSTED_ENTRY_ID, accountId: LIABILITY_ACCOUNT_ID },
    ]);
    accountingEngine.postSupplierPaymentCollection.mockResolvedValue({
      id: 'posted-entry-1',
    });
    prisma.tx.supplierPayment.create.mockResolvedValue(
      makeSafeSupplierPaymentRow(),
    );
  });

  function createInput(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      supplierId: SUPPLIER_ID,
      amount: '150.00',
      method: 'CASH',
      allocations: [{ purchaseInvoiceId: INVOICE_ID, amount: '150.00' }],
      requesterRole: RoleName.ADMIN,
      actorUserId: ACTOR_ID,
      ipAddress: null,
      ...overrides,
    } as Parameters<SupplierPaymentsService['create']>[0];
  }

  // ====================================================================
  // Permisos
  // ====================================================================
  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer ni escribir',
      async (role) => {
        await expect(
          service.findOne(SUPPLIER_PAYMENT_ID, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(service.list({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          service.create(createInput({ requesterRole: role })),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.tx.supplierPayment.create).not.toHaveBeenCalled();
      },
    );

    it.each([RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s puede leer pero nunca escribir',
      async (role) => {
        await expect(
          service.create(createInput({ requesterRole: role })),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.cancel({
            supplierPaymentId: SUPPLIER_PAYMENT_ID,
            reason: 'motivo',
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );
  });

  // ====================================================================
  // create
  // ====================================================================
  describe('create', () => {
    it('pago completo de una sola factura: camino feliz', async () => {
      const result = await service.create(createInput());
      expect(result.id).toBe(SUPPLIER_PAYMENT_ID);
      expect(
        accountingEngine.postSupplierPaymentCollection,
      ).toHaveBeenCalledTimes(1);
      expect(prisma.tx.supplierPayment.create).toHaveBeenCalledTimes(1);
    });

    it('pago parcial: la suma asignada queda por debajo del total, sin error', async () => {
      await expect(
        service.create(
          createInput({
            amount: '50.00',
            allocations: [{ purchaseInvoiceId: INVOICE_ID, amount: '50.00' }],
          }),
        ),
      ).resolves.toBeDefined();
    });

    it('la suma de allocations no coincide con amount: BadRequestException', async () => {
      await expect(
        service.create(
          createInput({
            amount: '150.00',
            allocations: [{ purchaseInvoiceId: INVOICE_ID, amount: '100.00' }],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.supplierPayment.create).not.toHaveBeenCalled();
    });

    it('misma factura referenciada dos veces en el mismo pago: BadRequestException', async () => {
      await expect(
        service.create(
          createInput({
            amount: '150.00',
            allocations: [
              { purchaseInvoiceId: INVOICE_ID, amount: '100.00' },
              { purchaseInvoiceId: INVOICE_ID, amount: '50.00' },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('proveedor inexistente: BadRequestException', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(null);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('factura de OTRO proveedor: BadRequestException, bloquea todo el pago', async () => {
      queueInvoiceLock([
        makeLockedInvoiceRow({ supplierId: 'otro-proveedor' }),
      ]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(
        accountingEngine.postSupplierPaymentCollection,
      ).not.toHaveBeenCalled();
    });

    it('factura inexistente (no viene en el lock): BadRequestException', async () => {
      queueInvoiceLock([]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('factura no CONFIRMED (DRAFT/CANCELLED): ConflictException', async () => {
      queueInvoiceLock([makeLockedInvoiceRow({ status: 'DRAFT' })]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(
        accountingEngine.postSupplierPaymentCollection,
      ).not.toHaveBeenCalled();
    });

    it('moneda de la factura distinta a la vigente de la empresa: ConflictException', async () => {
      settingsReader.getCurrent.mockResolvedValue({ currencyCode: 'USD' });
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('overpayment: el monto asignado supera el saldo pendiente recalculado: ConflictException', async () => {
      prisma.tx.supplierPaymentAllocation.groupBy.mockResolvedValue([
        { purchaseInvoiceId: INVOICE_ID, _sum: { amount: d('100.00') } },
      ]);
      await expect(
        service.create(
          createInput({
            amount: '60.00',
            allocations: [{ purchaseInvoiceId: INVOICE_ID, amount: '60.00' }],
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(
        accountingEngine.postSupplierPaymentCollection,
      ).not.toHaveBeenCalled();
    });

    it('método de pago inexistente: NotFoundException', async () => {
      paymentMethodReader.findByCode.mockResolvedValue(null);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('método de pago inactivo: ConflictException', async () => {
      paymentMethodReader.findByCode.mockResolvedValue(
        makeSafeMethod({ active: false }),
      );
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
    });

    it('método exige referencia y no se proveyó: BadRequestException', async () => {
      paymentMethodReader.findByCode.mockResolvedValue(
        makeSafeMethod({ requiresReference: true }),
      );
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('idempotencyKey ya usada: devuelve el MISMO pago existente, sin duplicar ningún efecto', async () => {
      const existing = makeSafeSupplierPaymentRow({
        idempotencyKey: 'retry-1',
      });
      prisma.tx.supplierPayment.findUnique.mockResolvedValue(existing);

      const result = await service.create(
        createInput({ idempotencyKey: 'retry-1' }),
      );

      expect(result.id).toBe(SUPPLIER_PAYMENT_ID);
      expect(prisma.tx.supplierPayment.create).not.toHaveBeenCalled();
      expect(
        accountingEngine.postSupplierPaymentCollection,
      ).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('cuenta histórica: debita la cuenta REALMENTE acreditada en el asiento original, nunca el mapeo vigente', async () => {
      prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
        { entryId: POSTED_ENTRY_ID, accountId: LIABILITY_ACCOUNT_ID },
      ]);
      await service.create(createInput());
      const command = accountingEngine.postSupplierPaymentCollection.mock
        .calls[0][1] as {
        liabilityLines: { accountId: string; amount: Prisma.Decimal }[];
      };
      expect(command.liabilityLines).toEqual([
        {
          accountId: LIABILITY_ACCOUNT_ID,
          amount: expect.anything() as unknown,
        },
      ]);
      expect(command.liabilityLines[0].amount.toFixed(2)).toBe('150.00');
    });

    it('dos facturas con cuentas históricas DISTINTAS: dos líneas de pasivo separadas, nunca mezcladas', async () => {
      queueInvoiceLock([
        makeLockedInvoiceRow({ totalAmount: d('100.00') }),
        makeLockedInvoiceRow({
          id: INVOICE_ID_2,
          totalAmount: d('50.00'),
          postedEntryId: POSTED_ENTRY_ID_2,
        }),
      ]);
      prisma.tx.accountingEntryLine.findMany.mockResolvedValue([
        { entryId: POSTED_ENTRY_ID, accountId: LIABILITY_ACCOUNT_ID },
        { entryId: POSTED_ENTRY_ID_2, accountId: LIABILITY_ACCOUNT_ID_2 },
      ]);

      await service.create(
        createInput({
          amount: '150.00',
          allocations: [
            { purchaseInvoiceId: INVOICE_ID, amount: '100.00' },
            { purchaseInvoiceId: INVOICE_ID_2, amount: '50.00' },
          ],
        }),
      );

      const command = accountingEngine.postSupplierPaymentCollection.mock
        .calls[0][1] as {
        liabilityLines: { accountId: string; amount: Prisma.Decimal }[];
      };
      const byAccount = new Map(
        command.liabilityLines.map((l) => [l.accountId, l.amount]),
      );
      expect(byAccount.get(LIABILITY_ACCOUNT_ID)?.toFixed(2)).toBe('100.00');
      expect(byAccount.get(LIABILITY_ACCOUNT_ID_2)?.toFixed(2)).toBe('50.00');
    });

    it('el asiento original no tiene exactamente una línea de crédito de pasivo: InternalServerErrorException (invariante roto)', async () => {
      prisma.tx.accountingEntryLine.findMany.mockResolvedValue([]);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );
    });

    it('rollback: si AccountingEngine falla, nunca crea el SupplierPayment (misma transacción)', async () => {
      accountingEngine.postSupplierPaymentCollection.mockRejectedValue(
        new ConflictException('fallo contable'),
      );
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(prisma.tx.supplierPayment.create).not.toHaveBeenCalled();
    });

    it('audita SUPPLIER_PAYMENT_REGISTERED exactamente una vez', async () => {
      await service.create(createInput());
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
      };
      expect(call.action).toBe(AuditAction.SUPPLIER_PAYMENT_REGISTERED);
    });
  });

  // ====================================================================
  // cancel
  // ====================================================================
  describe('cancel', () => {
    function cancelInput(overrides: Partial<Record<string, unknown>> = {}) {
      return {
        supplierPaymentId: SUPPLIER_PAYMENT_ID,
        reason: 'Pago registrado por error',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: null,
        ...overrides,
      };
    }

    function setupLockedPayment(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      prisma.tx.$queryRaw.mockReset().mockResolvedValueOnce([
        {
          id: SUPPLIER_PAYMENT_ID,
          status: 'ACTIVE',
          supplierId: SUPPLIER_ID,
          ...overrides,
        },
      ]);
    }

    beforeEach(() => {
      setupLockedPayment();
      prisma.tx.supplier.findUniqueOrThrow.mockResolvedValue({
        legalName: 'Acme SAC',
      });
      accountingEngine.reverseOriginalForSource.mockResolvedValue({
        id: 'reversal-1',
      });
      prisma.tx.supplierPayment.update.mockResolvedValue(
        makeSafeSupplierPaymentRow({ status: 'CANCELLED' }),
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
      setupLockedPayment({ status: 'CANCELLED' });
      await expect(service.cancel(cancelInput())).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(accountingEngine.reverseOriginalForSource).not.toHaveBeenCalled();
    });

    it('camino feliz: revierte vía AccountingEngine con sourceType=SUPPLIER_PAYMENT, marca CANCELLED', async () => {
      const result = await service.cancel(cancelInput());
      expect(result.status).toBe('CANCELLED');
      expect(accountingEngine.reverseOriginalForSource).toHaveBeenCalledWith(
        prisma.tx,
        expect.objectContaining({
          sourceType: AccountingSourceType.SUPPLIER_PAYMENT,
          sourceId: SUPPLIER_PAYMENT_ID,
          sourceNumber: 'Acme SAC',
        }),
      );
    });

    it('audita SUPPLIER_PAYMENT_CANCELLED con el motivo y el id de la reversión', async () => {
      await service.cancel(cancelInput());
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
      };
      expect(call.action).toBe(AuditAction.SUPPLIER_PAYMENT_CANCELLED);
      expect(call.metadata.reason).toBe('Pago registrado por error');
      expect(call.metadata.reversalEntryId).toBe('reversal-1');
    });
  });
});
