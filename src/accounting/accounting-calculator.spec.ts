import { InternalServerErrorException } from '@nestjs/common';
import {
  AccountingSystemKey,
  PaymentMethodAccountingDestination,
  Prisma,
} from '@prisma/client';
import {
  assertLinesBalanced,
  assertValidAccountingDescription,
  buildPaymentCollectionLines,
  buildPaymentOriginalDescription,
  buildPaymentReversalDescription,
  buildSaleOriginalDescription,
  buildSaleRecognitionLines,
  buildSaleReversalDescription,
  hasSaleEconomicActivity,
  invertResolvedLines,
} from './accounting-calculator';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('hasSaleEconomicActivity', () => {
  it('los cuatro montos en cero -> false (sin actividad económica)', () => {
    expect(hasSaleEconomicActivity(d('0'), d('0'), d('0'), d('0'))).toBe(false);
  });

  it('venta normal (subtotal=total=100) -> true', () => {
    expect(hasSaleEconomicActivity(d('100'), d('0'), d('0'), d('100'))).toBe(
      true,
    );
  });

  it('descuento total (subtotal=100, discount=100, total=0) -> true (HAY actividad, total=0 no es sinónimo de sin actividad)', () => {
    expect(hasSaleEconomicActivity(d('100'), d('100'), d('0'), d('0'))).toBe(
      true,
    );
  });

  it('solo IGV positivo -> true', () => {
    expect(hasSaleEconomicActivity(d('0'), d('0'), d('18'), d('18'))).toBe(
      true,
    );
  });
});

describe('buildSaleRecognitionLines', () => {
  it('A. 100/0/0/100: DEBIT AR 100, CREDIT SALES 100 (2 líneas, sin cero)', () => {
    const lines = buildSaleRecognitionLines(d('100'), d('0'), d('0'), d('100'));
    expect(lines).toHaveLength(2);
    expect(lines).toEqual([
      {
        systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
        debitAmount: d('100'),
        creditAmount: d('0'),
      },
      {
        systemKey: AccountingSystemKey.SALES_REVENUE,
        debitAmount: d('0'),
        creditAmount: d('100'),
      },
    ]);
  });

  it('B. 100/10/0/90: DEBIT AR 90, DEBIT DISCOUNTS 10, CREDIT SALES 100', () => {
    const lines = buildSaleRecognitionLines(d('100'), d('10'), d('0'), d('90'));
    expect(lines).toHaveLength(3);
    const bySystemKey = new Map(lines.map((l) => [l.systemKey, l]));
    expect(bySystemKey.get(AccountingSystemKey.ACCOUNTS_RECEIVABLE)).toEqual({
      systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
      debitAmount: d('90'),
      creditAmount: d('0'),
    });
    expect(bySystemKey.get(AccountingSystemKey.DISCOUNTS)).toEqual({
      systemKey: AccountingSystemKey.DISCOUNTS,
      debitAmount: d('10'),
      creditAmount: d('0'),
    });
    expect(bySystemKey.get(AccountingSystemKey.SALES_REVENUE)).toEqual({
      systemKey: AccountingSystemKey.SALES_REVENUE,
      debitAmount: d('0'),
      creditAmount: d('100'),
    });
  });

  it('C. 100/10/18/108: DEBIT AR 108, DEBIT DISCOUNTS 10, CREDIT SALES 100, CREDIT VAT 18', () => {
    const lines = buildSaleRecognitionLines(
      d('100'),
      d('10'),
      d('18'),
      d('108'),
    );
    expect(lines).toHaveLength(4);
    const bySystemKey = new Map(lines.map((l) => [l.systemKey, l]));
    expect(
      bySystemKey
        .get(AccountingSystemKey.ACCOUNTS_RECEIVABLE)
        ?.debitAmount.toFixed(2),
    ).toBe('108.00');
    expect(
      bySystemKey.get(AccountingSystemKey.DISCOUNTS)?.debitAmount.toFixed(2),
    ).toBe('10.00');
    expect(
      bySystemKey
        .get(AccountingSystemKey.SALES_REVENUE)
        ?.creditAmount.toFixed(2),
    ).toBe('100.00');
    expect(
      bySystemKey.get(AccountingSystemKey.VAT_PAYABLE)?.creditAmount.toFixed(2),
    ).toBe('18.00');
    const totalDebit = lines.reduce(
      (acc, l) => acc.plus(l.debitAmount),
      d('0'),
    );
    const totalCredit = lines.reduce(
      (acc, l) => acc.plus(l.creditAmount),
      d('0'),
    );
    expect(totalDebit.equals(totalCredit)).toBe(true);
  });

  it('D. 100/100/0/0 (descuento total): DEBIT DISCOUNTS 100, CREDIT SALES 100 — SIN línea AR', () => {
    const lines = buildSaleRecognitionLines(d('100'), d('100'), d('0'), d('0'));
    expect(lines).toHaveLength(2);
    expect(
      lines.some(
        (l) => l.systemKey === AccountingSystemKey.ACCOUNTS_RECEIVABLE,
      ),
    ).toBe(false);
    const bySystemKey = new Map(lines.map((l) => [l.systemKey, l]));
    expect(
      bySystemKey.get(AccountingSystemKey.DISCOUNTS)?.debitAmount.toFixed(2),
    ).toBe('100.00');
    expect(
      bySystemKey
        .get(AccountingSystemKey.SALES_REVENUE)
        ?.creditAmount.toFixed(2),
    ).toBe('100.00');
  });

  it('E. 0/0/0/0: sin líneas (el llamador nunca debería invocar con esto, pero la función es defensiva)', () => {
    const lines = buildSaleRecognitionLines(d('0'), d('0'), d('0'), d('0'));
    expect(lines).toEqual([]);
  });

  it('ninguna línea tiene monto cero explícito en el lado "activo": el lado inactivo siempre es exactamente 0, nunca ambos > 0', () => {
    const lines = buildSaleRecognitionLines(
      d('100'),
      d('10'),
      d('18'),
      d('108'),
    );
    for (const line of lines) {
      const debitPositive = line.debitAmount.greaterThan(0);
      const creditPositive = line.creditAmount.greaterThan(0);
      expect(debitPositive).not.toBe(creditPositive);
    }
  });
});

