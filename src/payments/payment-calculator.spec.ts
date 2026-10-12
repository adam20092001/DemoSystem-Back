import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  assertReferenceRequiredForMethod,
  assertValidPaymentAmountShape,
  normalizePaymentCancellationReason,
  normalizePaymentMethodCode,
  normalizePaymentReference,
  parseInitialPayments,
  parsePaymentAmount,
} from './payment-calculator';
import { MAX_INITIAL_PAYMENTS } from './constants/payment.constants';
import { InitialPaymentInput } from './types/payment.input';

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

describe('parseInitialPayments (R1-B1)', () => {
  function cashOf(amount: string): InitialPaymentInput {
    return { method: 'CASH', amount };
  }

  function batchOf(count: number): InitialPaymentInput[] {
    return Array.from({ length: count }, () => cashOf('1.00'));
  }

  describe('sin pago inicial', () => {
    it.each([
      ['ambos ausentes', undefined, undefined],
      ['ambos null (equivale a ausente)', null, null],
    ])('%s: lote vacío y total Decimal 0', (_label, payment, payments) => {
      const result = parseInitialPayments(payment, payments);

      expect(result.items).toEqual([]);
      expect(Prisma.Decimal.isDecimal(result.totalAmount)).toBe(true);
      expect(result.totalAmount.equals(0)).toBe(true);
    });
  });

  describe('forma singular existente (`payment`)', () => {
    it('produce exactamente un elemento normalizado y su monto como total', () => {
      const result = parseInitialPayments({
        method: 'CASH',
        amount: '40.00',
        reference: '  OP-1  ',
      });

      expect(result.items).toHaveLength(1);
      expect(result.items[0].method).toBe('CASH');
      expect(result.items[0].amount.toFixed(2)).toBe('40.00');
      expect(result.items[0].reference).toBe('OP-1');
      expect(result.totalAmount.toFixed(2)).toBe('40.00');
    });

    it('equivale exactamente a parsePaymentAmount + normalizePaymentReference (mismo resultado que el parseo singular actual)', () => {
      const input: InitialPaymentInput = {
        method: '  yape ',
        amount: '010.5',
        reference: '   ',
      };

      const [item] = parseInitialPayments(input).items;

      // `method` se conserva CRUDO: la normalización/resolución sigue
      // ocurriendo dentro de PaymentEngine.register().
      expect(item.method).toBe(input.method);
      expect(item.amount.equals(parsePaymentAmount(input.amount))).toBe(true);
      expect(item.reference).toBe(normalizePaymentReference(input.reference));
      expect(item.reference).toBeNull();
    });

    it('referencia ausente -> null', () => {
      const [item] = parseInitialPayments(cashOf('10.00')).items;
      expect(item.reference).toBeNull();
    });

    it('monto inválido conserva el mismo error 400 que parsePaymentAmount', () => {
      expect(() => parseInitialPayments(cashOf('0'))).toThrow(
        BadRequestException,
      );
      expect(() => parseInitialPayments(cashOf('10.999'))).toThrow(
        'El monto debe ser un decimal positivo, como texto, con máximo 2 decimales',
      );
    });

    it('referencia demasiado larga conserva el mismo error 400 que normalizePaymentReference', () => {
      expect(() =>
        parseInitialPayments({
          method: 'CASH',
          amount: '10.00',
          reference: 'x'.repeat(101),
        }),
      ).toThrow('La referencia no puede superar los 100 caracteres');
    });
  });

  describe('lote (`payments`)', () => {
    it('tres pagos válidos (250 = CASH 100 + YAPE 100 + CARD 50): tres elementos y suma exacta', () => {
      const result = parseInitialPayments(undefined, [
        { method: 'CASH', amount: '100.00' },
        { method: 'YAPE', amount: '100.00', reference: 'OP-123' },
        { method: 'CARD', amount: '50.00', reference: 'VCH-9' },
      ]);

      expect(result.items).toHaveLength(3);
      expect(result.totalAmount.toFixed(2)).toBe('250.00');
    });

    it('conserva el orden original de los pagos', () => {
      const result = parseInitialPayments(undefined, [
        { method: 'CARD', amount: '3.00', reference: 'C' },
        { method: 'CASH', amount: '1.00' },
        { method: 'YAPE', amount: '2.00', reference: 'Y' },
      ]);

      expect(result.items.map((item) => item.method)).toEqual([
        'CARD',
        'CASH',
        'YAPE',
      ]);
      expect(result.items.map((item) => item.amount.toFixed(2))).toEqual([
        '3.00',
        '1.00',
        '2.00',
      ]);
    });

    it('admite métodos repetidos', () => {
      const result = parseInitialPayments(undefined, [
        cashOf('60.00'),
        cashOf('40.00'),
      ]);

      expect(result.items.map((item) => item.method)).toEqual(['CASH', 'CASH']);
      expect(result.totalAmount.toFixed(2)).toBe('100.00');
    });

    it('un solo elemento en el lote es válido', () => {
      const result = parseInitialPayments(undefined, [cashOf('5.00')]);
      expect(result.items).toHaveLength(1);
      expect(result.totalAmount.toFixed(2)).toBe('5.00');
    });

    it('acepta exactamente MAX_INITIAL_PAYMENTS (10) pagos', () => {
      expect(MAX_INITIAL_PAYMENTS).toBe(10);
      const result = parseInitialPayments(undefined, batchOf(10));

      expect(result.items).toHaveLength(10);
      expect(result.totalAmount.toFixed(2)).toBe('10.00');
    });

    it('rechaza 11 pagos con 400', () => {
      expect(() => parseInitialPayments(undefined, batchOf(11))).toThrow(
        new BadRequestException('"payments" admite como máximo 10 pagos'),
      );
    });

    it('rechaza un arreglo vacío explícito con 400', () => {
      expect(() => parseInitialPayments(undefined, [])).toThrow(
        new BadRequestException('"payments" debe contener al menos un pago'),
      );
    });

    it('rechaza un valor que no es arreglo con 400', () => {
      expect(() =>
        parseInitialPayments(
          undefined,
          cashOf('1.00') as unknown as InitialPaymentInput[],
        ),
      ).toThrow(BadRequestException);
    });

    it('rechaza enviar `payment` y `payments` a la vez con 400, incluso con un lote válido', () => {
      expect(() =>
        parseInitialPayments(cashOf('10.00'), [cashOf('10.00')]),
      ).toThrow(
        new BadRequestException(
          'No se puede enviar "payment" y "payments" a la vez',
        ),
      );
    });

    it('`payment` + `payments` vacío también es conflicto (la exclusión se evalúa primero)', () => {
      expect(() => parseInitialPayments(cashOf('10.00'), [])).toThrow(
        'No se puede enviar "payment" y "payments" a la vez',
      );
    });

    it('un monto inválido en cualquier posición rechaza todo el lote con el error existente', () => {
      expect(() =>
        parseInitialPayments(undefined, [
          cashOf('10.00'),
          cashOf('-5.00'),
          cashOf('10.00'),
        ]),
      ).toThrow(
        'El monto debe ser un decimal positivo, como texto, con máximo 2 decimales',
      );
    });

    it('normaliza la referencia de cada elemento con las reglas existentes', () => {
      const result = parseInitialPayments(undefined, [
        { method: 'YAPE', amount: '1.00', reference: '  OP-9  ' },
        { method: 'CASH', amount: '1.00', reference: '   ' },
        { method: 'CASH', amount: '1.00' },
      ]);

      expect(result.items.map((item) => item.reference)).toEqual([
        'OP-9',
        null,
        null,
      ]);
    });

    it('montos límite: 0.01 y el máximo de Decimal(14,2) son válidos', () => {
      const result = parseInitialPayments(undefined, [
        cashOf('0.01'),
        cashOf('999999999999.99'),
      ]);

      expect(result.items[0].amount.toFixed(2)).toBe('0.01');
      expect(result.items[1].amount.toFixed(2)).toBe('999999999999.99');
      expect(result.totalAmount.toFixed(2)).toBe('1000000000000.00');
    });

    it('la suma es aritmética Decimal exacta, sin errores de punto flotante', () => {
      // 0.1 + 0.2 en punto flotante de JS es 0.30000000000000004.
      const result = parseInitialPayments(undefined, [
        cashOf('0.10'),
        cashOf('0.20'),
      ]);
      expect(result.totalAmount.equals(new Prisma.Decimal('0.30'))).toBe(true);
      expect(result.totalAmount.toFixed(2)).toBe('0.30');

      const many = parseInitialPayments(
        undefined,
        Array.from({ length: 10 }, () => cashOf('0.10')),
      );
      expect(many.totalAmount.equals(new Prisma.Decimal('1.00'))).toBe(true);
    });
  });
});
