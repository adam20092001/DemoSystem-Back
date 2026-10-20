import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertValidAccountingDateRange,
  signedNaturalBalance,
  splitNetBalance,
} from './accounting-reports.utils';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('assertValidAccountingDateRange', () => {
  it('rango válido: no lanza', () => {
    expect(() =>
      assertValidAccountingDateRange('2026-03-01', '2026-03-31'),
    ).not.toThrow();
  });

  it('from == to: válido (un solo día)', () => {
    expect(() =>
      assertValidAccountingDateRange('2026-03-01', '2026-03-01'),
    ).not.toThrow();
  });

  it('from > to: BadRequestException', () => {
    expect(() =>
      assertValidAccountingDateRange('2026-03-31', '2026-03-01'),
    ).toThrow(BadRequestException);
  });

  it('from con formato inválido: BadRequestException', () => {
    expect(() =>
      assertValidAccountingDateRange('2026-02-30', '2026-03-31'),
    ).toThrow(BadRequestException);
  });

  it('to con formato inválido: BadRequestException', () => {
    expect(() =>
      assertValidAccountingDateRange('2026-03-01', '2026-13-01'),
    ).toThrow(BadRequestException);
  });
});

describe('signedNaturalBalance', () => {
  it('cuenta DEBIT (ej. ASSET): crece con el débito', () => {
    expect(signedNaturalBalance('DEBIT', d('100'), d('30')).toFixed(2)).toBe(
      '70.00',
    );
  });

  it('cuenta CREDIT (ej. LIABILITY): crece con el crédito', () => {
    expect(signedNaturalBalance('CREDIT', d('30'), d('100')).toFixed(2)).toBe(
      '70.00',
    );
  });

  it('puede ser negativo si la cuenta termina "contra su naturaleza"', () => {
    expect(signedNaturalBalance('DEBIT', d('10'), d('50')).toFixed(2)).toBe(
      '-40.00',
    );
  });
});

describe('splitNetBalance', () => {
  it('neto positivo -> columna débito, crédito en cero', () => {
    const result = splitNetBalance(d('100'), d('40'));
    expect(result.debit.toFixed(2)).toBe('60.00');
    expect(result.credit.toFixed(2)).toBe('0.00');
  });

  it('neto negativo -> columna crédito (valor absoluto), débito en cero', () => {
    const result = splitNetBalance(d('40'), d('100'));
    expect(result.debit.toFixed(2)).toBe('0.00');
    expect(result.credit.toFixed(2)).toBe('60.00');
  });

  it('neto exactamente cero -> ambas columnas en cero', () => {
    const result = splitNetBalance(d('50'), d('50'));
    expect(result.debit.toFixed(2)).toBe('0.00');
    expect(result.credit.toFixed(2)).toBe('0.00');
  });
});