describe('buildPaymentCollectionLines (Ticket C, Bloque C3: accountingDestination YA resuelto, no PaymentMethod)', () => {
  it.each([
    [PaymentMethodAccountingDestination.CASH, AccountingSystemKey.CASH],
    [PaymentMethodAccountingDestination.BANK, AccountingSystemKey.BANK],
  ])(
    '%s -> cuenta de cobro %s; DEBIT cobro / CREDIT AR por el mismo monto',
    (accountingDestination, expectedKey) => {
      const lines = buildPaymentCollectionLines(
        accountingDestination,
        d('40.00'),
      );
      expect(lines).toHaveLength(2);
      expect(lines[0]).toEqual({
        systemKey: expectedKey,
        debitAmount: d('40.00'),
        creditAmount: d('0'),
      });
      expect(lines[1]).toEqual({
        systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
        debitAmount: d('0'),
        creditAmount: d('40.00'),
      });
    },
  );

  it('el mapeo cubre exhaustivamente los 2 valores de PaymentMethodAccountingDestination (ningún valor produce systemKey undefined)', () => {
    for (const destination of Object.values(
      PaymentMethodAccountingDestination,
    )) {
      const lines = buildPaymentCollectionLines(destination, d('1.00'));
      expect(lines[0].systemKey).toBeDefined();
    }
  });
});

describe('invertResolvedLines', () => {
  it('invierte debit<->credit manteniendo el mismo accountId', () => {
    const original = [
      { accountId: 'acc-ar', debitAmount: d('100'), creditAmount: d('0') },
      { accountId: 'acc-sales', debitAmount: d('0'), creditAmount: d('100') },
    ];
    const inverted = invertResolvedLines(original);
    expect(inverted).toEqual([
      { accountId: 'acc-ar', debitAmount: d('0'), creditAmount: d('100') },
      { accountId: 'acc-sales', debitAmount: d('100'), creditAmount: d('0') },
    ]);
  });
});

