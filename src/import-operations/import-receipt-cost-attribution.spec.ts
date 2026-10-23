import { Prisma } from '@prisma/client';
import { computeCostAttributionSplit } from './import-receipt-cost-attribution';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('computeCostAttributionSplit', () => {
  it('recepción PARCIAL (30 de 100): nunca atribuye el gasto completo a las primeras unidades recibidas', () => {
    const result = computeCostAttributionSplit(
      [{ key: 'link-a', weight: d('30.000') }],
      d('100.000'),
      d('100.00'),
    );
    expect(result.perKey.get('link-a')?.toFixed(2)).toBe('30.00');
    expect(result.unattributedAmount.toFixed(2)).toBe('70.00');
  });

  it('recepción COMPLETA repartida en dos recibos: suma exacta, sin monto no atribuido', () => {
    const result = computeCostAttributionSplit(
      [
        { key: 'link-a', weight: d('30.000') },
        { key: 'link-b', weight: d('70.000') },
      ],
      d('100.000'),
      d('400.00'),
    );
    const sum = Array.from(result.perKey.values()).reduce(
      (s, v) => s.plus(v),
      new Prisma.Decimal(0),
    );
    expect(sum.toFixed(2)).toBe('400.00');
    expect(result.unattributedAmount.toFixed(2)).toBe('0.00');
  });

  it('sin ningún peso recibido: todo el monto queda unattributedAmount', () => {
    const result = computeCostAttributionSplit([], d('100.000'), d('250.00'));
    expect(result.perKey.size).toBe(0);
    expect(result.unattributedAmount.toFixed(2)).toBe('250.00');
  });

  it('tres recibos parciales (30+30+40=100): residual exacto, suma total exacta', () => {
    const result = computeCostAttributionSplit(
      [
        { key: 'r1', weight: d('30.000') },
        { key: 'r2', weight: d('30.000') },
        { key: 'r3', weight: d('40.000') },
      ],
      d('100.000'),
      d('10.00'),
    );
    const sum = Array.from(result.perKey.values()).reduce(
      (s, v) => s.plus(v),
      new Prisma.Decimal(0),
    );
    expect(sum.toFixed(2)).toBe('10.00');
    expect(result.unattributedAmount.toFixed(2)).toBe('0.00');
  });
});
