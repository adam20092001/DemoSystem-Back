import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
import {
  assertReferenceRequiredForMethod,
  assertValidPaymentAmountShape,
  normalizePaymentCancellationReason,
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

describe('normalizePaymentReference', () => {
  it('undefined -> null (método que no la exige)', () => {
    expect(normalizePaymentReference(PaymentMethod.CASH, undefined)).toBeNull();
  });

  it('null -> null (método que no la exige)', () => {
    expect(normalizePaymentReference(PaymentMethod.CASH, null)).toBeNull();
  });

  it('recorta espacios perimetrales', () => {
    expect(normalizePaymentReference(PaymentMethod.CASH, '  OP-123  ')).toBe(
      'OP-123',
    );
  });

  it('cadena vacía tras recortar -> null', () => {
    expect(normalizePaymentReference(PaymentMethod.CASH, '   ')).toBeNull();
  });

  it('longitud exactamente 100: acepta', () => {
    const reference = 'a'.repeat(100);
    expect(normalizePaymentReference(PaymentMethod.CASH, reference)).toBe(
      reference,
    );
  });

  it('longitud 101: rechaza', () => {
    expect(() =>
      normalizePaymentReference(PaymentMethod.CASH, 'a'.repeat(101)),
    ).toThrow(BadRequestException);
  });

  describe('métodos que exigen referencia (Documento Maestro §16)', () => {
    it.each([
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.BANK_DEPOSIT,
      PaymentMethod.CARD,
    ])('%s sin referencia -> 400', (method) => {
      expect(() => normalizePaymentReference(method, undefined)).toThrow(
        BadRequestException,
      );
      expect(() => normalizePaymentReference(method, '   ')).toThrow(
        BadRequestException,
      );
    });

    it.each([
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.BANK_DEPOSIT,
      PaymentMethod.CARD,
    ])('%s con referencia no vacía: acepta', (method) => {
      expect(normalizePaymentReference(method, 'OP-000123')).toBe('OP-000123');
    });
  });

  describe('métodos que admiten referencia opcional', () => {
    it.each([
      PaymentMethod.CASH,
      PaymentMethod.DIGITAL_WALLET,
      PaymentMethod.OTHER,
    ])('%s sin referencia: acepta (null)', (method) => {
      expect(normalizePaymentReference(method, undefined)).toBeNull();
    });

    it.each([
      PaymentMethod.CASH,
      PaymentMethod.DIGITAL_WALLET,
      PaymentMethod.OTHER,
    ])('%s con referencia: acepta el valor', (method) => {
      expect(normalizePaymentReference(method, 'REF-1')).toBe('REF-1');
    });
  });
});

describe('assertReferenceRequiredForMethod', () => {
  it('BANK_TRANSFER con referencia null: lanza', () => {
    expect(() =>
      assertReferenceRequiredForMethod(PaymentMethod.BANK_TRANSFER, null),
    ).toThrow(BadRequestException);
  });

  it('BANK_DEPOSIT con referencia presente: no lanza', () => {
    expect(() =>
      assertReferenceRequiredForMethod(PaymentMethod.BANK_DEPOSIT, 'X'),
    ).not.toThrow();
  });

  it('CARD con referencia null: lanza', () => {
    expect(() =>
      assertReferenceRequiredForMethod(PaymentMethod.CARD, null),
    ).toThrow(BadRequestException);
  });

  it('CASH con referencia null: no lanza', () => {
    expect(() =>
      assertReferenceRequiredForMethod(PaymentMethod.CASH, null),
    ).not.toThrow();
  });

  it('DIGITAL_WALLET con referencia null: no lanza (nunca se inventa una exigencia adicional)', () => {
    expect(() =>
      assertReferenceRequiredForMethod(PaymentMethod.DIGITAL_WALLET, null),
    ).not.toThrow();
  });

  it('OTHER con referencia null: no lanza', () => {
    expect(() =>
      assertReferenceRequiredForMethod(PaymentMethod.OTHER, null),
    ).not.toThrow();
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
