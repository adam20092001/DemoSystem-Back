import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertValidReceiptQuantity,
  computeLineDestinationAmount,
  computeProportionalReclassificationAmount,
} from './purchase-receipt-calculator';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('assertValidReceiptQuantity', () => {
  it('acepta un decimal positivo con hasta 3 decimales', () => {
    expect(() => assertValidReceiptQuantity(d('4.500'))).not.toThrow();
  });

  it('rechaza cero', () => {
    expect(() => assertValidReceiptQuantity(d('0'))).toThrow(
      BadRequestException,
    );
  });

  it('rechaza negativos', () => {
    expect(() => assertValidReceiptQuantity(d('-1'))).toThrow(
      BadRequestException,
    );
  });

  it('rechaza más de 3 decimales', () => {
    expect(() => assertValidReceiptQuantity(d('1.2345'))).toThrow(
      BadRequestException,
    );
  });
});

describe('computeLineDestinationAmount', () => {
  it('base + (tax - creditable): totalmente creditable deja solo la base', () => {
    const amount = computeLineDestinationAmount({
      taxableBaseAmount: d('100.00'),
      taxAmount: d('18.00'),
      creditableTaxAmount: d('18.00'),
    });
    expect(amount.toFixed(2)).toBe('100.00');
  });

  it('sin crédito declarado: el impuesto completo se absorbe en el destino', () => {
    const amount = computeLineDestinationAmount({
      taxableBaseAmount: d('100.00'),
      taxAmount: d('18.00'),
      creditableTaxAmount: d('0.00'),
    });
    expect(amount.toFixed(2)).toBe('118.00');
  });

  it('EXEMPT/UNAFFECTED (taxAmount=creditableTaxAmount=0): destino = base', () => {
    const amount = computeLineDestinationAmount({
      taxableBaseAmount: d('50.00'),
      taxAmount: d('0.00'),
      creditableTaxAmount: d('0.00'),
    });
    expect(amount.toFixed(2)).toBe('50.00');
  });
});

describe('computeProportionalReclassificationAmount', () => {
  it('recepción completa (receivedQuantity === invoicedQuantity): el monto completo', () => {
    const amount = computeProportionalReclassificationAmount(
      d('100.00'),
      d('10'),
      d('10'),
    );
    expect(amount.toFixed(2)).toBe('100.00');
  });

  it('recepción parcial 4 de 10: 40% del destino', () => {
    const amount = computeProportionalReclassificationAmount(
      d('100.00'),
      d('4'),
      d('10'),
    );
    expect(amount.toFixed(2)).toBe('40.00');
  });

  it('4 + 6 de 10 suma exactamente el destino total (sin drift en este caso exacto)', () => {
    const first = computeProportionalReclassificationAmount(
      d('100.00'),
      d('4'),
      d('10'),
    );
    const second = computeProportionalReclassificationAmount(
      d('100.00'),
      d('6'),
      d('10'),
    );
    expect(first.plus(second).toFixed(2)).toBe('100.00');
  });

  it('destinationAmount=0: resultado 0 sin dividir', () => {
    const amount = computeProportionalReclassificationAmount(
      d('0'),
      d('4'),
      d('10'),
    );
    expect(amount.toFixed(2)).toBe('0.00');
  });

  it('invoicedQuantity<=0: BadRequestException', () => {
    expect(() =>
      computeProportionalReclassificationAmount(d('100.00'), d('4'), d('0')),
    ).toThrow(BadRequestException);
  });

  it('redondeo HALF_UP en una división no exacta', () => {
    // 100 * 1 / 3 = 33.333... -> 33.33 (HALF_UP a 2 decimales)
    const amount = computeProportionalReclassificationAmount(
      d('100.00'),
      d('1'),
      d('3'),
    );
    expect(amount.toFixed(2)).toBe('33.33');
  });
});
