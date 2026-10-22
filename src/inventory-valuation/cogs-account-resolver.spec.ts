import { Prisma, PurchasePurpose } from '@prisma/client';
import { resolveHistoricalInventoryAccountForProduct } from './cogs-account-resolver';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const RESALE_ACCOUNT_ID = 'acc-resale';
const OPEX_ACCOUNT_ID = 'acc-opex';
const TARGET_ACCOUNT_ID = 'acc-target';
const POSTED_ENTRY_ID = 'entry-purchase-1';
const RECLASSIFICATION_ENTRY_ID = 'entry-reclass-1';

function makeLayer(
  overrides: Partial<{
    purchasePurpose: PurchasePurpose;
    postedEntryId: string | null;
    reclassificationEntryId: string | null;
    reclassifiedAmount: Prisma.Decimal | null;
  }> = {},
) {
  const {
    purchasePurpose = PurchasePurpose.RESALE_INVENTORY,
    postedEntryId = POSTED_ENTRY_ID,
    reclassificationEntryId = null,
    reclassifiedAmount = null,
  } = overrides;
  return {
    purchaseReceiptLine: {
      reclassifiedAmount,
      purchaseReceipt: { reclassificationEntryId },
      purchaseInvoiceLine: {
        purchasePurpose,
        purchaseInvoice: { postedEntryId },
      },
    },
  };
}

function createTxMock() {
  return {
    inventoryValuation: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    account: {
      findFirst: jest.fn<Promise<unknown>, [unknown]>(),
    },
    accountingEntryLine: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
  };
}

describe('resolveHistoricalInventoryAccountForProduct (Fase A6.2)', () => {
  let tx: ReturnType<typeof createTxMock>;

  beforeEach(() => {
    tx = createTxMock();
    tx.account.findFirst.mockResolvedValue({
      id: RESALE_ACCOUNT_ID,
      receiptReclassificationTargetAccountId: null,
    });
    tx.accountingEntryLine.findMany.mockResolvedValue([
      { accountId: RESALE_ACCOUNT_ID },
    ]);
  });

  it('sin ninguna capa activa (sin historial de valorización todavía): null, nunca adivina', async () => {
    tx.inventoryValuation.findMany.mockResolvedValue([]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toBeNull();
  });

  it('capa única RESALE_INVENTORY, verificada contra el asiento PURCHASE real: resuelve la cuenta', async () => {
    tx.inventoryValuation.findMany.mockResolvedValue([makeLayer()]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toEqual({ accountId: RESALE_ACCOUNT_ID });
  });

  it('capa con propósito distinto de RESALE_INVENTORY (reconocida como gasto): null, nunca un segundo gasto COGS', async () => {
    tx.inventoryValuation.findMany.mockResolvedValue([
      makeLayer({ purchasePurpose: PurchasePurpose.OPERATING_EXPENSE }),
    ]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toBeNull();
  });

  it('el mapeo vigente de PURCHASE_RESALE_INVENTORY cambió desde que la factura se confirmó: null', async () => {
    tx.inventoryValuation.findMany.mockResolvedValue([makeLayer()]);
    tx.accountingEntryLine.findMany.mockResolvedValue([
      { accountId: OPEX_ACCOUNT_ID },
    ]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toBeNull();
  });

  it('sin cuenta mapeada todavía al systemKey PURCHASE_RESALE_INVENTORY: null', async () => {
    tx.account.findFirst.mockResolvedValue(null);
    tx.inventoryValuation.findMany.mockResolvedValue([makeLayer()]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toBeNull();
  });

  it('capa reclasificada, verificada contra el asiento de reclasificación real: resuelve la cuenta DESTINO', async () => {
    tx.account.findFirst.mockResolvedValue({
      id: RESALE_ACCOUNT_ID,
      receiptReclassificationTargetAccountId: TARGET_ACCOUNT_ID,
    });
    tx.inventoryValuation.findMany.mockResolvedValue([
      makeLayer({
        reclassificationEntryId: RECLASSIFICATION_ENTRY_ID,
        reclassifiedAmount: new Prisma.Decimal('100.00'),
      }),
    ]);
    tx.accountingEntryLine.findMany
      .mockResolvedValueOnce([{ accountId: RESALE_ACCOUNT_ID }]) // asiento PURCHASE original
      .mockResolvedValueOnce([{ accountId: TARGET_ACCOUNT_ID }]); // asiento de reclasificación
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toEqual({ accountId: TARGET_ACCOUNT_ID });
  });

  it('capa reclasificada pero la cuenta destino no aparece en el asiento de reclasificación real: null', async () => {
    tx.account.findFirst.mockResolvedValue({
      id: RESALE_ACCOUNT_ID,
      receiptReclassificationTargetAccountId: TARGET_ACCOUNT_ID,
    });
    tx.inventoryValuation.findMany.mockResolvedValue([
      makeLayer({
        reclassificationEntryId: RECLASSIFICATION_ENTRY_ID,
        reclassifiedAmount: new Prisma.Decimal('100.00'),
      }),
    ]);
    tx.accountingEntryLine.findMany
      .mockResolvedValueOnce([{ accountId: RESALE_ACCOUNT_ID }])
      .mockResolvedValueOnce([{ accountId: 'otra-cuenta' }]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toBeNull();
  });

  it('dos capas activas que resuelven a la MISMA cuenta: resuelve esa única cuenta', async () => {
    tx.inventoryValuation.findMany.mockResolvedValue([
      makeLayer(),
      makeLayer({ postedEntryId: 'entry-purchase-2' }),
    ]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toEqual({ accountId: RESALE_ACCOUNT_ID });
  });

  it('dos capas activas que resuelven a cuentas DISTINTAS: null — no basta con encontrar dos cuentas configuradas', async () => {
    tx.account.findFirst.mockResolvedValue({
      id: RESALE_ACCOUNT_ID,
      receiptReclassificationTargetAccountId: TARGET_ACCOUNT_ID,
    });
    tx.accountingEntryLine.findMany
      .mockResolvedValueOnce([{ accountId: RESALE_ACCOUNT_ID }]) // capa 1: sin reclasificar -> RESALE_ACCOUNT_ID
      .mockResolvedValueOnce([{ accountId: RESALE_ACCOUNT_ID }]) // capa 2: asiento PURCHASE
      .mockResolvedValueOnce([{ accountId: TARGET_ACCOUNT_ID }]); // capa 2: reclasificada -> TARGET_ACCOUNT_ID
    tx.inventoryValuation.findMany.mockResolvedValue([
      makeLayer(),
      makeLayer({
        postedEntryId: 'entry-purchase-2',
        reclassificationEntryId: RECLASSIFICATION_ENTRY_ID,
        reclassifiedAmount: new Prisma.Decimal('50.00'),
      }),
    ]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toBeNull();
  });

  it('factura sin postedEntryId (nunca contabilizada): null', async () => {
    tx.inventoryValuation.findMany.mockResolvedValue([
      makeLayer({ postedEntryId: null }),
    ]);
    const result = await resolveHistoricalInventoryAccountForProduct(
      tx as unknown as Prisma.TransactionClient,
      PRODUCT_ID,
    );
    expect(result).toBeNull();
  });
});
