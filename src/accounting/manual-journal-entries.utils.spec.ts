import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertManualDraftLinesBalanced,
  parseManualDraftLineAmounts,
} from './manual-journal-entries.utils';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

describe('assertManualDraftLinesBalanced', () => {
  it('líneas balanceadas: no lanza', () => {
    expect(() =>
      assertManualDraftLinesBalanced([
        { debitAmount: d('100.00'), creditAmount: d('0.00') },
        { debitAmount: d('0.00'), creditAmount: d('100.00') },
      ]),
    ).not.toThrow();
  });

  it('desbalanceadas: BadRequestException (nunca 500 — error de entrada del ACCOUNTANT)', () => {
    expect(() =>
      assertManualDraftLinesBalanced([
        { debitAmount: d('100.00'), creditAmount: d('0.00') },
        { debitAmount: d('0.00'), creditAmount: d('90.00') },
      ]),
    ).toThrow(BadRequestException);
  });

  it('menos de dos líneas: BadRequestException', () => {
    expect(() =>
      assertManualDraftLinesBalanced([
        { debitAmount: d('100.00'), creditAmount: d('0.00') },
      ]),
    ).toThrow(BadRequestException);
  });

  it('una línea con ambos lados en cero: BadRequestException', () => {
    expect(() =>
      assertManualDraftLinesBalanced([
        { debitAmount: d('0.00'), creditAmount: d('0.00') },
        { debitAmount: d('100.00'), creditAmount: d('0.00') },
      ]),
    ).toThrow(BadRequestException);
  });

  it('una línea con ambos lados positivos: BadRequestException', () => {
    expect(() =>
      assertManualDraftLinesBalanced([
        { debitAmount: d('50.00'), creditAmount: d('50.00') },
        { debitAmount: d('0.00'), creditAmount: d('100.00') },
      ]),
    ).toThrow(BadRequestException);
  });
});

describe('parseManualDraftLineAmounts', () => {
  it('parsea un par válido (débito positivo, crédito cero)', () => {
    const result = parseManualDraftLineAmounts({
      debitAmount: '100.00',
      creditAmount: '0.00',
    });
    expect(result.debitAmount.toFixed(2)).toBe('100.00');
    expect(result.creditAmount.toFixed(2)).toBe('0.00');
  });

  it('0.00 / 0.00 es válido (línea de borrador todavía sin llenar)', () => {
    expect(() =>
      parseManualDraftLineAmounts({
        debitAmount: '0.00',
        creditAmount: '0.00',
      }),
    ).not.toThrow();
  });

  it('monto no numérico: BadRequestException', () => {
    expect(() =>
      parseManualDraftLineAmounts({
        debitAmount: 'abc',
        creditAmount: '0.00',
      }),
    ).toThrow(BadRequestException);
  });

  it('monto negativo: BadRequestException', () => {
    expect(() =>
      parseManualDraftLineAmounts({
        debitAmount: '-10.00',
        creditAmount: '0.00',
      }),
    ).toThrow(BadRequestException);
  });

  it('ambos lados positivos a la vez: BadRequestException', () => {
    expect(() =>
      parseManualDraftLineAmounts({
        debitAmount: '10.00',
        creditAmount: '5.00',
      }),
    ).toThrow(BadRequestException);
  });
});
