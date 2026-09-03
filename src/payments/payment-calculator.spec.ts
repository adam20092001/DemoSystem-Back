import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertReferenceRequiredForMethod,
  assertValidPaymentAmountShape,
  normalizePaymentCancellationReason,
  normalizePaymentMethodCode,
  normalizePaymentReference,
  parsePaymentAmount,
} from './payment-calculator';

describe('parsePaymentAmount', () => {
  it('entero válido', () => {
    expect(parsePaymentAmount('100').toFixed(2)).toBe('100.00');
  });

  it('un decimal válido', () => {
    expect(parsePaymentAmount('99.5').toFixed(2)).toBe('99.50');
  });

  it('dos decimales válidos', () => {
    expect(parsePaymentAmount('99.90').toFixed(2)).toBe('99.90');
  });

  it('ceros a la izquierda: forma válida según el patrón (dígitos)', () => {
    expect(parsePaymentAmount('010.00').toFixed(2)).toBe('10.00');
  });

  it.each([
    ['cero', '0'],
    ['cero con decimales', '0.00'],
    ['negativo', '-10.00'],
    ['notación científica', '1e2'],
    ['coma decimal', '10,00'],
    ['espacio en blanco', '  '],
    ['cadena vacía', ''],
    ['más de 2 decimales', '10.999'],
    ['no numérico', 'abc'],
    ['signo positivo explícito', '+10.00'],
  ])('rechaza forma malformada/inválida (%s): %s', (_label, value) => {
    expect(() => parsePaymentAmount(value)).toThrow(BadRequestException);
  });

  it('rechaza monto que excede la capacidad de Decimal(14,2)', () => {
    expect(() => parsePaymentAmount('9999999999999.99')).toThrow(
      BadRequestException,
    );
  });

  it('acepta el límite máximo exacto de Decimal(14,2)', () => {
    expect(() => parsePaymentAmount('999999999999.99')).not.toThrow();
  });
});

describe('assertValidPaymentAmountShape', () => {
  it('Decimal positivo válido: no lanza', () => {
    expect(() =>
      assertValidPaymentAmountShape(new Prisma.Decimal('10.00')),
    ).not.toThrow();
  });

  it('Decimal <= 0: lanza', () => {
    expect(() =>
      assertValidPaymentAmountShape(new Prisma.Decimal('0')),
    ).toThrow(BadRequestException);
  });

  it('Decimal con más de 2 decimales: lanza', () => {
    expect(() =>
      assertValidPaymentAmountShape(new Prisma.Decimal('10.999')),
    ).toThrow(BadRequestException);
  });

  it('Decimal no finito (Infinity): lanza', () => {
    expect(() =>
      assertValidPaymentAmountShape(new Prisma.Decimal(Infinity)),
    ).toThrow(BadRequestException);
  });

  it('Decimal que excede Decimal(14,2): lanza', () => {
    expect(() =>
      assertValidPaymentAmountShape(new Prisma.Decimal('9999999999999.99')),
    ).toThrow(BadRequestException);
  });
});

describe('normalizePaymentMethodCode (Ticket C, Bloque C3)', () => {
  it('trim + mayúsculas', () => {
    expect(normalizePaymentMethodCode('  cash  ')).toBe('CASH');
  });

  it('ya en mayúsculas: idempotente', () => {
    expect(normalizePaymentMethodCode('YAPE')).toBe('YAPE');
  });

  it('acepta guion bajo y dígitos tras la letra inicial', () => {
    expect(normalizePaymentMethodCode('custom_bank_2')).toBe('CUSTOM_BANK_2');
  });

  it.each([
    ['un solo carácter', 'x'],
    ['inicia con dígito', '1CASH'],
    ['inicia con guion bajo', '_CASH'],
    ['contiene espacio interno', 'CA SH'],
    ['contiene un carácter no permitido', 'CASH!'],
    ['cadena vacía', ''],
    ['más de 30 caracteres', 'A'.repeat(31)],
  ])('rechaza forma inválida (%s): %s', (_label, value) => {
    expect(() => normalizePaymentMethodCode(value)).toThrow(
      BadRequestException,
    );
  });

  it('exactamente 30 caracteres: acepta', () => {
    const code = 'A' + 'B'.repeat(29);
    expect(normalizePaymentMethodCode(code)).toBe(code);
  });

  it('valor no string: lanza', () => {
    expect(() =>
      normalizePaymentMethodCode(undefined as unknown as string),
    ).toThrow(BadRequestException);
  });
});

