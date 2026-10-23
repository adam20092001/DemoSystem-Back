import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertValidDistributionBase,
  computeProportionalAllocation,
} from './import-expense-allocation-calculator';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('computeProportionalAllocation', () => {
  it('reparte proporcionalmente y la suma coincide EXACTAMENTE con el total (sin drift)', () => {
    const targets = [
      { importShipmentLineId: 'line-1', weight: d('10.000') },
      { importShipmentLineId: 'line-2', weight: d('20.000') },
      { importShipmentLineId: 'line-3', weight: d('30.000') },
    ];
    const result = computeProportionalAllocation(targets, d('100.00'));
    const sum = result.reduce(
      (s, l) => s.plus(l.amount),
      new Prisma.Decimal(0),
    );
    expect(sum.toFixed(2)).toBe('100.00');
    expect(result[0].amount.toFixed(2)).toBe('16.67');
    expect(result[1].amount.toFixed(2)).toBe('33.33');
    // El residual exacto cae en el ÚLTIMO target (100 - 16.67 - 33.33 = 50.00).
    expect(result[2].amount.toFixed(2)).toBe('50.00');
  });

  it('un solo target absorbe el monto completo', () => {
    const result = computeProportionalAllocation(
      [{ importShipmentLineId: 'line-1', weight: d('5.000') }],
      d('250.00'),
    );
    expect(result).toHaveLength(1);
    expect(result[0].amount.toFixed(2)).toBe('250.00');
  });

  it('un target con weight=0 recibe exactamente 0 (si no es el último)', () => {
    const result = computeProportionalAllocation(
      [
        { importShipmentLineId: 'line-1', weight: d('0') },
        { importShipmentLineId: 'line-2', weight: d('10.000') },
      ],
      d('100.00'),
    );
    expect(result[0].amount.toFixed(2)).toBe('0.00');
    expect(result[1].amount.toFixed(2)).toBe('100.00');
  });

  it('centavos fraccionarios: el residual nunca excede el total ni queda por debajo', () => {
    const targets = [
      { importShipmentLineId: 'a', weight: d('1.000') },
      { importShipmentLineId: 'b', weight: d('1.000') },
      { importShipmentLineId: 'c', weight: d('1.000') },
    ];
    const result = computeProportionalAllocation(targets, d('10.00'));
    const sum = result.reduce(
      (s, l) => s.plus(l.amount),
      new Prisma.Decimal(0),
    );
    expect(sum.toFixed(2)).toBe('10.00');
    // 10/3 = 3.333... -> HALF_UP a 3.33 para los dos primeros, residual en el tercero.
    expect(result[0].amount.toFixed(2)).toBe('3.33');
    expect(result[1].amount.toFixed(2)).toBe('3.33');
    expect(result[2].amount.toFixed(2)).toBe('3.34');
  });
});

describe('assertValidDistributionBase', () => {
  it('base positiva: no lanza', () => {
    expect(() => assertValidDistributionBase(d('1.000'))).not.toThrow();
  });

  it('base cero o negativa: BadRequestException', () => {
    expect(() => assertValidDistributionBase(d('0'))).toThrow(
      BadRequestException,
    );
    expect(() => assertValidDistributionBase(d('-1'))).toThrow(
      BadRequestException,
    );
  });
});
