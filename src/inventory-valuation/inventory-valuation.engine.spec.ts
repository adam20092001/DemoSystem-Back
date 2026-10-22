import { ConflictException } from '@nestjs/common';
import {
  InventoryValuationEventType,
  InventoryValuationMethod,
  Prisma,
} from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { InventoryValuationEngine } from './inventory-valuation.engine';
import { RecordOriginalValuationCommand } from './types/record-original-valuation.command';
import { ReverseValuationForLineCommand } from './types/reverse-valuation.command';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const MOVEMENT_ID = '22222222-2222-4222-8222-222222222222';
const RECEIPT_LINE_ID = '33333333-3333-4333-8333-333333333333';
const INVOICE_LINE_ID = '44444444-4444-4444-8444-444444444444';
const ACTOR_ID = '55555555-5555-4555-8555-555555555555';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function createTxMock() {
  return {
    product: {
      findUniqueOrThrow: jest.fn<Promise<unknown>, [unknown]>(),
    },
    inventoryValuation: {
      findUnique: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      findFirst: jest.fn<Promise<unknown>, [unknown]>(),
      create: jest.fn<Promise<unknown>, [unknown]>(),
      aggregate: jest.fn<Promise<unknown>, [unknown]>(),
    },
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

function makeCreatedRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'valuation-1',
    productId: PRODUCT_ID,
    inventoryMovementId: MOVEMENT_ID,
    purchaseReceiptLineId: RECEIPT_LINE_ID,
    eventType: InventoryValuationEventType.ORIGINAL,
    reversesValuationId: null,
    method: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
    quantity: d('10.000'),
    purchasePriceAmount: d('100.00'),
    nonCreditableTaxAmount: d('0.00'),
    additionalCostsAmount: d('0.00'),
    totalCost: d('100.00'),
    unitCost: d('10.000000'),
    createdByUserId: ACTOR_ID,
    createdAt: new Date(),
    ...overrides,
  };
}