describe('normalizePaymentReference (Ticket C, Bloque C3: ya no depende del método)', () => {
  it('undefined -> null', () => {
    expect(normalizePaymentReference(undefined)).toBeNull();
  });

  it('null -> null', () => {
    expect(normalizePaymentReference(null)).toBeNull();
  });

  it('recorta espacios perimetrales', () => {
    expect(normalizePaymentReference('  OP-123  ')).toBe('OP-123');
  });

  it('cadena vacía tras recortar -> null', () => {
    expect(normalizePaymentReference('   ')).toBeNull();
  });

  it('longitud exactamente 100: acepta', () => {
    const reference = 'a'.repeat(100);
    expect(normalizePaymentReference(reference)).toBe(reference);
  });

  it('longitud 101: rechaza', () => {
    expect(() => normalizePaymentReference('a'.repeat(101))).toThrow(
      BadRequestException,
    );
  });

  it('valor no string (ni undefined/null): rechaza', () => {
    expect(() => normalizePaymentReference(123 as unknown as string)).toThrow(
      BadRequestException,
    );
  });

  it('nunca exige la referencia por sí sola, sin importar el valor recortado', () => {
    // A diferencia del Bloque B, esta función ya no conoce ningún método: la
    // exigencia se evalúa por separado con assertReferenceRequiredForMethod(),
    // una vez resuelto el PaymentMethod dinámico dentro de PaymentEngine.
    expect(() => normalizePaymentReference(undefined)).not.toThrow();
    expect(() => normalizePaymentReference(null)).not.toThrow();
  });
});

describe('assertReferenceRequiredForMethod (Ticket C, Bloque C3: booleano dinámico, no membresía de enum)', () => {
  it('requiresReference=true con referencia null: lanza', () => {
    expect(() => assertReferenceRequiredForMethod(true, null)).toThrow(
      BadRequestException,
    );
  });

  it('requiresReference=true con referencia presente: no lanza', () => {
    expect(() => assertReferenceRequiredForMethod(true, 'X')).not.toThrow();
  });

  it('requiresReference=false con referencia null: no lanza', () => {
    expect(() => assertReferenceRequiredForMethod(false, null)).not.toThrow();
  });

  it('requiresReference=false con referencia presente: no lanza (nunca rechaza una referencia opcional ya provista)', () => {
    expect(() => assertReferenceRequiredForMethod(false, 'X')).not.toThrow();
  });
});

describe('normalizePaymentCancellationReason', () => {
  it('recorta espacios perimetrales', () => {
    expect(normalizePaymentCancellationReason('  motivo  ')).toBe('motivo');
  });

  it('vacío -> 400', () => {
    expect(() => normalizePaymentCancellationReason('')).toThrow(
      BadRequestException,
    );
  });

  it('solo espacios -> 400', () => {
    expect(() => normalizePaymentCancellationReason('   ')).toThrow(
      BadRequestException,
    );
  });

  it('longitud exactamente 200: acepta', () => {
    const reason = 'a'.repeat(200);
    expect(normalizePaymentCancellationReason(reason)).toBe(reason);
  });

  it('longitud 201: rechaza', () => {
    expect(() => normalizePaymentCancellationReason('a'.repeat(201))).toThrow(
      BadRequestException,
    );
  });
});
