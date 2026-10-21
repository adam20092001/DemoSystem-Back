import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import {
  AccountingSystemKey,
  Prisma,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
} from '@prisma/client';
import {
  PURCHASE_PURPOSE_TO_SYSTEM_KEY,
  buildPurchaseRecognitionLines,
  calculatePurchaseInvoiceTotals,
  computePurchaseLineAmounts,
} from './purchase-invoice-calculator';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('PURCHASE_PURPOSE_TO_SYSTEM_KEY', () => {
  it('mapea 1:1 los 5 propósitos a un AccountingSystemKey PURCHASE_* distinto', () => {
    const values = Object.values(PURCHASE_PURPOSE_TO_SYSTEM_KEY);
    expect(new Set(values).size).toBe(values.length);
    expect(
      PURCHASE_PURPOSE_TO_SYSTEM_KEY[PurchasePurpose.RESALE_INVENTORY],
    ).toBe(AccountingSystemKey.PURCHASE_RESALE_INVENTORY);
    expect(PURCHASE_PURPOSE_TO_SYSTEM_KEY[PurchasePurpose.OTHER]).toBe(
      AccountingSystemKey.PURCHASE_OTHER,
    );
  });
});

describe('computePurchaseLineAmounts', () => {
  it('EXEMPT: sin impuesto, taxableBaseAmount=lineTotal=quantity*unitCost', () => {
    const result = computePurchaseLineAmounts({
      quantity: d('10'),
      unitCost: d('25.50'),
      taxCategory: PurchaseLineTaxCategory.EXEMPT,
      taxBasis: null,
      taxRate: null,
      creditableTaxAmount: d('0'),
    });
    expect(result.taxableBaseAmount.toFixed(2)).toBe('255.00');
    expect(result.taxAmount.toFixed(2)).toBe('0.00');
    expect(result.creditableTaxAmount.toFixed(2)).toBe('0.00');
    expect(result.lineTotal.toFixed(2)).toBe('255.00');
  });

  it('UNAFFECTED: idéntico tratamiento que EXEMPT (sin impuesto)', () => {
    const result = computePurchaseLineAmounts({
      quantity: d('2'),
      unitCost: d('50.00'),
      taxCategory: PurchaseLineTaxCategory.UNAFFECTED,
      taxBasis: null,
      taxRate: null,
      creditableTaxAmount: d('0'),
    });
    expect(result.taxAmount.toFixed(2)).toBe('0.00');
    expect(result.lineTotal.toFixed(2)).toBe('100.00');
  });

  it('TAXED + TAX_EXCLUDED: base=quantity*unitCost, taxAmount=base*tasa/100, lineTotal=base+tax', () => {
    const result = computePurchaseLineAmounts({
      quantity: d('10'),
      unitCost: d('100.00'),
      taxCategory: PurchaseLineTaxCategory.TAXED,
      taxBasis: PurchaseLineTaxBasis.TAX_EXCLUDED,
      taxRate: d('18'),
      creditableTaxAmount: d('180.00'),
    });
    expect(result.taxableBaseAmount.toFixed(2)).toBe('1000.00');
    expect(result.taxAmount.toFixed(2)).toBe('180.00');
    expect(result.lineTotal.toFixed(2)).toBe('1180.00');
    expect(result.creditableTaxAmount.toFixed(2)).toBe('180.00');
  });

  it('TAXED + TAX_INCLUDED: grossAmount YA incluye impuesto; taxAmount es residual (grossAmount - taxableBase)', () => {
    const result = computePurchaseLineAmounts({
      quantity: d('1'),
      unitCost: d('118.00'),
      taxCategory: PurchaseLineTaxCategory.TAXED,
      taxBasis: PurchaseLineTaxBasis.TAX_INCLUDED,
      taxRate: d('18'),
      creditableTaxAmount: d('18.00'),
    });
    expect(result.lineTotal.toFixed(2)).toBe('118.00');
    expect(result.taxableBaseAmount.plus(result.taxAmount).toFixed(2)).toBe(
      '118.00',
    );
    expect(result.taxAmount.toFixed(2)).toBe('18.00');
  });

  it('creditableTaxAmount > taxAmount de la línea: BadRequestException', () => {
    expect(() =>
      computePurchaseLineAmounts({
        quantity: d('10'),
        unitCost: d('100.00'),
        taxCategory: PurchaseLineTaxCategory.TAXED,
        taxBasis: PurchaseLineTaxBasis.TAX_EXCLUDED,
        taxRate: d('18'),
        creditableTaxAmount: d('181.00'),
      }),
    ).toThrow(BadRequestException);
  });

  it('TAXED sin taxBasis/taxRate: BadRequestException', () => {
    expect(() =>
      computePurchaseLineAmounts({
        quantity: d('10'),
        unitCost: d('100.00'),
        taxCategory: PurchaseLineTaxCategory.TAXED,
        taxBasis: null,
        taxRate: null,
        creditableTaxAmount: d('0'),
      }),
    ).toThrow(BadRequestException);
  });

  it('tasa fuera de [0,100]: InternalServerErrorException (invariante de CompanySettings roto, nunca error de usuario)', () => {
    expect(() =>
      computePurchaseLineAmounts({
        quantity: d('10'),
        unitCost: d('100.00'),
        taxCategory: PurchaseLineTaxCategory.TAXED,
        taxBasis: PurchaseLineTaxBasis.TAX_EXCLUDED,
        taxRate: d('150'),
        creditableTaxAmount: d('0'),
      }),
    ).toThrow(InternalServerErrorException);
  });

  it('quantity cero o negativa: BadRequestException', () => {
    expect(() =>
      computePurchaseLineAmounts({
        quantity: d('0'),
        unitCost: d('100.00'),
        taxCategory: PurchaseLineTaxCategory.EXEMPT,
        taxBasis: null,
        taxRate: null,
        creditableTaxAmount: d('0'),
      }),
    ).toThrow(BadRequestException);
  });

  it('unitCost negativo: BadRequestException', () => {
    expect(() =>
      computePurchaseLineAmounts({
        quantity: d('1'),
        unitCost: d('-1.00'),
        taxCategory: PurchaseLineTaxCategory.EXEMPT,
        taxBasis: null,
        taxRate: null,
        creditableTaxAmount: d('0'),
      }),
    ).toThrow(BadRequestException);
  });
});

