import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  ImportExpenseAllocationMethod,
  ImportExpenseCategory,
  ImportExpenseStatus,
  Prisma,
  RoleName,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ImportExpensesService } from './import-expenses.service';

const ACTOR_ID = 'actor-id';
const OPERATION_ID = 'operation-1';
const EXPENSE_ID = 'expense-1';
const LINE_A = 'line-a';
const LINE_B = 'line-b';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeActor() {
  return {
    id: ACTOR_ID,
    username: 'admin',
    firstName: 'Ana',
    lastName: 'Admin',
  };
}

function makeExpenseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: EXPENSE_ID,
    importOperationId: OPERATION_ID,
    category: ImportExpenseCategory.FREIGHT,
    description: null,
    supplierId: null,
    purchaseInvoiceLineId: null,
    documentType: null,
    documentReference: null,
    expenseDate: new Date('2026-01-01'),
    currencyCode: 'USD',
    amount: d('1000.00'),
    remarks: null,
    status: ImportExpenseStatus.DRAFT,
    createdBy: makeActor(),
    createdAt: NOW,
    updatedAt: NOW,
    finalizedAt: null,
    finalizedBy: null,
    cancelledAt: null,
    cancelledBy: null,
    cancellationReason: null,
    allocationBatches: [],
    ...overrides,
  };
}

function makeBatchRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'batch-1',
    importExpenseId: EXPENSE_ID,
    method: ImportExpenseAllocationMethod.QUANTITY,
    requestedAmount: d('500.00'),
    createdBy: makeActor(),
    createdAt: NOW,
    allocations: [
      { id: 'alloc-1', importShipmentLineId: LINE_A, amount: d('200.00') },
      { id: 'alloc-2', importShipmentLineId: LINE_B, amount: d('300.00') },
    ],
    ...overrides,
  };
}

