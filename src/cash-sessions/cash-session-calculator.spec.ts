import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertValidOpeningAmountShape,
  parseOpeningAmount,
} from './cash-session-calculator';

describe('parseOpeningAmount', () => {
  it('cero: válido (caja sin fondo inicial)', () => {
    expect(parseOpeningAmount('0').toFixed(2)).toBe('0.00');
  });

  it('cero con decimales: válido', () => {
    expect(parseOpeningAmount('0.00').toFixed(2)).toBe('0.00');
  });

  it('entero positivo válido', () => {
    expect(parseOpeningAmount('100').toFixed(2)).toBe('100.00');
  });

  it('dos decimales válidos', () => {
    expect(parseOpeningAmount('99.90').toFixed(2)).toBe('99.90');
  });

  it('ceros a la izquierda: forma válida según el patrón (dígitos)', () => {
    expect(parseOpeningAmount('010.00').toFixed(2)).toBe('10.00');
  });

  it.each([
    ['negativo', '-10.00'],
    ['notación científica', '1e2'],
    ['coma decimal', '10,00'],
    ['espacio en blanco', '  '],
    ['cadena vacía', ''],
    ['más de 2 decimales', '10.999'],
    ['no numérico', 'abc'],
    ['signo positivo explícito', '+10.00'],
  ])('rechaza forma malformada/inválida (%s): %s', (_label, value) => {
    expect(() => parseOpeningAmount(value)).toThrow(BadRequestException);
  });

  it('rechaza monto que excede la capacidad de Decimal(14,2)', () => {
    expect(() => parseOpeningAmount('9999999999999.99')).toThrow(
      BadRequestException,
    );
  });

  it('acepta el límite máximo exacto de Decimal(14,2)', () => {
    expect(() => parseOpeningAmount('999999999999.99')).not.toThrow();
  });
});

describe('assertValidOpeningAmountShape', () => {
  it('Decimal cero: no lanza (a diferencia de un monto de Payment)', () => {
    expect(() =>
      assertValidOpeningAmountShape(new Prisma.Decimal('0')),
    ).not.toThrow();
  });

  it('Decimal positivo válido: no lanza', () => {
    expect(() =>
      assertValidOpeningAmountShape(new Prisma.Decimal('10.00')),
    ).not.toThrow();
  });

  it('Decimal negativo: lanza', () => {
    expect(() =>
      assertValidOpeningAmountShape(new Prisma.Decimal('-0.01')),
    ).toThrow(BadRequestException);
  });

  it('Decimal con más de 2 decimales: lanza', () => {
    expect(() =>
      assertValidOpeningAmountShape(new Prisma.Decimal('10.999')),
    ).toThrow(BadRequestException);
  });

  it('Decimal no finito (Infinity): lanza', () => {
    expect(() =>
      assertValidOpeningAmountShape(new Prisma.Decimal(Infinity)),
    ).toThrow(BadRequestException);
  });

  it('Decimal que excede Decimal(14,2): lanza', () => {
    expect(() =>
      assertValidOpeningAmountShape(new Prisma.Decimal('9999999999999.99')),
    ).toThrow(BadRequestException);
  });
});
