import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertValidValuationQuantity,
  computeReceiptValuationCost,
  computeWeightedAverage,
} from './inventory-valuation-calculator';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('computeReceiptValuationCost', () => {
  it('recepción única que completa la línea: totalCost = monto elegible exacto', () => {
    const result = computeReceiptValuationCost(
      {
        taxableBaseAmount: d('100.00'),
        taxAmount: d('18.00'),
        creditableTaxAmount: d('18.00'),
      },
      d('10.000'),
      d('0'),
      d('10.000'),
      d('0'),
    );
    // eligibleAmount = 100 + (18-18) = 100.00
    expect(result.totalCost.toFixed(2)).toBe('100.00');
    expect(result.purchasePriceAmount.toFixed(2)).toBe('100.00');
    expect(result.nonCreditableTaxAmount.toFixed(2)).toBe('0.00');
    expect(result.unitCost.toFixed(6)).toBe('10.000000');
  });

  it('impuesto NO acreditable se capitaliza junto al precio de compra', () => {
    const result = computeReceiptValuationCost(
      {
        taxableBaseAmount: d('100.00'),
        taxAmount: d('18.00'),
        creditableTaxAmount: d('0.00'),
      },
      d('1.000'),
      d('0'),
      d('1.000'),
      d('0'),
    );
    // eligibleAmount = 100 + (18-0) = 118.00
    expect(result.totalCost.toFixed(2)).toBe('118.00');
    expect(
      result.purchasePriceAmount.plus(result.nonCreditableTaxAmount).toFixed(2),
    ).toBe('118.00');
    expect(result.purchasePriceAmount.toFixed(2)).toBe('100.00');
    expect(result.nonCreditableTaxAmount.toFixed(2)).toBe('18.00');
  });

  it('tres recepciones parciales (1+1+1 de 3, eligible=100.00): la suma capitalizada coincide exactamente, sin drift', () => {
    const line = {
      taxableBaseAmount: d('100.00'),
      taxAmount: d('0.00'),
      creditableTaxAmount: d('0.00'),
    };
    const invoicedQty = d('3.000');

    const r1 = computeReceiptValuationCost(
      line,
      invoicedQty,
      d('0'),
      d('1.000'),
      d('0'),
    );
    const r2 = computeReceiptValuationCost(
      line,
      invoicedQty,
      d('1.000'),
      d('1.000'),
      r1.totalCost,
    );
    const r3 = computeReceiptValuationCost(
      line,
      invoicedQty,
      d('2.000'),
      d('1.000'),
      r1.totalCost.plus(r2.totalCost),
    );

    const sum = r1.totalCost.plus(r2.totalCost).plus(r3.totalCost);
    expect(sum.toFixed(2)).toBe('100.00');
    // La última recepción (completa la línea) absorbe el residual exacto.
    expect(r3.totalCost.toFixed(2)).not.toBe('0.00');
  });

  it('línea sin monto elegible (eligibleAmount=0): totalCost=0, nunca negativo', () => {
    const result = computeReceiptValuationCost(
      {
        taxableBaseAmount: d('0.00'),
        taxAmount: d('0.00'),
        creditableTaxAmount: d('0.00'),
      },
      d('5.000'),
      d('0'),
      d('5.000'),
      d('0'),
    );
    expect(result.totalCost.toFixed(2)).toBe('0.00');
    expect(result.purchasePriceAmount.toFixed(2)).toBe('0.00');
    expect(result.nonCreditableTaxAmount.toFixed(2)).toBe('0.00');
  });
});

describe('computeWeightedAverage', () => {
  it('valuedQuantity > 0: promedio exacto', () => {
    expect(computeWeightedAverage(d('10.000'), d('100.00')).toFixed(6)).toBe(
      '10.000000',
    );
  });

  it('valuedQuantity <= 0: "0" (nunca división por cero)', () => {
    expect(computeWeightedAverage(d('0'), d('0')).toFixed(6)).toBe('0.000000');
    expect(computeWeightedAverage(d('-1'), d('100')).toFixed(6)).toBe(
      '0.000000',
    );
  });
});

describe('assertValidValuationQuantity', () => {
  it('cantidad positiva: no lanza', () => {
    expect(() => assertValidValuationQuantity(d('1.000'))).not.toThrow();
  });

  it('cantidad cero o negativa: InternalServerErrorException', () => {
    expect(() => assertValidValuationQuantity(d('0'))).toThrow(
      InternalServerErrorException,
    );
    expect(() => assertValidValuationQuantity(d('-1'))).toThrow(
      InternalServerErrorException,
    );
  });
});
