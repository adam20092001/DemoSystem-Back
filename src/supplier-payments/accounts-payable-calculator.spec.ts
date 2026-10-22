import { Prisma } from '@prisma/client';
import {
  calculateDaysOverdue,
  calculatePercentage,
  computeAgingBucket,
} from './accounts-payable-calculator';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('calculateDaysOverdue', () => {
  it('fecha futura: negativo', () => {
    expect(calculateDaysOverdue('2026-06-20', '2026-06-15')).toBe(-5);
  });

  it('misma fecha: 0', () => {
    expect(calculateDaysOverdue('2026-06-15', '2026-06-15')).toBe(0);
  });

  it('fecha pasada: positivo', () => {
    expect(calculateDaysOverdue('2026-05-15', '2026-06-15')).toBe(31);
  });
});

describe('computeAgingBucket', () => {
  const TODAY = '2026-06-15';

  it('dueDate null: NO_DUE_DATE, daysOverdue null (nunca vencida automáticamente)', () => {
    expect(computeAgingBucket(null, TODAY)).toEqual({
      bucket: 'NO_DUE_DATE',
      daysOverdue: null,
    });
  });

  it('vence en el futuro: NOT_OVERDUE, daysOverdue=0', () => {
    expect(computeAgingBucket('2026-06-20', TODAY)).toEqual({
      bucket: 'NOT_OVERDUE',
      daysOverdue: 0,
    });
  });

  it('vence exactamente hoy: NOT_OVERDUE (igualdad no es vencida)', () => {
    expect(computeAgingBucket('2026-06-15', TODAY)).toEqual({
      bucket: 'NOT_OVERDUE',
      daysOverdue: 0,
    });
  });

  it.each([
    ['2026-06-14', 1, 'OVERDUE_1_30'],
    ['2026-05-16', 30, 'OVERDUE_1_30'],
    ['2026-05-15', 31, 'OVERDUE_31_60'],
    ['2026-04-16', 60, 'OVERDUE_31_60'],
    ['2026-04-15', 61, 'OVERDUE_61_90'],
    ['2026-03-17', 90, 'OVERDUE_61_90'],
    ['2026-03-16', 91, 'OVERDUE_90_PLUS'],
  ])(
    'dueDate=%s (%i días vencida) -> %s',
    (dueDate, expectedDays, expectedBucket) => {
      const result = computeAgingBucket(dueDate, TODAY);
      expect(result.daysOverdue).toBe(expectedDays);
      expect(result.bucket).toBe(expectedBucket);
    },
  );
});

describe('calculatePercentage', () => {
  it('total > 0: porcentaje con 2 decimales', () => {
    expect(calculatePercentage(d('50.00'), d('150.00'))).toBe('33.33');
  });

  it('total = 0: "0.00" (nunca división por cero)', () => {
    expect(calculatePercentage(d('50.00'), d('0'))).toBe('0.00');
  });

  it('part = total: "100.00"', () => {
    expect(calculatePercentage(d('100.00'), d('100.00'))).toBe('100.00');
  });
});