function createTxMock() {
  return {
    importOperation: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importExpense: {
      create: jest.fn<Promise<unknown>, [unknown]>(),
      update: jest.fn<Promise<unknown>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importExpenseAllocationBatch: {
      count: jest.fn<Promise<number>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      create: jest.fn<Promise<unknown>, [unknown]>(),
    },
    supplier: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    purchaseInvoiceLine: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    importExpense: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importOperation: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
    },
    importExpenseAllocationBatch: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    importShipmentLine: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

describe('ImportExpensesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: ImportExpensesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    prisma.tx.importOperation.findUnique.mockResolvedValue({
      id: OPERATION_ID,
    });
    service = new ImportExpensesService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  function createInput(overrides: Partial<Record<string, unknown>> = {}) {
    return {
      importOperationId: OPERATION_ID,
      category: ImportExpenseCategory.FREIGHT,
      expenseDate: '2026-01-01',
      currencyCode: 'usd',
      amount: '1000.00',
      actorUserId: ACTOR_ID,
      ipAddress: null,
      ...overrides,
    };
  }

  describe('create', () => {
    it('crea un gasto DRAFT con moneda normalizada a mayúsculas', async () => {
      prisma.tx.importExpense.create.mockResolvedValue(makeExpenseRow());
      const result = await service.create(createInput());
      expect(result.id).toBe(EXPENSE_ID);
      const call = prisma.tx.importExpense.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data.currencyCode).toBe('USD');
      expect(call.data.status).toBe(ImportExpenseStatus.DRAFT);
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('operación inexistente: NotFoundException', async () => {
      prisma.tx.importOperation.findUnique.mockResolvedValue(null);
      await expect(service.create(createInput())).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('amount inválido (cero): BadRequestException', async () => {
      await expect(
        service.create(createInput({ amount: '0' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('currencyCode inválido: BadRequestException', async () => {
      await expect(
        service.create(createInput({ currencyCode: 'US' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('supplierId inexistente: BadRequestException', async () => {
      prisma.tx.supplier.findUnique.mockResolvedValue(null);
      await expect(
        service.create(createInput({ supplierId: 'supplier-x' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('purchaseInvoiceLineId de una factura NO confirmada: ConflictException', async () => {
      prisma.tx.purchaseInvoiceLine.findUnique.mockResolvedValue({
        id: 'line-x',
        purchaseInvoice: { status: 'DRAFT' },
      });
      await expect(
        service.create(createInput({ purchaseInvoiceLineId: 'line-x' })),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('permisos de lectura', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer',
      async (role) => {
        await expect(service.findOne(EXPENSE_ID, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
      },
    );
  });

  describe('update', () => {
    it('gasto no DRAFT: ConflictException', async () => {
      prisma.tx.importExpense.findUnique.mockResolvedValue({
        id: EXPENSE_ID,
        status: ImportExpenseStatus.FINALIZED,
      });
      await expect(
        service.update({
          importExpenseId: EXPENSE_ID,
          remarks: 'nota',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cambiar amount con lotes ya existentes: ConflictException', async () => {
      prisma.tx.importExpense.findUnique.mockResolvedValue({
        id: EXPENSE_ID,
        status: ImportExpenseStatus.DRAFT,
      });
      prisma.tx.importExpenseAllocationBatch.count.mockResolvedValue(1);
      await expect(
        service.update({
          importExpenseId: EXPENSE_ID,
          amount: '2000.00',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importExpense.update).not.toHaveBeenCalled();
    });

    it('DRAFT sin lotes: edita remarks correctamente', async () => {
      prisma.tx.importExpense.findUnique.mockResolvedValue({
        id: EXPENSE_ID,
        status: ImportExpenseStatus.DRAFT,
      });
      prisma.tx.importExpenseAllocationBatch.count.mockResolvedValue(0);
      prisma.tx.importExpense.update.mockResolvedValue(
        makeExpenseRow({ remarks: 'actualizado' }),
      );
      const result = await service.update({
        importExpenseId: EXPENSE_ID,
        remarks: 'actualizado',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.remarks).toBe('actualizado');
    });
  });

  describe('finalize/cancel', () => {
    it('finalize() exige DRAFT', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: EXPENSE_ID,
          importOperationId: OPERATION_ID,
          status: ImportExpenseStatus.FINALIZED,
          amount: d('1000.00'),
        },
      ]);
      await expect(
        service.finalize({
          importExpenseId: EXPENSE_ID,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cancel() bloqueado si ya existen lotes de asignación', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: EXPENSE_ID,
          importOperationId: OPERATION_ID,
          status: ImportExpenseStatus.DRAFT,
          amount: d('1000.00'),
        },
      ]);
      prisma.tx.importExpenseAllocationBatch.count.mockResolvedValue(1);
      await expect(
        service.cancel({
          importExpenseId: EXPENSE_ID,
          reason: 'motivo',
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.importExpense.update).not.toHaveBeenCalled();
    });

    it('cancel() sin lotes: anula correctamente', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: EXPENSE_ID,
          importOperationId: OPERATION_ID,
          status: ImportExpenseStatus.DRAFT,
          amount: d('1000.00'),
        },
      ]);
      prisma.tx.importExpenseAllocationBatch.count.mockResolvedValue(0);
      prisma.tx.importExpense.update.mockResolvedValue(
        makeExpenseRow({ status: ImportExpenseStatus.CANCELLED }),
      );
      const result = await service.cancel({
        importExpenseId: EXPENSE_ID,
        reason: 'motivo de prueba',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.status).toBe(ImportExpenseStatus.CANCELLED);
    });
  });

  describe('allocate', () => {
    function queueExpenseLock(
      amount = '1000.00',
      status: ImportExpenseStatus = ImportExpenseStatus.DRAFT,
    ): void {
      prisma.tx.$queryRaw.mockResolvedValueOnce([
        {
          id: EXPENSE_ID,
          importOperationId: OPERATION_ID,
          status,
          amount: d(amount),
        },
      ]);
    }

    function queueLineLock(
      rows: {
        id: string;
        plannedQuantity: string;
        weightValue?: string | null;
        volumeValue?: string | null;
        shipmentStatus?: string;
        importOperationId?: string;
      }[],
    ): void {
      prisma.tx.$queryRaw.mockResolvedValueOnce(
        rows.map((r) => ({
          id: r.id,
          plannedQuantity: d(r.plannedQuantity),
          weightValue:
            r.weightValue !== undefined && r.weightValue !== null
              ? d(r.weightValue)
              : null,
          volumeValue:
            r.volumeValue !== undefined && r.volumeValue !== null
              ? d(r.volumeValue)
              : null,
          shipmentStatus: r.shipmentStatus ?? 'PLANNED',
          importOperationId: r.importOperationId ?? OPERATION_ID,
        })),
      );
    }

    beforeEach(() => {
      prisma.tx.importExpenseAllocationBatch.findMany.mockResolvedValue([]);
      prisma.tx.importExpenseAllocationBatch.findUnique.mockResolvedValue(null);
    });

    it('QUANTITY: reparte proporcionalmente por cantidad planificada', async () => {
      queueExpenseLock();
      queueLineLock([
        { id: LINE_A, plannedQuantity: '10.000' },
        { id: LINE_B, plannedQuantity: '30.000' },
      ]);
      prisma.tx.importExpenseAllocationBatch.create.mockResolvedValue(
        makeBatchRow({
          method: ImportExpenseAllocationMethod.QUANTITY,
          requestedAmount: d('400.00'),
          allocations: [
            { id: 'a1', importShipmentLineId: LINE_A, amount: d('100.00') },
            { id: 'a2', importShipmentLineId: LINE_B, amount: d('300.00') },
          ],
        }),
      );

      const result = await service.allocate({
        importExpenseId: EXPENSE_ID,
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '400.00',
        shipmentLineIds: [LINE_A, LINE_B],
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });

      expect(result.allocations).toHaveLength(2);
      const createCall = prisma.tx.importExpenseAllocationBatch.create.mock
        .calls[0][0] as {
        data: { allocations: { create: { amount: Prisma.Decimal }[] } };
      };
      const sum = createCall.data.allocations.create.reduce(
        (s, l) => s.plus(l.amount),
        new Prisma.Decimal(0),
      );
      expect(sum.toFixed(2)).toBe('400.00');
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('WEIGHT sin weightValue en alguna línea: BadRequestException, nunca crea el lote', async () => {
      queueExpenseLock();
      queueLineLock([
        { id: LINE_A, plannedQuantity: '10.000', weightValue: '5.000' },
        { id: LINE_B, plannedQuantity: '10.000', weightValue: null },
      ]);
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.WEIGHT,
          amountToAllocate: '100.00',
          shipmentLineIds: [LINE_A, LINE_B],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(
        prisma.tx.importExpenseAllocationBatch.create,
      ).not.toHaveBeenCalled();
    });

    it('MANUAL con suma distinta a amountToAllocate: BadRequestException', async () => {
      queueExpenseLock();
      queueLineLock([
        { id: LINE_A, plannedQuantity: '10.000' },
        { id: LINE_B, plannedQuantity: '10.000' },
      ]);
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.MANUAL,
          amountToAllocate: '100.00',
          manualAllocations: [
            { importShipmentLineId: LINE_A, amount: '40.00' },
            { importShipmentLineId: LINE_B, amount: '40.00' },
          ],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('MANUAL con suma exacta: crea el lote correctamente', async () => {
      queueExpenseLock();
      queueLineLock([
        { id: LINE_A, plannedQuantity: '10.000' },
        { id: LINE_B, plannedQuantity: '10.000' },
      ]);
      prisma.tx.importExpenseAllocationBatch.create.mockResolvedValue(
        makeBatchRow({ method: ImportExpenseAllocationMethod.MANUAL }),
      );
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.MANUAL,
          amountToAllocate: '80.00',
          manualAllocations: [
            { importShipmentLineId: LINE_A, amount: '40.00' },
            { importShipmentLineId: LINE_B, amount: '40.00' },
          ],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).resolves.toBeDefined();
    });

    it('excede el monto disponible del gasto (sumando lotes previos): ConflictException', async () => {
      queueExpenseLock('1000.00');
      prisma.tx.importExpenseAllocationBatch.findMany.mockResolvedValue([
        { requestedAmount: d('700.00') },
      ]);
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '400.00',
          shipmentLineIds: [LINE_A],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(
        prisma.tx.importExpenseAllocationBatch.create,
      ).not.toHaveBeenCalled();
    });

    it('gasto CANCELLED: ConflictException', async () => {
      queueExpenseLock('1000.00', ImportExpenseStatus.CANCELLED);
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '100.00',
          shipmentLineIds: [LINE_A],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('línea de OTRA operación (cross-operation): BadRequestException', async () => {
      queueExpenseLock();
      queueLineLock([
        {
          id: LINE_A,
          plannedQuantity: '10.000',
          importOperationId: 'other-operation',
        },
      ]);
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '100.00',
          shipmentLineIds: [LINE_A],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('línea de un embarque CANCELLED: ConflictException', async () => {
      queueExpenseLock();
      queueLineLock([
        { id: LINE_A, plannedQuantity: '10.000', shipmentStatus: 'CANCELLED' },
      ]);
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '100.00',
          shipmentLineIds: [LINE_A],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('idempotencyKey repetido: devuelve el mismo lote, nunca crea otro', async () => {
      queueExpenseLock();
      prisma.tx.importExpenseAllocationBatch.findUnique.mockResolvedValue(
        makeBatchRow(),
      );
      const result = await service.allocate({
        importExpenseId: EXPENSE_ID,
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '400.00',
        shipmentLineIds: [LINE_A, LINE_B],
        idempotencyKey: 'retry-1',
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });
      expect(result.id).toBe('batch-1');
      expect(
        prisma.tx.importExpenseAllocationBatch.create,
      ).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('shipmentLineIds duplicados: BadRequestException', async () => {
      queueExpenseLock();
      await expect(
        service.allocate({
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '100.00',
          shipmentLineIds: [LINE_A, LINE_A],
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('previewAllocation', () => {
    it('reutiliza el mismo cálculo, nunca persiste ni audita', async () => {
      prisma.importExpense.findUnique.mockResolvedValue({
        id: EXPENSE_ID,
        importOperationId: OPERATION_ID,
        status: ImportExpenseStatus.DRAFT,
      });
      prisma.importShipmentLine.findMany.mockResolvedValue([
        {
          id: LINE_A,
          plannedQuantity: d('10.000'),
          weightValue: null,
          volumeValue: null,
          importShipment: {
            status: 'PLANNED',
            importOperationId: OPERATION_ID,
          },
        },
        {
          id: LINE_B,
          plannedQuantity: d('30.000'),
          weightValue: null,
          volumeValue: null,
          importShipment: {
            status: 'PLANNED',
            importOperationId: OPERATION_ID,
          },
        },
      ]);

      const result = await service.previewAllocation(
        {
          importExpenseId: EXPENSE_ID,
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '400.00',
          shipmentLineIds: [LINE_A, LINE_B],
        },
        RoleName.ADMIN,
      );

      expect(result.lines).toHaveLength(2);
      const sum = result.lines.reduce(
        (s, l) => s.plus(new Prisma.Decimal(l.amount)),
        new Prisma.Decimal(0),
      );
      expect(sum.toFixed(2)).toBe('400.00');
      expect(
        prisma.tx.importExpenseAllocationBatch.create,
      ).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('rol sin permiso: ForbiddenException', async () => {
      await expect(
        service.previewAllocation(
          {
            importExpenseId: EXPENSE_ID,
            method: ImportExpenseAllocationMethod.QUANTITY,
            amountToAllocate: '100.00',
            shipmentLineIds: [LINE_A],
          },
          RoleName.SELLER,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });
});
