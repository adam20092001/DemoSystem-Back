import {
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountStatus,
  AccountType,
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  PaymentMethodAccountingDestination,
  Prisma,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { AccountingEngine } from './accounting.engine';
import {
  PostManualEntryCommand,
  PostPaymentCollectionCommand,
  PostPurchaseReceiptReclassificationCommand,
  PostPurchaseRecognitionCommand,
  PostSaleRecognitionCommand,
  PostSupplierPaymentCollectionCommand,
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
    // Fase A5.2a: fixtures de prueba únicamente, ninguna cuenta real en
    // pos_db/pos_db_test tiene estos systemKey mapeados todavía.
    [AccountingSystemKey.ACCOUNTS_PAYABLE]: {
      id: 'acc-ap',
      code: 'AP',
      name: 'Cuentas por pagar',
      type: AccountType.LIABILITY,
    },
    [AccountingSystemKey.VAT_RECEIVABLE]: {
      id: 'acc-vat-receivable',
      code: 'VAT_RECEIVABLE',
      name: 'IGV por recuperar',
      type: AccountType.ASSET,
    },
    [AccountingSystemKey.PURCHASE_RESALE_INVENTORY]: {
      id: 'acc-purchase-resale',
      code: 'PURCHASE_RESALE',
      name: 'Compras para reventa',
      type: AccountType.ASSET,
    },
    [AccountingSystemKey.PURCHASE_INTERNAL_CONSUMPTION]: {
      id: 'acc-purchase-internal',
      code: 'PURCHASE_INTERNAL',
      name: 'Compras de consumo interno',
      type: AccountType.EXPENSE,
    },
    [AccountingSystemKey.PURCHASE_FIXED_ASSET]: {
      id: 'acc-purchase-fixed-asset',
      code: 'PURCHASE_FIXED_ASSET',
      name: 'Compras de activo fijo',
      type: AccountType.ASSET,
    },
    [AccountingSystemKey.PURCHASE_OPERATING_EXPENSE]: {
      id: 'acc-purchase-opex',
      code: 'PURCHASE_OPEX',
      name: 'Compras de gasto operativo',
      type: AccountType.EXPENSE,
    },
    [AccountingSystemKey.PURCHASE_OTHER]: {
      id: 'acc-purchase-other',
      code: 'PURCHASE_OTHER',
      name: 'Compras otros',
      type: AccountType.EXPENSE,
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

const MANUAL_DRAFT_ID = '66666666-6666-4666-8666-666666666666';
const MANUAL_ACCOUNT_DEBIT_ID = '77777777-7777-4777-8777-777777777777';
const MANUAL_ACCOUNT_CREDIT_ID = '88888888-8888-4888-8888-888888888888';

function makeManualAccountRow(
  id: string,
  overrides: Partial<Record<string, unknown>> = {},
) {
  return {
    id,
    code: `MAN-${id.slice(0, 4)}`,
    name: `Cuenta manual ${id.slice(0, 4)}`,
    type: AccountType.ASSET,
    systemKey: null,
    status: AccountStatus.ACTIVE,
    isPostable: true,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

const MANUAL_ACCOUNTS = [
  makeManualAccountRow(MANUAL_ACCOUNT_DEBIT_ID),
  makeManualAccountRow(MANUAL_ACCOUNT_CREDIT_ID),
];

function makeManualCommand(
  overrides: Partial<PostManualEntryCommand> = {},
): PostManualEntryCommand {
  return {
    draftId: MANUAL_DRAFT_ID,
    description: 'Ajuste de provisión de alquiler',
    accountingDateOnly: '2026-03-15',
    lines: [
      {
        accountId: MANUAL_ACCOUNT_DEBIT_ID,
        debitAmount: d('100.00'),
        creditAmount: d('0.00'),
      },
      {
        accountId: MANUAL_ACCOUNT_CREDIT_ID,
        debitAmount: d('0.00'),
        creditAmount: d('100.00'),
      },
    ],
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

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
    accountingDestination: PaymentMethodAccountingDestination.CASH,
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

const PURCHASE_INVOICE_ID = '99999999-9999-4999-8999-999999999999';

const PURCHASE_ACCOUNTS = [
  makeAccountRow(AccountingSystemKey.ACCOUNTS_PAYABLE),
  makeAccountRow(AccountingSystemKey.VAT_RECEIVABLE),
  makeAccountRow(AccountingSystemKey.PURCHASE_RESALE_INVENTORY),
  makeAccountRow(AccountingSystemKey.PURCHASE_OPERATING_EXPENSE),
];

function makePurchaseCommand(
  overrides: Partial<PostPurchaseRecognitionCommand> = {},
): PostPurchaseRecognitionCommand {
  return {
    purchaseInvoiceId: PURCHASE_INVOICE_ID,
    description: 'Compra FACTURA F001-123',
    accountingDateOnly: '2026-03-15',
    lines: [
      {
        systemKey: AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
        debitAmount: d('100.00'),
        creditAmount: d('0.00'),
      },
      {
        systemKey: AccountingSystemKey.VAT_RECEIVABLE,
        debitAmount: d('18.00'),
        creditAmount: d('0.00'),
      },
      {
        systemKey: AccountingSystemKey.ACCOUNTS_PAYABLE,
        debitAmount: d('0.00'),
        creditAmount: d('118.00'),
      },
    ],
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

const PURCHASE_RECEIPT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

/**
 * Fase A5.2b: reclasificación resuelta por accountId real (igual criterio
 * que PostManualEntryCommand) — reutiliza las mismas MANUAL_ACCOUNTS
 * fixture (ACTIVE+isPostable) ya usadas por postManualEntry().
 */
function makePurchaseReceiptReclassificationCommand(
  overrides: Partial<PostPurchaseReceiptReclassificationCommand> = {},
): PostPurchaseReceiptReclassificationCommand {
  return {
    purchaseReceiptId: PURCHASE_RECEIPT_ID,
    description: 'Reclasificación por recepción de compra FACTURA F001-123',
    accountingDateOnly: '2026-03-20',
    lines: [
      {
        accountId: MANUAL_ACCOUNT_DEBIT_ID,
        debitAmount: d('40.00'),
        creditAmount: d('0.00'),
      },
      {
        accountId: MANUAL_ACCOUNT_CREDIT_ID,
        debitAmount: d('0.00'),
        creditAmount: d('40.00'),
      },
    ],
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

const SUPPLIER_PAYMENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

/**
 * Fase A5.3: híbrido — el lado CASH/BANK se resuelve por systemKey (igual
 * que postPaymentCollection), el lado de pasivo llega YA resuelto por
 * accountId real (igual criterio que postManualEntry/
 * postPurchaseReceiptReclassification) — SupplierPaymentsService ya
 * determinó la cuenta histórica.
 */
function makeSupplierPaymentCommand(
  overrides: Partial<PostSupplierPaymentCollectionCommand> = {},
): PostSupplierPaymentCollectionCommand {
  return {
    supplierPaymentId: SUPPLIER_PAYMENT_ID,
    description: 'Pago a proveedor Acme SAC',
    accountingDateOnly: '2026-03-20',
    accountingDestination: PaymentMethodAccountingDestination.CASH,
    liabilityLines: [
      { accountId: MANUAL_ACCOUNT_DEBIT_ID, amount: d('150.00') },
    ],
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    ...overrides,
  };
}

const PERIOD_ID = '55555555-5555-4555-8555-555555555555';

function createTxMock() {
  return {
    accountingEntry: {
      findFirst: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    account: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    accountingPeriod: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
    $executeRaw: jest.fn<Promise<number>, [unknown]>(),
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
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
    // Fase A2: por defecto, el periodo (POSTED_AT cae en 2026-03) ya existe
    // y está OPEN con lastJournalNumber=0 -> el UPDATE...RETURNING entrega 1.
    tx.accountingPeriod.findUnique.mockResolvedValue({ id: PERIOD_ID });
    tx.$executeRaw.mockResolvedValue(1);
    tx.$queryRaw.mockResolvedValue([{ lastJournalNumber: 1 }]);
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

    it('A1-review: filtra explícitamente status=ACTIVE e isPostable=true (defensa en profundidad del motor)', async () => {
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      const call = tx.account.findMany.mock.calls[0][0] as {
        where: { status: string; isPostable: boolean };
      };
      expect(call.where.status).toBe('ACTIVE');
      expect(call.where.isPostable).toBe(true);
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
        makePaymentCommand({
          accountingDestination: PaymentMethodAccountingDestination.CASH,
          amount: d('40.00'),
        }),
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

    it('accountingDestination=BANK cobra en la cuenta Bancos (Ticket C, Bloque C3: cualquier método dinámico resuelto a BANK, no una lista fija de enum)', async () => {
      tx.accountingEntry.create.mockClear();
      await engine.postPaymentCollection(
        tx as unknown as Prisma.TransactionClient,
        makePaymentCommand({
          accountingDestination: PaymentMethodAccountingDestination.BANK,
        }),
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
  // postManualEntry (Fase A4.4)
  // ====================================================================
  describe('postManualEntry', () => {
    beforeEach(() => {
      tx.account.findMany.mockResolvedValue(MANUAL_ACCOUNTS);
      tx.accountingEntry.create.mockResolvedValue({
        id: ENTRY_ID,
        sourceType: AccountingSourceType.MANUAL,
        sourceId: MANUAL_DRAFT_ID,
        eventType: AccountingEventType.ORIGINAL,
      });
    });

    it('crea ORIGINAL con sourceType=MANUAL, sourceId=draftId y las líneas por accountId', async () => {
      await engine.postManualEntry(
        tx as unknown as Prisma.TransactionClient,
        makeManualCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          sourceType: AccountingSourceType;
          sourceId: string;
          eventType: AccountingEventType;
          description: string;
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
      expect(call.data.sourceType).toBe(AccountingSourceType.MANUAL);
      expect(call.data.sourceId).toBe(MANUAL_DRAFT_ID);
      expect(call.data.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(call.data.description).toBe('Ajuste de provisión de alquiler');
      expect(call.data.createdByUserId).toBe(ACTOR_ID);
      const byAccount = new Map(
        call.data.lines.create.map((l) => [l.accountId, l]),
      );
      expect(
        byAccount.get(MANUAL_ACCOUNT_DEBIT_ID)?.debitAmount.toFixed(2),
      ).toBe('100.00');
      expect(
        byAccount.get(MANUAL_ACCOUNT_CREDIT_ID)?.creditAmount.toFixed(2),
      ).toBe('100.00');
    });

    it('usa la fecha contable EXPLÍCITA del comando, nunca derivada de postedAt/new Date()', async () => {
      await engine.postManualEntry(
        tx as unknown as Prisma.TransactionClient,
        makeManualCommand({ accountingDateOnly: '2026-03-20' }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { accountingDate: Date };
      };
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-03-20T00:00:00.000Z',
      );
    });

    it('fecha explícita inválida: BadRequestException, no consulta cuentas ni crea el asiento', async () => {
      await expect(
        engine.postManualEntry(
          tx as unknown as Prisma.TransactionClient,
          makeManualCommand({ accountingDateOnly: '2026-02-30' }),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('draft ya contabilizado (ya existe ORIGINAL con sourceType=MANUAL/sourceId=draftId): ConflictException', async () => {
      tx.accountingEntry.findFirst.mockResolvedValue({ id: 'existing-entry' });
      await expect(
        engine.postManualEntry(
          tx as unknown as Prisma.TransactionClient,
          makeManualCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
      expect(tx.accountingEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sourceType: AccountingSourceType.MANUAL,
            sourceId: MANUAL_DRAFT_ID,
            eventType: AccountingEventType.ORIGINAL,
          },
        }),
      );
    });

    it('cuenta referenciada inexistente/inactiva/no postable: BadRequestException (nunca 500 — error de entrada del ACCOUNTANT)', async () => {
      tx.account.findMany.mockResolvedValue([
        makeManualAccountRow(MANUAL_ACCOUNT_DEBIT_ID),
        // MANUAL_ACCOUNT_CREDIT_ID queda excluido (inactiva/inexistente).
      ]);
      await expect(
        engine.postManualEntry(
          tx as unknown as Prisma.TransactionClient,
          makeManualCommand(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('resuelve cuentas por accountId (nunca por systemKey): el where usa id.in, filtrando ACTIVE+isPostable', async () => {
      await engine.postManualEntry(
        tx as unknown as Prisma.TransactionClient,
        makeManualCommand(),
      );
      const call = tx.account.findMany.mock.calls[0][0] as {
        where: { id: { in: string[] }; status: string; isPostable: boolean };
      };
      expect(call.where.id.in).toEqual(
        expect.arrayContaining([
          MANUAL_ACCOUNT_DEBIT_ID,
          MANUAL_ACCOUNT_CREDIT_ID,
        ]),
      );
      expect(call.where.status).toBe('ACTIVE');
      expect(call.where.isPostable).toBe(true);
    });

    it('líneas desbalanceadas: la defensa en profundidad del motor también rechaza (InternalServerErrorException, el servicio ya debió filtrar esto con 400 antes)', async () => {
      await expect(
        engine.postManualEntry(
          tx as unknown as Prisma.TransactionClient,
          makeManualCommand({
            lines: [
              {
                accountId: MANUAL_ACCOUNT_DEBIT_ID,
                debitAmount: d('100.00'),
                creditAmount: d('0.00'),
              },
              {
                accountId: MANUAL_ACCOUNT_CREDIT_ID,
                debitAmount: d('0.00'),
                creditAmount: d('90.00'),
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('periodo del mes solicitado no existe y NO es el mes de negocio en curso: NotFoundException, nunca auto-crea un periodo histórico', async () => {
      tx.accountingPeriod.findUnique.mockResolvedValue(null);
      await expect(
        engine.postManualEntry(
          tx as unknown as Prisma.TransactionClient,
          // "Hoy" para el motor es la fecha real del sistema; usamos una
          // fecha explícita lejana en el pasado para garantizar que nunca
          // coincide con el mes de negocio en curso.
          makeManualCommand({ accountingDateOnly: '2020-01-15' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.$executeRaw).not.toHaveBeenCalled();
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('periodo del mes solicitado existe pero está CERRADO: ConflictException vía el mismo UPDATE...RETURNING que el posteo comercial', async () => {
      tx.accountingPeriod.findUnique.mockResolvedValue({ id: PERIOD_ID });
      tx.$queryRaw.mockResolvedValue([]);
      await expect(
        engine.postManualEntry(
          tx as unknown as Prisma.TransactionClient,
          makeManualCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('asigna el journalNumber devuelto por el UPDATE...RETURNING, igual que el posteo comercial', async () => {
      tx.$queryRaw.mockResolvedValue([{ lastJournalNumber: 5 }]);
      await engine.postManualEntry(
        tx as unknown as Prisma.TransactionClient,
        makeManualCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { journalNumber: number };
      };
      expect(call.data.journalNumber).toBe(5);
    });

    it('audita ACCOUNTING_ENTRY_POSTED exactamente una vez, mismo tx', async () => {
      await engine.postManualEntry(
        tx as unknown as Prisma.TransactionClient,
        makeManualCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.ACCOUNTING_ENTRY_POSTED);
      expect(call.metadata).toEqual({
        entryId: ENTRY_ID,
        sourceType: AccountingSourceType.MANUAL,
        sourceId: MANUAL_DRAFT_ID,
        eventType: AccountingEventType.ORIGINAL,
      });
      expect(call.client).toBe(tx);
    });
  });

  // ====================================================================
  // postPurchaseRecognition (Fase A5.2a)
  // ====================================================================
  describe('postPurchaseRecognition', () => {
    beforeEach(() => {
      tx.account.findMany.mockResolvedValue(PURCHASE_ACCOUNTS);
      tx.accountingEntry.create.mockResolvedValue({
        id: ENTRY_ID,
        sourceType: AccountingSourceType.PURCHASE,
        sourceId: PURCHASE_INVOICE_ID,
        eventType: AccountingEventType.ORIGINAL,
        journalNumber: 1,
        accountingDate: new Date('2026-03-15T00:00:00.000Z'),
      });
    });

    it('crea ORIGINAL con sourceType=PURCHASE, sourceId=purchaseInvoiceId y las líneas resueltas por systemKey', async () => {
      await engine.postPurchaseRecognition(
        tx as unknown as Prisma.TransactionClient,
        makePurchaseCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          sourceType: AccountingSourceType;
          sourceId: string;
          eventType: AccountingEventType;
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
      expect(call.data.sourceType).toBe(AccountingSourceType.PURCHASE);
      expect(call.data.sourceId).toBe(PURCHASE_INVOICE_ID);
      expect(call.data.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(call.data.description).toBe('Compra FACTURA F001-123');
      expect(call.data.lines.create).toHaveLength(3);
    });

    it('factura ya contabilizada (ya existe ORIGINAL con sourceType=PURCHASE/sourceId=purchaseInvoiceId): ConflictException', async () => {
      tx.accountingEntry.findFirst.mockResolvedValue({ id: 'existing-entry' });
      await expect(
        engine.postPurchaseRecognition(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
      expect(tx.accountingEntry.findFirst).toHaveBeenCalledWith(
        expect.objectContaining({
          where: {
            sourceType: AccountingSourceType.PURCHASE,
            sourceId: PURCHASE_INVOICE_ID,
            eventType: AccountingEventType.ORIGINAL,
          },
        }),
      );
    });

    it('falta un mapeo contable (p. ej. ACCOUNTS_PAYABLE sin cuenta activa/postable): ConflictException (409, nunca 500)', async () => {
      tx.account.findMany.mockResolvedValue(
        PURCHASE_ACCOUNTS.filter(
          (a) => a.systemKey !== AccountingSystemKey.ACCOUNTS_PAYABLE,
        ),
      );
      await expect(
        engine.postPurchaseRecognition(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('creditableTaxAmount=0 en todas las líneas NUNCA exime el mapeo de ACCOUNTS_PAYABLE', async () => {
      tx.account.findMany.mockResolvedValue(
        PURCHASE_ACCOUNTS.filter(
          (a) => a.systemKey !== AccountingSystemKey.ACCOUNTS_PAYABLE,
        ),
      );
      await expect(
        engine.postPurchaseRecognition(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseCommand({
            lines: [
              {
                systemKey: AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
                debitAmount: d('100.00'),
                creditAmount: d('0.00'),
              },
              {
                systemKey: AccountingSystemKey.ACCOUNTS_PAYABLE,
                debitAmount: d('0.00'),
                creditAmount: d('100.00'),
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('usa la fecha contable EXPLÍCITA del comando, nunca derivada de un instante', async () => {
      await engine.postPurchaseRecognition(
        tx as unknown as Prisma.TransactionClient,
        makePurchaseCommand({ accountingDateOnly: '2026-03-20' }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { accountingDate: Date };
      };
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-03-20T00:00:00.000Z',
      );
    });

    it('periodo del mes solicitado no existe y no es el mes en curso: NotFoundException', async () => {
      tx.accountingPeriod.findUnique.mockResolvedValue(null);
      await expect(
        engine.postPurchaseRecognition(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseCommand({ accountingDateOnly: '2020-01-15' }),
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('periodo existe pero está CERRADO: ConflictException vía el mismo UPDATE...RETURNING', async () => {
      tx.accountingPeriod.findUnique.mockResolvedValue({ id: PERIOD_ID });
      tx.$queryRaw.mockResolvedValue([]);
      await expect(
        engine.postPurchaseRecognition(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('líneas desbalanceadas: defensa en profundidad del motor (InternalServerErrorException)', async () => {
      await expect(
        engine.postPurchaseRecognition(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseCommand({
            lines: [
              {
                systemKey: AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
                debitAmount: d('100.00'),
                creditAmount: d('0.00'),
              },
              {
                systemKey: AccountingSystemKey.ACCOUNTS_PAYABLE,
                debitAmount: d('0.00'),
                creditAmount: d('90.00'),
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('audita ACCOUNTING_ENTRY_POSTED exactamente una vez, mismo tx', async () => {
      await engine.postPurchaseRecognition(
        tx as unknown as Prisma.TransactionClient,
        makePurchaseCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.ACCOUNTING_ENTRY_POSTED);
      expect(call.client).toBe(tx);
    });
  });

  // ====================================================================
  // postPurchaseReceiptReclassification (Fase A5.2b)
  // ====================================================================
  describe('postPurchaseReceiptReclassification', () => {
    beforeEach(() => {
      tx.account.findMany.mockResolvedValue(MANUAL_ACCOUNTS);
      tx.accountingEntry.create.mockResolvedValue({
        id: ENTRY_ID,
        sourceType: AccountingSourceType.PURCHASE_RECEIPT,
        sourceId: PURCHASE_RECEIPT_ID,
        eventType: AccountingEventType.ORIGINAL,
        journalNumber: 1,
        accountingDate: new Date('2026-03-20T00:00:00.000Z'),
      });
    });

    it('crea ORIGINAL con sourceType=PURCHASE_RECEIPT, sourceId=purchaseReceiptId y las líneas por accountId', async () => {
      await engine.postPurchaseReceiptReclassification(
        tx as unknown as Prisma.TransactionClient,
        makePurchaseReceiptReclassificationCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          sourceType: AccountingSourceType;
          sourceId: string;
          eventType: AccountingEventType;
          lines: { create: { accountId: string }[] };
        };
      };
      expect(call.data.sourceType).toBe(AccountingSourceType.PURCHASE_RECEIPT);
      expect(call.data.sourceId).toBe(PURCHASE_RECEIPT_ID);
      expect(call.data.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(call.data.lines.create).toHaveLength(2);
    });

    it('recepción ya reclasificada (ya existe ORIGINAL con ese sourceType/sourceId): ConflictException', async () => {
      tx.accountingEntry.findFirst.mockResolvedValue({ id: 'existing-entry' });
      await expect(
        engine.postPurchaseReceiptReclassification(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseReceiptReclassificationCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('cuenta inexistente/inactiva/no postable: BadRequestException (error de entrada del llamador, no 500)', async () => {
      tx.account.findMany.mockResolvedValue([
        makeManualAccountRow(MANUAL_ACCOUNT_DEBIT_ID),
      ]);
      await expect(
        engine.postPurchaseReceiptReclassification(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseReceiptReclassificationCommand(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('líneas desbalanceadas: defensa en profundidad del motor (InternalServerErrorException)', async () => {
      await expect(
        engine.postPurchaseReceiptReclassification(
          tx as unknown as Prisma.TransactionClient,
          makePurchaseReceiptReclassificationCommand({
            lines: [
              {
                accountId: MANUAL_ACCOUNT_DEBIT_ID,
                debitAmount: d('40.00'),
                creditAmount: d('0.00'),
              },
              {
                accountId: MANUAL_ACCOUNT_CREDIT_ID,
                debitAmount: d('0.00'),
                creditAmount: d('30.00'),
              },
            ],
          }),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('usa la fecha contable EXPLÍCITA del comando (la del recibo), nunca derivada de un instante', async () => {
      await engine.postPurchaseReceiptReclassification(
        tx as unknown as Prisma.TransactionClient,
        makePurchaseReceiptReclassificationCommand({
          accountingDateOnly: '2026-03-22',
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { accountingDate: Date };
      };
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-03-22T00:00:00.000Z',
      );
    });

    it('audita ACCOUNTING_ENTRY_POSTED exactamente una vez, mismo tx', async () => {
      await engine.postPurchaseReceiptReclassification(
        tx as unknown as Prisma.TransactionClient,
        makePurchaseReceiptReclassificationCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.ACCOUNTING_ENTRY_POSTED);
      expect(call.client).toBe(tx);
    });
  });

  // ====================================================================
  // postSupplierPaymentCollection (Fase A5.3)
  // ====================================================================
  describe('postSupplierPaymentCollection', () => {
    function queueAccountLookups(): void {
      // Dos llamadas a tx.account.findMany en orden: primero
      // resolveAccounts() (CASH/BANK por systemKey), luego
      // resolveManualAccounts() (cuenta de pasivo histórica por accountId).
      tx.account.findMany
        .mockReset()
        .mockResolvedValueOnce(ALL_ACCOUNTS)
        .mockResolvedValueOnce(MANUAL_ACCOUNTS);
    }

    beforeEach(() => {
      queueAccountLookups();
      tx.accountingEntry.create.mockResolvedValue({
        id: ENTRY_ID,
        sourceType: AccountingSourceType.SUPPLIER_PAYMENT,
        sourceId: SUPPLIER_PAYMENT_ID,
        eventType: AccountingEventType.ORIGINAL,
      });
    });

    it('crea ORIGINAL con sourceType=SUPPLIER_PAYMENT, sourceId=supplierPaymentId; debita la cuenta de pasivo y acredita CASH', async () => {
      await engine.postSupplierPaymentCollection(
        tx as unknown as Prisma.TransactionClient,
        makeSupplierPaymentCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          sourceType: AccountingSourceType;
          sourceId: string;
          eventType: AccountingEventType;
          lines: {
            create: {
              accountId: string;
              debitAmount: Prisma.Decimal;
              creditAmount: Prisma.Decimal;
            }[];
          };
        };
      };
      expect(call.data.sourceType).toBe(AccountingSourceType.SUPPLIER_PAYMENT);
      expect(call.data.sourceId).toBe(SUPPLIER_PAYMENT_ID);
      expect(call.data.eventType).toBe(AccountingEventType.ORIGINAL);
      const byAccount = new Map(
        call.data.lines.create.map((l) => [l.accountId, l]),
      );
      expect(
        byAccount.get(MANUAL_ACCOUNT_DEBIT_ID)?.debitAmount.toFixed(2),
      ).toBe('150.00');
      expect(byAccount.get('acc-cash')?.creditAmount.toFixed(2)).toBe('150.00');
    });

    it('agrupa varias líneas de pasivo con la MISMA cuenta en una sola línea de débito', async () => {
      await engine.postSupplierPaymentCollection(
        tx as unknown as Prisma.TransactionClient,
        makeSupplierPaymentCommand({
          liabilityLines: [
            { accountId: MANUAL_ACCOUNT_DEBIT_ID, amount: d('100.00') },
            { accountId: MANUAL_ACCOUNT_DEBIT_ID, amount: d('50.00') },
          ],
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          lines: {
            create: { accountId: string; debitAmount: Prisma.Decimal }[];
          };
        };
      };
      const debitLines = call.data.lines.create.filter(
        (l) => l.accountId === MANUAL_ACCOUNT_DEBIT_ID,
      );
      expect(debitLines).toHaveLength(2);
    });

    it('pago ya contabilizado (ya existe ORIGINAL con ese sourceType/sourceId): ConflictException', async () => {
      tx.accountingEntry.findFirst.mockResolvedValue({ id: 'existing-entry' });
      await expect(
        engine.postSupplierPaymentCollection(
          tx as unknown as Prisma.TransactionClient,
          makeSupplierPaymentCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
    });

    it('falta la cuenta de sistema CASH/BANK: InternalServerErrorException (corrupción de configuración, 500)', async () => {
      tx.account.findMany.mockReset().mockResolvedValue(MANUAL_ACCOUNTS);
      await expect(
        engine.postSupplierPaymentCollection(
          tx as unknown as Prisma.TransactionClient,
          makeSupplierPaymentCommand(),
        ),
      ).rejects.toBeInstanceOf(InternalServerErrorException);
    });

    it('cuenta de pasivo inexistente/inactiva/no postable: BadRequestException (error de entrada, nunca 500)', async () => {
      tx.account.findMany.mockReset().mockResolvedValue(ALL_ACCOUNTS);
      await expect(
        engine.postSupplierPaymentCollection(
          tx as unknown as Prisma.TransactionClient,
          makeSupplierPaymentCommand(),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('usa la fecha contable EXPLÍCITA del comando (la del pago), nunca derivada de un instante', async () => {
      await engine.postSupplierPaymentCollection(
        tx as unknown as Prisma.TransactionClient,
        makeSupplierPaymentCommand({ accountingDateOnly: '2026-03-25' }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { accountingDate: Date };
      };
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-03-25T00:00:00.000Z',
      );
    });

    it('audita ACCOUNTING_ENTRY_POSTED exactamente una vez, mismo tx', async () => {
      await engine.postSupplierPaymentCollection(
        tx as unknown as Prisma.TransactionClient,
        makeSupplierPaymentCommand(),
      );
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        client: unknown;
      };
      expect(call.action).toBe(AuditAction.ACCOUNTING_ENTRY_POSTED);
      expect(call.client).toBe(tx);
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

    it('descripción de reversión MANUAL: reutiliza original.description (nunca sourceNumber, que no aplica) con el prefijo fijo', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce({
          ...makeOriginalWithLines(),
          sourceType: AccountingSourceType.MANUAL,
          sourceId: MANUAL_DRAFT_ID,
          description: 'Ajuste de provisión de alquiler',
        })
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({
          sourceType: AccountingSourceType.MANUAL,
          sourceId: MANUAL_DRAFT_ID,
          sourceNumber: '',
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { description: string };
      };
      expect(call.data.description).toBe(
        'Reversión de asiento manual: Ajuste de provisión de alquiler',
      );
    });

    it('descripción de reversión PURCHASE: usa sourceNumber (serie-número de documento), nunca original.description', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce({
          ...makeOriginalWithLines(),
          sourceType: AccountingSourceType.PURCHASE,
          sourceId: PURCHASE_INVOICE_ID,
          description: 'Compra FACTURA F001-123',
        })
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({
          sourceType: AccountingSourceType.PURCHASE,
          sourceId: PURCHASE_INVOICE_ID,
          sourceNumber: 'FACTURA F001-123',
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { description: string };
      };
      expect(call.data.description).toBe(
        'Reversión de compra FACTURA F001-123',
      );
    });

    it('descripción de reversión PURCHASE_RECEIPT: usa sourceNumber, nunca original.description', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce({
          ...makeOriginalWithLines(),
          sourceType: AccountingSourceType.PURCHASE_RECEIPT,
          sourceId: PURCHASE_RECEIPT_ID,
          description:
            'Reclasificación por recepción de compra FACTURA F001-123',
        })
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({
          sourceType: AccountingSourceType.PURCHASE_RECEIPT,
          sourceId: PURCHASE_RECEIPT_ID,
          sourceNumber: PURCHASE_RECEIPT_ID,
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { description: string };
      };
      expect(call.data.description).toBe(
        `Reversión de reclasificación por recepción de compra ${PURCHASE_RECEIPT_ID}`,
      );
    });

    it('descripción de reversión SUPPLIER_PAYMENT: usa sourceNumber (etiqueta del proveedor), nunca original.description', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce({
          ...makeOriginalWithLines(),
          sourceType: AccountingSourceType.SUPPLIER_PAYMENT,
          sourceId: SUPPLIER_PAYMENT_ID,
          description: 'Pago a proveedor Acme SAC',
        })
        .mockResolvedValueOnce(null);
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({
          sourceType: AccountingSourceType.SUPPLIER_PAYMENT,
          sourceId: SUPPLIER_PAYMENT_ID,
          sourceNumber: 'Acme SAC',
        }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { description: string };
      };
      expect(call.data.description).toBe(
        'Reversión de pago a proveedor Acme SAC',
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

  // ====================================================================
  // Fase A2 — periodos contables, fecha contable y numeración
  // ====================================================================
  describe('Fase A2 — periodos contables, fecha contable y numeración', () => {
    it('deriva accountingDate del postedAt en zona de negocio America/Lima, sin desfase', async () => {
      // POSTED_AT = 2026-03-15T12:00:00.000Z -> en Lima (UTC-5) sigue siendo 15 de marzo.
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: {
          accountingDate: Date;
          periodId: string;
          journalNumber: number;
        };
      };
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-03-15T00:00:00.000Z',
      );
      expect(call.data.periodId).toBe(PERIOD_ID);
      expect(call.data.journalNumber).toBe(1);
    });

    it('caso límite de medianoche: un postedAt poco después de medianoche UTC cae en el día ANTERIOR en Lima', async () => {
      // 2026-03-15T04:30:00Z -> Lima (UTC-5) = 2026-03-14T23:30:00, un día antes.
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand({ postedAt: new Date('2026-03-15T04:30:00.000Z') }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { accountingDate: Date };
      };
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-03-14T00:00:00.000Z',
      );
    });

    it('caso límite de transición de mes: 2026-04-01T04:00:00Z cae en el 31 de marzo en Lima', async () => {
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand({ postedAt: new Date('2026-04-01T04:00:00.000Z') }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { accountingDate: Date };
      };
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-03-31T00:00:00.000Z',
      );
    });

    it('periodo inexistente: lo crea vía INSERT ... ON CONFLICT y resuelve su id antes de numerar', async () => {
      tx.accountingPeriod.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({ id: PERIOD_ID });
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      expect(tx.$executeRaw).toHaveBeenCalledTimes(1);
      expect(tx.accountingPeriod.findUnique).toHaveBeenCalledTimes(2);
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { periodId: string };
      };
      expect(call.data.periodId).toBe(PERIOD_ID);
    });

    it('periodo CLOSED: el UPDATE...RETURNING condicionado a OPEN no devuelve fila -> ConflictException, nunca crea el asiento', async () => {
      tx.$queryRaw.mockResolvedValue([]);
      await expect(
        engine.postSaleRecognition(
          tx as unknown as Prisma.TransactionClient,
          makeSaleCommand(),
        ),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(tx.accountingEntry.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('numeración: usa exactamente el lastJournalNumber devuelto por el UPDATE...RETURNING', async () => {
      tx.$queryRaw.mockResolvedValue([{ lastJournalNumber: 7 }]);
      await engine.postSaleRecognition(
        tx as unknown as Prisma.TransactionClient,
        makeSaleCommand(),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { journalNumber: number };
      };
      expect(call.data.journalNumber).toBe(7);
    });

    it('reversal: usa la fecha contable de SU PROPIO postedAt, nunca la del asiento ORIGINAL (que puede caer en otro mes)', async () => {
      tx.accountingEntry.findFirst
        .mockResolvedValueOnce({
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
        })
        .mockResolvedValueOnce(null);
      // El original se posteó en marzo (POSTED_AT); la anulación ocurre en abril.
      const reversalPostedAt = new Date('2026-04-10T15:00:00.000Z');
      await engine.reverseOriginalForSource(
        tx as unknown as Prisma.TransactionClient,
        makeReverseCommand({ postedAt: reversalPostedAt }),
      );
      const call = tx.accountingEntry.create.mock.calls[0][0] as {
        data: { accountingDate: Date; postedAt: Date };
      };
      expect(call.data.postedAt).toBe(reversalPostedAt);
      expect(call.data.accountingDate.toISOString()).toBe(
        '2026-04-10T00:00:00.000Z',
      );
    });
  });
});
