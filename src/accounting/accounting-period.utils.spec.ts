import { BadRequestException } from '@nestjs/common';
import {
  parseAccountingDateOnly,
  resolveAccountingDateParts,
} from './accounting-period.utils';

describe('resolveAccountingDateParts', () => {
  it('instante normal del mediodía: misma fecha calendario en Lima', () => {
    const result = resolveAccountingDateParts(
      new Date('2026-03-15T12:00:00.000Z'),
    );
    expect(result.year).toBe(2026);
    expect(result.month).toBe(3);
    expect(result.accountingDate.toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });

  it('caso límite de medianoche UTC: cae en el día ANTERIOR en Lima (UTC-5)', () => {
    const result = resolveAccountingDateParts(
      new Date('2026-03-15T04:30:00.000Z'),
    );
    expect(result.year).toBe(2026);
    expect(result.month).toBe(3);
    expect(result.accountingDate.toISOString()).toBe(
      '2026-03-14T00:00:00.000Z',
    );
  });

  it('exactamente 05:00:00.000Z es ya el nuevo día en Lima (00:00:00 local)', () => {
    const result = resolveAccountingDateParts(
      new Date('2026-03-15T05:00:00.000Z'),
    );
    expect(result.accountingDate.toISOString()).toBe(
      '2026-03-15T00:00:00.000Z',
    );
  });

  it('un milisegundo antes de las 05:00:00Z todavía es el día anterior en Lima', () => {
    const result = resolveAccountingDateParts(
      new Date('2026-03-15T04:59:59.999Z'),
    );
    expect(result.accountingDate.toISOString()).toBe(
      '2026-03-14T00:00:00.000Z',
    );
  });

  it('transición de mes: 2026-04-01T04:00:00Z cae en el 31 de marzo en Lima', () => {
    const result = resolveAccountingDateParts(
      new Date('2026-04-01T04:00:00.000Z'),
    );
    expect(result.year).toBe(2026);
    expect(result.month).toBe(3);
    expect(result.accountingDate.toISOString()).toBe(
      '2026-03-31T00:00:00.000Z',
    );
  });

  it('transición de año: 2027-01-01T04:00:00Z cae en el 31 de diciembre de 2026 en Lima', () => {
    const result = resolveAccountingDateParts(
      new Date('2027-01-01T04:00:00.000Z'),
    );
    expect(result.year).toBe(2026);
    expect(result.month).toBe(12);
    expect(result.accountingDate.toISOString()).toBe(
      '2026-12-31T00:00:00.000Z',
    );
  });
});

describe('parseAccountingDateOnly', () => {
  it('fecha explícita válida: year/month/accountingDate correctos, sin desplazamiento de huso', () => {
    const result = parseAccountingDateOnly('2026-05-20');
    expect(result.year).toBe(2026);
    expect(result.month).toBe(5);
    expect(result.accountingDate.toISOString()).toBe(
      '2026-05-20T00:00:00.000Z',
    );
  });

  it('formato inválido (no YYYY-MM-DD): BadRequestException', () => {
    expect(() => parseAccountingDateOnly('20/05/2026')).toThrow(
      BadRequestException,
    );
    expect(() => parseAccountingDateOnly('2026-5-20')).toThrow(
      BadRequestException,
    );
  });

  it('fecha calendario inexistente: BadRequestException', () => {
    expect(() => parseAccountingDateOnly('2026-02-30')).toThrow(
      BadRequestException,
    );
    expect(() => parseAccountingDateOnly('2026-13-01')).toThrow(
      BadRequestException,
    );
  });

  it('string vacío: BadRequestException', () => {
    expect(() => parseAccountingDateOnly('')).toThrow(BadRequestException);
  });
});