describe('assertLinesBalanced', () => {
  it('dos líneas balanceadas: no lanza, retorna totales', () => {
    const result = assertLinesBalanced([
      { debitAmount: d('100'), creditAmount: d('0') },
      { debitAmount: d('0'), creditAmount: d('100') },
    ]);
    expect(result.totalDebit.toFixed(2)).toBe('100.00');
    expect(result.totalCredit.toFixed(2)).toBe('100.00');
  });

  it('tres/cuatro líneas balanceadas: no lanza', () => {
    expect(() =>
      assertLinesBalanced([
        { debitAmount: d('90'), creditAmount: d('0') },
        { debitAmount: d('10'), creditAmount: d('0') },
        { debitAmount: d('0'), creditAmount: d('100') },
      ]),
    ).not.toThrow();
    expect(() =>
      assertLinesBalanced([
        { debitAmount: d('108'), creditAmount: d('0') },
        { debitAmount: d('10'), creditAmount: d('0') },
        { debitAmount: d('0'), creditAmount: d('100') },
        { debitAmount: d('0'), creditAmount: d('18') },
      ]),
    ).not.toThrow();
  });

  it('arreglo vacío -> error interno', () => {
    expect(() => assertLinesBalanced([])).toThrow(InternalServerErrorException);
  });

  it('una sola línea -> error interno (mínimo 2)', () => {
    expect(() =>
      assertLinesBalanced([{ debitAmount: d('100'), creditAmount: d('0') }]),
    ).toThrow(InternalServerErrorException);
  });

  it('línea 0/0 -> error interno', () => {
    expect(() =>
      assertLinesBalanced([
        { debitAmount: d('0'), creditAmount: d('0') },
        { debitAmount: d('100'), creditAmount: d('0') },
      ]),
    ).toThrow(InternalServerErrorException);
  });

  it('línea con ambos lados positivos -> error interno', () => {
    expect(() =>
      assertLinesBalanced([
        { debitAmount: d('50'), creditAmount: d('50') },
        { debitAmount: d('0'), creditAmount: d('0') },
      ]),
    ).toThrow(InternalServerErrorException);
  });

  it('totales desbalanceados (debit 100 / credit 90) -> error interno', () => {
    expect(() =>
      assertLinesBalanced([
        { debitAmount: d('100'), creditAmount: d('0') },
        { debitAmount: d('0'), creditAmount: d('90') },
      ]),
    ).toThrow(InternalServerErrorException);
  });

  it('monto negativo -> error interno', () => {
    expect(() =>
      assertLinesBalanced([
        { debitAmount: d('-10'), creditAmount: d('0') },
        { debitAmount: d('0'), creditAmount: d('-10') },
      ]),
    ).toThrow(InternalServerErrorException);
  });

  it('precisión Decimal: 33.33 + 33.33 + 33.34 = 100.00 exacto, sin binario', () => {
    expect(() =>
      assertLinesBalanced([
        { debitAmount: d('33.33'), creditAmount: d('0') },
        { debitAmount: d('33.33'), creditAmount: d('0') },
        { debitAmount: d('33.34'), creditAmount: d('0') },
        { debitAmount: d('0'), creditAmount: d('100.00') },
      ]),
    ).not.toThrow();
  });
});

describe('descripciones de asiento', () => {
  it('plantillas exactas', () => {
    expect(buildSaleOriginalDescription('NV-000001')).toBe('Venta NV-000001');
    expect(buildPaymentOriginalDescription('NV-000001')).toBe(
      'Cobro de venta NV-000001',
    );
    expect(buildSaleReversalDescription('NV-000001')).toBe(
      'Reversión de venta NV-000001',
    );
    expect(buildPaymentReversalDescription('NV-000001')).toBe(
      'Reversión de cobro de venta NV-000001',
    );
  });

  it('assertValidAccountingDescription: vacía o solo espacios -> error interno', () => {
    expect(() => assertValidAccountingDescription('')).toThrow(
      InternalServerErrorException,
    );
    expect(() => assertValidAccountingDescription('   ')).toThrow(
      InternalServerErrorException,
    );
  });

  it('assertValidAccountingDescription: > 200 caracteres -> error interno', () => {
    expect(() => assertValidAccountingDescription('x'.repeat(201))).toThrow(
      InternalServerErrorException,
    );
  });

  it('assertValidAccountingDescription: válida -> no lanza', () => {
    expect(() =>
      assertValidAccountingDescription('Venta NV-000001'),
    ).not.toThrow();
  });
});