describe('calculatePurchaseInvoiceTotals', () => {
  it('suma subtotal/taxAmount/totalAmount de líneas con tratamientos tributarios mixtos', () => {
    const totals = calculatePurchaseInvoiceTotals([
      {
        taxableBaseAmount: d('100.00'),
        taxAmount: d('18.00'),
        lineTotal: d('118.00'),
      },
      {
        taxableBaseAmount: d('50.00'),
        taxAmount: d('0.00'),
        lineTotal: d('50.00'),
      },
    ]);
    expect(totals.subtotal.toFixed(2)).toBe('150.00');
    expect(totals.taxAmount.toFixed(2)).toBe('18.00');
    expect(totals.totalAmount.toFixed(2)).toBe('168.00');
  });

  it('lista vacía -> todos los totales en cero', () => {
    const totals = calculatePurchaseInvoiceTotals([]);
    expect(totals.subtotal.toFixed(2)).toBe('0.00');
    expect(totals.totalAmount.toFixed(2)).toBe('0.00');
  });
});

describe('buildPurchaseRecognitionLines', () => {
  it('una línea TAXED+TAX_EXCLUDED totalmente creditable: destino + VAT_RECEIVABLE + ACCOUNTS_PAYABLE, cuadrado', () => {
    const lines = buildPurchaseRecognitionLines([
      {
        purchasePurpose: PurchasePurpose.RESALE_INVENTORY,
        taxableBaseAmount: d('100.00'),
        taxAmount: d('18.00'),
        creditableTaxAmount: d('18.00'),
      },
    ]);
    const byKey = new Map(lines.map((l) => [l.systemKey, l]));
    expect(byKey.get(AccountingSystemKey.PURCHASE_RESALE_INVENTORY)).toEqual({
      systemKey: AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
      debitAmount: d('100.00'),
      creditAmount: d('0'),
    });
    expect(byKey.get(AccountingSystemKey.VAT_RECEIVABLE)).toEqual({
      systemKey: AccountingSystemKey.VAT_RECEIVABLE,
      debitAmount: d('18.00'),
      creditAmount: d('0'),
    });
    expect(byKey.get(AccountingSystemKey.ACCOUNTS_PAYABLE)).toEqual({
      systemKey: AccountingSystemKey.ACCOUNTS_PAYABLE,
      debitAmount: d('0'),
      creditAmount: d('118.00'),
    });
    const totalDebit = lines.reduce(
      (sum, l) => sum.plus(l.debitAmount),
      d('0'),
    );
    const totalCredit = lines.reduce(
      (sum, l) => sum.plus(l.creditAmount),
      d('0'),
    );
    expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));
  });

  it('impuesto NO creditable se absorbe en el destino (nunca se postea como pérdida separada ni se descarta)', () => {
    const lines = buildPurchaseRecognitionLines([
      {
        purchasePurpose: PurchasePurpose.OPERATING_EXPENSE,
        taxableBaseAmount: d('100.00'),
        taxAmount: d('18.00'),
        creditableTaxAmount: d('0.00'),
      },
    ]);
    const byKey = new Map(lines.map((l) => [l.systemKey, l]));
    expect(
      byKey
        .get(AccountingSystemKey.PURCHASE_OPERATING_EXPENSE)
        ?.debitAmount.toFixed(2),
    ).toBe('118.00');
    expect(byKey.has(AccountingSystemKey.VAT_RECEIVABLE)).toBe(false);
    expect(byKey.get(AccountingSystemKey.ACCOUNTS_PAYABLE)).toEqual({
      systemKey: AccountingSystemKey.ACCOUNTS_PAYABLE,
      debitAmount: d('0'),
      creditAmount: d('118.00'),
    });
  });

  it('agrupa varias líneas con el mismo purchasePurpose en un solo debit de destino', () => {
    const lines = buildPurchaseRecognitionLines([
      {
        purchasePurpose: PurchasePurpose.RESALE_INVENTORY,
        taxableBaseAmount: d('100.00'),
        taxAmount: d('0'),
        creditableTaxAmount: d('0'),
      },
      {
        purchasePurpose: PurchasePurpose.RESALE_INVENTORY,
        taxableBaseAmount: d('50.00'),
        taxAmount: d('0'),
        creditableTaxAmount: d('0'),
      },
    ]);
    const resaleLines = lines.filter(
      (l) => l.systemKey === AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
    );
    expect(resaleLines).toHaveLength(1);
    expect(resaleLines[0].debitAmount.toFixed(2)).toBe('150.00');
  });

  it('mezcla de propósitos distintos: una línea de destino por cada purchasePurpose presente', () => {
    const lines = buildPurchaseRecognitionLines([
      {
        purchasePurpose: PurchasePurpose.RESALE_INVENTORY,
        taxableBaseAmount: d('100.00'),
        taxAmount: d('0'),
        creditableTaxAmount: d('0'),
      },
      {
        purchasePurpose: PurchasePurpose.FIXED_ASSET,
        taxableBaseAmount: d('500.00'),
        taxAmount: d('0'),
        creditableTaxAmount: d('0'),
      },
    ]);
    const byKey = new Map(lines.map((l) => [l.systemKey, l]));
    expect(byKey.has(AccountingSystemKey.PURCHASE_RESALE_INVENTORY)).toBe(true);
    expect(byKey.has(AccountingSystemKey.PURCHASE_FIXED_ASSET)).toBe(true);
  });

  it('lista vacía: InternalServerErrorException (el servicio ya debió rechazar esto con 400 antes)', () => {
    expect(() => buildPurchaseRecognitionLines([])).toThrow(
      InternalServerErrorException,
    );
  });

  it('totalPayable <= 0: InternalServerErrorException', () => {
    expect(() =>
      buildPurchaseRecognitionLines([
        {
          purchasePurpose: PurchasePurpose.OTHER,
          taxableBaseAmount: d('0'),
          taxAmount: d('0'),
          creditableTaxAmount: d('0'),
        },
      ]),
    ).toThrow(InternalServerErrorException);
  });
});
