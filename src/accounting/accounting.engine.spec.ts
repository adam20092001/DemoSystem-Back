import {
  ConflictException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  AccountType,
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  PaymentMethod,
  Prisma,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { AccountingEngine } from './accounting.engine';
import {
  PostPaymentCollectionCommand,
  PostSaleRecognitionCommand,
  ReverseOriginalForSourceCommand,
} from './types/accounting-command';

const SALE_ID = '11111111-1111-4111-8111-111111111111';
const PAYMENT_ID = '22222222-2222-4222-8222-222222222222';
const ACTOR_ID = '33333333-3333-4333-8333-333333333333';
const SALE_NUMBER = 'NV-000001';
const ENTRY_ID = '44444444-4444-4444-8444-444444444444';
const POSTED_AT = new Date('2026-03-15T12:00:00.000Z');

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeAccountRow(
  systemKey: AccountingSystemKey,
  overrides: Partial<Record<string, unknown>> = {},
) {
  const byKey: Record<
    AccountingSystemKey,
    { id: string; code: string; name: string; type: AccountType }
  > = {
    [AccountingSystemKey.CASH]: {
      id: 'acc-cash',
      code: 'CASH',
      name: 'Caja',
      type: AccountType.ASSET,
    },
    [AccountingSystemKey.BANK]: {
      id: 'acc-bank',
      code: 'BANK',
      name: 'Bancos',
      type: AccountType.ASSET,
    },
    [AccountingSystemKey.ACCOUNTS_RECEIVABLE]: {
      id: 'acc-ar',
      code: 'AR',
      name: 'Cuentas por cobrar',
      type: AccountType.ASSET,
    },
    [AccountingSystemKey.VAT_PAYABLE]: {
      id: 'acc-vat',
      code: 'VAT',
      name: 'IGV por pagar',
      type: AccountType.LIABILITY,
    },
    [AccountingSystemKey.SALES_REVENUE]: {
      id: 'acc-sales',
      code: 'SALES',
      name: 'Ventas',
      type: AccountType.REVENUE,
    },
    [AccountingSystemKey.DISCOUNTS]: {
      id: 'acc-discounts',
      code: 'DISCOUNTS',
      name: 'Descuentos',
      type: AccountType.CONTRA_REVENUE,
    },
  };
  const base = byKey[systemKey];
  return {
    ...base,
    systemKey,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const ALL_ACCOUNTS = Object.values(AccountingSystemKey).map((key) =>
  makeAccountRow(key),
);

function makeSaleCommand(
  overrides: Partial<PostSaleRecognitionCommand> = {},
): PostSaleRecognitionCommand {
  return {
    saleId: SALE_ID,
    saleNumber: SALE_NUMBER,
    subtotal: d('100.00'),
    discountAmount: d('0.00'),
    taxAmount: d('0.00'),
    total: d('100.00'),
    postedAt: POSTED_AT,
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

function makePaymentCommand(
  overrides: Partial<PostPaymentCollectionCommand> = {},
): PostPaymentCollectionCommand {
  return {
    paymentId: PAYMENT_ID,
    saleNumber: SALE_NUMBER,
    method: PaymentMethod.CASH,
    amount: d('40.00'),
    postedAt: POSTED_AT,
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

function makeReverseCommand(
  overrides: Partial<ReverseOriginalForSourceCommand> = {},
): ReverseOriginalForSourceCommand {
  return {
    sourceType: AccountingSourceType.SALE,
    sourceId: SALE_ID,
    sourceNumber: SALE_NUMBER,
    postedAt: POSTED_AT,
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

function createTxMock() {
  return {
    accountingEntry: {
      findFirst: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    account: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

describe('AccountingEngine', () => {
  let tx: ReturnType<typeof createTxMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let engine: AccountingEngine;

  beforeEach(() => {
    tx = createTxMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    engine = new AccountingEngine(auditService as unknown as AuditService);

    tx.accountingEntry.findFirst.mockResolvedValue(null);
    tx.account.findMany.mockResolvedValue(ALL_ACCOUNTS);
    tx.accountingEntry.create.mockResolvedValue({
      id: ENTRY_ID,
      sourceType: AccountingSourceType.SALE,
      sourceId: SALE_ID,
      eventType: AccountingEventType.ORIGINAL,
    });
  });

  it('nunca abre transacción propia (no existe this.prisma en la clase)', () => {
    expect((engine as unknown as { prisma?: unknown }).prisma).toBeUndefined();
  });

  // ====================================================================
  // postSaleRecognition
  // ====================================================================
  describe('postSaleRecognition', () => {
    it('venta all-zero (0/0/0/0): retorna null, no crea nada, sin auditoría', async () => {
      const result = await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand({
          subtotal: d('0'),
          discountAmount: d('0'),
          taxAmount: d('0'),
          total: d('0'),
        }),
      );
      expect(result).toBeNull();
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('venta normal (100/0/0/100): crea ORIGINAL con las líneas correctas', async () => {
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          sourceType: AccountingSourceType;
          sourceId: string;
          eventType: AccountingEventType;
          description: string;
          postedAt: Date;
          createdByUserId: string;
          lines: {
            create: {
              accountId: string;
              debitAmount: Prisma.Decimal;
              creditAmount: Prisma.Decimal;
            }[];
          };
        };
      };
      expect(call.data.sourceType).toBe(AccountingSourceType.SALE);
      expect(call.data.sourceId).toBe(SALE_ID);
      expect(call.data.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(call.data.description).toBe(`Venta ${SALE_NUMBER}`);
      expect(call.data.postedAt).toBe(POSTED_AT);
      expect(call.data.createdByUserId).toBe(ACTOR_ID);
      expect(call.data.lines.create).toHaveLength(2);
      const byAccount = new Map(
        call.data.lines.create.map((l) => [l.accountId, l]),
      );
      expect(byAccount.get('acc-ar')?.debitAmount.toFixed(2)).toBe('100.00');
      expect(byAccount.get('acc-sales')?.creditAmount.toFixed(2)).toBe(
        '100.00',
      );
    });

    it('venta con descuento total (100/100/0/0): crea ORIGINAL sin línea AR', async () => {
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand({
          subtotal: d('100'),
          discountAmount: d('100'),
          taxAmount: d('0'),
          total: d('0'),
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { lines: { create: { accountId: string }[] } };
      };
      expect(call.data.lines.create).toHaveLength(2);
      expect(call.data.lines.create.some((l) => l.accountId === 'acc-ar')).toBe(
        false,
      );
    });

    it('resuelve las cuentas requeridas por systemKey vía tx.account.findMany (nunca por nombre/UUID hardcodeado)', async () => {
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      const call = tx.account.findMany.mock.calls[0][0] as {
        where: { systemKey: { in: AccountingSystemKey[] } };
      };
      expect(call.where.systemKey.in).toEqual(
        expect.arrayContaining([
          AccountingSystemKey.ACCOUNTS_RECEIVABLE,
          AccountingSystemKey.SALES_REVENUE,
        ]),
      );
    });

    it('falta una cuenta de sistema requerida: InternalServerErrorException, no crea el asiento', async () => {
      tx.account.findMany.mockResolvedValue(
        ALL_ACCOUNTS.filter(
          (a) => a.systemKey !== AccountingSystemKey.SALES_REVENUE,
        ),
      );
      await expect(
        engine.postSaleRecognition(
          tx as unknown as Prisma.TransactionClient,
          makeSaleCommand(),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('ya existe un ORIGINAL para esta venta: ConflictException, no crea un segundo', async () => {
      tx.accountingEntry.findFirst.mockResolvedValue({ id: 'existing-entry' });
      await expect(
        engine.postSaleRecognition(
          tx as unknown as Prisma.TransactionClient,
          makeSaleCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('el pre-check de duplicado consulta bajo el mismo tx, filtrando sourceType/sourceId/eventType=ORIGINAL', async () => {
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      expect(tx.accountingEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sourceType: AccountingSourceType.SALE,
            sourceId: SALE_ID,
            eventType: AccountingEventType.ORIGINAL,
          },
        }),
      );
    });

    it('audita ACCOUNTING_ENTRY_POSTED exactamente una vez, whitelist exacta, mismo tx', async () => {
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        module: string;
        entityType: string;
        entityId: string;
        metadata: Record<string, unknown>;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.ACCOUNTING_ENTRY_POSTED);
      expect(call.module).toBe('ACCOUNTING');
      expect(call.entityType).toBe('AccountingEntry');
      expect(call.entityId).toBe(ENTRY_ID);
      expect(call.metadata).toEqual({
        entryId: ENTRY_ID,
        sourceType: AccountingSourceType.SALE,
        sourceId: SALE_ID,
        eventType: AccountingEventType.ORIGINAL,
      });
      expect(call.client).toBe(tx);
    });
  });

  // ====================================================================
  // postPaymentCollection
  // ====================================================================
  describe('postPaymentCollection', () => {
    beforeEach(() => {
      tx.accountingEntry.create.mockResolvedValue({
        id: ENTRY_ID,
        sourceType: AccountingSourceType.PAYMENT,
        sourceId: PAYMENT_ID,
        eventType: AccountingEventType.ORIGINAL,
      });
    });

    it('crea ORIGINAL con exactamente dos líneas (cobro/AR) por el monto del pago', async () => {
      await engine.postPaymentCollection(
        tx as unknown as Prisma.TransactionClient,
        makePaymentCommand({ method: PaymentMethod.CASH, amount: d('40.00') }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          sourceType: AccountingSourceType;
          sourceId: string;
          description: string;
          lines: {
            create: {
              accountId: string;
              debitAmount: Prisma.Decimal;
              creditAmount: Prisma.Decimal;
            }[];
          };
        };
      };
      expect(call.data.sourceType).toBe(AccountingSourceType.PAYMENT);
      expect(call.data.sourceId).toBe(PAYMENT_ID);
      expect(call.data.description).toBe(`Cobro de venta ${SALE_NUMBER}`);
      expect(call.data.lines.create).toHaveLength(2);
      const byAccount = new Map(
        call.data.lines.create.map((l) => [l.accountId, l]),
      );
      expect(byAccount.get('acc-cash')?.debitAmount.toFixed(2)).toBe('40.00');
      expect(byAccount.get('acc-ar')?.creditAmount.toFixed(2)).toBe('40.00');
    });

    it('BANK_TRANSFER/BANK_DEPOSIT/CARD/DIGITAL_WALLET/OTHER cobran en la cuenta Bancos', async () => {
      for (const method of [
        PaymentMethod.BANK_TRANSFER,
        PaymentMethod.BANK_DEPOSIT,
        PaymentMethod.CARD,
        PaymentMethod.DIGITAL_WALLET,
        PaymentMethod.OTHER,
      ]) {
        tx.accountingEntry.create.mockClear();
        await engine.postPaymentCollection(
          tx as unknown as Prisma.TransactionClient,
          makePaymentCommand({ method }),
        );
        const call = tx.accountingEntry.create.mock.calls[0][0] as {
          data: {
            lines: {
              create: { accountId: string; debitAmount: Prisma.Decimal }[];
            };
          };
        };
        const debitLine = call.data.lines.create.find((l) =>
          l.debitAmount.greaterThan(0),
        );
        expect(debitLine?.accountId).toBe('acc-bank');
      }
    });

    it('duplicado ORIGINAL para el mismo Payment -> ConflictException', async () => {
      tx.accountingEntry.findFirst.mockResolvedValue({ id: 'existing' });
      await expect(
        engine.postPaymentCollection(
          tx as unknown as Prisma.TransactionClient,
          makePaymentCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('audita ACCOUNTING_ENTRY_POSTED exactamente una vez', async () => {
      await engine.postPaymentCollection(
        tx as unknown as Prisma.TransactionClient,
        makePaymentCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      expect(
        (auditService.record.mock.calls[0][0] as { action: AuditAction })
          .action,
      ).toBe(AuditAction.ACCOUNTING_ENTRY_POSTED);
    });
  });

  // ====================================================================
  // reverseOriginalForSource
  // ====================================================================
  describe('reverseOriginalForSource', () => {
    function makeOriginalWithLines() {
      return {
        id: 'original-entry-1',
        sourceType: AccountingSourceType.SALE,
        sourceId: SALE_ID,
        eventType: AccountingEventType.ORIGINAL,
        lines: [
          {
            accountId: 'acc-ar',
            debitAmount: d('100.00'),
            creditAmount: d('0'),
          },
          {
            accountId: 'acc-sales',
            debitAmount: d('0'),
            creditAmount: d('100.00'),
          },
        ],
      };
    }

    beforeEach(() => {
      tx.accountingEntry.create.mockResolvedValue({
        id: 'reversal-entry-1',
        sourceType: AccountingSourceType.SALE,
        sourceId: SALE_ID,
        eventType: AccountingEventType.REVERSAL,
      });
    });

    it('no existe ORIGINAL para esta fuente -> InternalServerErrorException (invariante roto, nunca sintetiza una reversión)', async () => {
      tx.accountingEntry.findFirst.mockResolvedValue(null);
      await expect(
        engine.reverseOriginalForSource(
          tx as unknown as Prisma.TransactionClient,
          makeReverseCommand(),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('ya existe una reversión para el original -> ConflictException', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce(makeOriginalWithLines())
        .mockResolvedValueOnce({ id: 'existing-reversal' });
      await expect(
        engine.reverseOriginalForSource(
          tx as unknown as Prisma.TransactionClient,
          makeReverseCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('inversión exacta: mismo accountId, debit<->credit, mismo monto', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce(makeOriginalWithLines())
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          eventType: AccountingEventType;
          reversesEntryId: string;
          sourceType: AccountingSourceType;
          sourceId: string;
          lines: {
            create: {
              accountId: string;
              debitAmount: Prisma.Decimal;
              creditAmount: Prisma.Decimal;
            }[];
          };
        };
      };
      expect(call.data.eventType).toBe(AccountingEventType.REVERSAL);
      expect(call.data.reversesEntryId).toBe('original-entry-1');
      expect(call.data.sourceType).toBe(AccountingSourceType.SALE);
      expect(call.data.sourceId).toBe(SALE_ID);
      const byAccount = new Map(
        call.data.lines.create.map((l) => [l.accountId, l]),
      );
      expect(byAccount.get('acc-ar')?.creditAmount.toFixed(2)).toBe('100.00');
      expect(byAccount.get('acc-ar')?.debitAmount.toFixed(2)).toBe('0.00');
      expect(byAccount.get('acc-sales')?.debitAmount.toFixed(2)).toBe('100.00');
      expect(byAccount.get('acc-sales')?.creditAmount.toFixed(2)).toBe('0.00');
    });

    it('descripción de reversión de VENTA: "Reversión de venta {sourceNumber}"', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce(makeOriginalWithLines())
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({ sourceType: AccountingSourceType.SALE }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { description: string };
      };
      expect(call.data.description).toBe(`Reversión de venta ${SALE_NUMBER}`);
    });

    it('descripción de reversión de PAGO: "Reversión de cobro de venta {sourceNumber}"', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce({
          ...makeOriginalWithLines(),
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: PAYMENT_ID,
        })
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: PAYMENT_ID,
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { description: string };
      };
      expect(call.data.description).toBe(
        `Reversión de cobro de venta ${SALE_NUMBER}`,
      );
    });

    it('postedAt/actor/ip del comando se propagan al asiento REVERSAL', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce(makeOriginalWithLines())
        .mockResolvedValueOnce(null);
      const cancelledAt = new Date('2026-04-01T09:30:00.000Z');
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({ postedAt: cancelledAt }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { postedAt: Date; createdByUserId: string };
      };
      expect(call.data.postedAt).toBe(cancelledAt);
      expect(call.data.createdByUserId).toBe(ACTOR_ID);
    });

    it('audita ACCOUNTING_ENTRY_REVERSED exactamente una vez, whitelist exacta, sin mutar el original', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce(makeOriginalWithLines())
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
      };
      expect(call.action).toBe(AuditAction.ACCOUNTING_ENTRY_REVERSED);
      expect(call.metadata).toEqual({
        entryId: 'reversal-entry-1',
        sourceType: AccountingSourceType.SALE,
        sourceId: SALE_ID,
        eventType: AccountingEventType.REVERSAL,
      });
      // No existe ningún método de actualización sobre accountingEntry: el
      // motor nunca puede mutar el original (solo findFirst/create).
      expect(
        (tx.accountingEntry as unknown as { update?: unknown }).update,
      ).toBeUndefined();
    });
  });
});