describe('InventoryValuationEngine', () => {
  let tx: ReturnType<typeof createTxMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let engine: InventoryValuationEngine;

  beforeEach(() => {
    tx = createTxMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    engine = new InventoryValuationEngine(
      auditService as unknown as AuditService,
    );
  });

  function recordCommand(
    overrides: Partial<RecordOriginalValuationCommand> = {},
  ): RecordOriginalValuationCommand {
    return {
      productId: PRODUCT_ID,
      inventoryMovementId: MOVEMENT_ID,
      purchaseReceiptLineId: RECEIPT_LINE_ID,
      purchaseInvoiceLineId: INVOICE_LINE_ID,
      quantity: d('10.000'),
      invoicedQuantity: d('10.000'),
      priorReceivedQuantity: d('0'),
      lineFinancials: {
        taxableBaseAmount: d('100.00'),
        taxAmount: d('0.00'),
        creditableTaxAmount: d('0.00'),
      },
      actorUserId: ACTOR_ID,
      ipAddress: null,
      ...overrides,
    };
  }

  describe('recordOriginal', () => {
    it('producto sin valuationMethod: no-op (null), nunca crea nada', async () => {
      tx.product.findUniqueOrThrow.mockResolvedValue({ valuationMethod: null });
      const result = await engine.recordOriginal(
        tx as unknown as Prisma.TransactionClient,
        recordCommand(),
      );
      expect(result).toBeNull();
      expect(tx.inventoryValuation.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('producto con valuationMethod: crea el evento ORIGINAL con el costo calculado', async () => {
      tx.product.findUniqueOrThrow.mockResolvedValue({
        valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      });
      tx.inventoryValuation.findUnique.mockResolvedValue(null);
      tx.inventoryValuation.findMany.mockResolvedValue([]);
      tx.inventoryValuation.create.mockResolvedValue(makeCreatedRow());

      const result = await engine.recordOriginal(
        tx as unknown as Prisma.TransactionClient,
        recordCommand(),
      );

      expect(result).not.toBeNull();
      expect(tx.inventoryValuation.create).toHaveBeenCalledTimes(1);
      const call = tx.inventoryValuation.create.mock.calls[0][0] as {
        data: { eventType: string; totalCost: Prisma.Decimal };
      };
      expect(call.data.eventType).toBe(InventoryValuationEventType.ORIGINAL);
      expect(call.data.totalCost.toFixed(2)).toBe('100.00');
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('movimiento ya valorizado (reintento/invariante roto): ConflictException', async () => {
      tx.product.findUniqueOrThrow.mockResolvedValue({
        valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      });
      tx.inventoryValuation.findUnique.mockResolvedValue({ id: 'existing' });
      await expect(
        engine.recordOriginal(
          tx as unknown as Prisma.TransactionClient,
          recordCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.inventoryValuation.create).not.toHaveBeenCalled();
    });

    it('resta lo ya capitalizado por recepciones ACTIVE previas de la misma línea (asignación acumulada)', async () => {
      tx.product.findUniqueOrThrow.mockResolvedValue({
        valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      });
      tx.inventoryValuation.findUnique.mockResolvedValue(null);
      tx.inventoryValuation.findMany.mockResolvedValue([
        { totalCost: d('40.00') },
      ]);
      tx.inventoryValuation.create.mockResolvedValue(makeCreatedRow());

      await engine.recordOriginal(
        tx as unknown as Prisma.TransactionClient,
        recordCommand({
          quantity: d('4.000'),
          priorReceivedQuantity: d('4.000'),
          invoicedQuantity: d('10.000'),
        }),
      );

      const call = tx.inventoryValuation.create.mock.calls[0][0] as {
        data: { totalCost: Prisma.Decimal };
      };
      // cumulative 8/10 de 100.00 = 80.00; ya capitalizado 40.00 -> residual 40.00
      expect(call.data.totalCost.toFixed(2)).toBe('40.00');
    });

    it('línea sin monto elegible: no-op (null), sin crear nada', async () => {
      tx.product.findUniqueOrThrow.mockResolvedValue({
        valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      });
      tx.inventoryValuation.findUnique.mockResolvedValue(null);
      tx.inventoryValuation.findMany.mockResolvedValue([]);

      const result = await engine.recordOriginal(
        tx as unknown as Prisma.TransactionClient,
        recordCommand({
          lineFinancials: {
            taxableBaseAmount: d('0.00'),
            taxAmount: d('0.00'),
            creditableTaxAmount: d('0.00'),
          },
        }),
      );

      expect(result).toBeNull();
      expect(tx.inventoryValuation.create).not.toHaveBeenCalled();
    });
  });

  describe('reverseForReceiptLine', () => {
    function reverseCommand(
      overrides: Partial<ReverseValuationForLineCommand> = {},
    ): ReverseValuationForLineCommand {
      return {
        purchaseReceiptLineId: RECEIPT_LINE_ID,
        newInventoryMovementId: 'exit-movement-1',
        actorUserId: ACTOR_ID,
        ipAddress: null,
        ...overrides,
      };
    }

    it('línea nunca valorizada: no-op (null)', async () => {
      tx.inventoryValuation.findFirst.mockResolvedValue(null);
      const result = await engine.reverseForReceiptLine(
        tx as unknown as Prisma.TransactionClient,
        reverseCommand(),
      );
      expect(result).toBeNull();
      expect(tx.inventoryValuation.create).not.toHaveBeenCalled();
    });

    it('camino feliz: crea el evento REVERSAL reutilizando el costo exacto del ORIGINAL', async () => {
      const original = makeCreatedRow({ id: 'original-1' });
      tx.inventoryValuation.findFirst
        .mockResolvedValueOnce(original) // búsqueda del ORIGINAL
        .mockResolvedValueOnce(null); // sin reversión previa
      tx.inventoryValuation.aggregate
        .mockResolvedValueOnce({ _sum: { quantity: d('10.000') } }) // total ORIGINAL
        .mockResolvedValueOnce({ _sum: { quantity: d('0') } }); // total REVERSAL
      tx.inventoryValuation.create.mockResolvedValue(
        makeCreatedRow({
          id: 'reversal-1',
          eventType: InventoryValuationEventType.REVERSAL,
          reversesValuationId: 'original-1',
        }),
      );

      const result = await engine.reverseForReceiptLine(
        tx as unknown as Prisma.TransactionClient,
        reverseCommand(),
      );

      expect(result).not.toBeNull();
      const call = tx.inventoryValuation.create.mock.calls[0][0] as {
        data: {
          eventType: string;
          reversesValuationId: string;
          totalCost: Prisma.Decimal;
        };
      };
      expect(call.data.eventType).toBe(InventoryValuationEventType.REVERSAL);
      expect(call.data.reversesValuationId).toBe('original-1');
      expect(call.data.totalCost.toFixed(2)).toBe('100.00');
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });

    it('ya revertida anteriormente: ConflictException', async () => {
      tx.inventoryValuation.findFirst
        .mockResolvedValueOnce(makeCreatedRow({ id: 'original-1' }))
        .mockResolvedValueOnce({ id: 'existing-reversal' });
      await expect(
        engine.reverseForReceiptLine(
          tx as unknown as Prisma.TransactionClient,
          reverseCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.inventoryValuation.create).not.toHaveBeenCalled();
    });

    it('cantidad valorizada vigente insuficiente (consumida por movimientos posteriores): ConflictException', async () => {
      tx.inventoryValuation.findFirst
        .mockResolvedValueOnce(
          makeCreatedRow({ id: 'original-1', quantity: d('10.000') }),
        )
        .mockResolvedValueOnce(null);
      // total ORIGINAL=10, total REVERSAL=5 -> vigente=5, menor que lo que se intenta revertir (10)
      tx.inventoryValuation.aggregate
        .mockResolvedValueOnce({ _sum: { quantity: d('10.000') } })
        .mockResolvedValueOnce({ _sum: { quantity: d('5.000') } });

      await expect(
        engine.reverseForReceiptLine(
          tx as unknown as Prisma.TransactionClient,
          reverseCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.inventoryValuation.create).not.toHaveBeenCalled();
    });
  });
});
