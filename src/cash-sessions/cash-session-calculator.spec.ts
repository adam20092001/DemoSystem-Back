import { BadRequestException } from '@nestjs/common';
import { PaymentStatus, Prisma } from '@prisma/client';
import {
  assertClosingObservationRequiredForDifference,
  assertValidCountedCashAmountShape,
  assertValidOpeningAmountShape,
  calculateCashSessionTotals,
  calculateDifference,
  CashSessionPaymentSnapshot,
  normalizeOptionalCashSessionText,
  normalizeRejectionReason,
  parseCountedCashAmount,
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

// ==========================================================================
// Ticket B, Bloque B3 — cierre/descuadre
// ==========================================================================

describe('parseCountedCashAmount', () => {
  it('cero: válido', () => {
    expect(parseCountedCashAmount('0').toFixed(2)).toBe('0.00');
  });

  it('positivo válido', () => {
    expect(parseCountedCashAmount('295.00').toFixed(2)).toBe('295.00');
  });

  it.each([
    ['negativo', '-1.00'],
    ['no numérico', 'abc'],
    ['más de 2 decimales', '10.999'],
  ])('rechaza forma inválida (%s): %s', (_label, value) => {
    expect(() => parseCountedCashAmount(value)).toThrow(BadRequestException);
  });
});

describe('assertValidCountedCashAmountShape', () => {
  it('Decimal negativo: lanza', () => {
    expect(() =>
      assertValidCountedCashAmountShape(new Prisma.Decimal('-0.01')),
    ).toThrow(BadRequestException);
  });

  it('Decimal cero: no lanza', () => {
    expect(() =>
      assertValidCountedCashAmountShape(new Prisma.Decimal('0')),
    ).not.toThrow();
  });
});

describe('calculateDifference', () => {
  it('counted > expected: diferencia positiva', () => {
    const diff = calculateDifference(
      new Prisma.Decimal('310.00'),
      new Prisma.Decimal('300.00'),
    );
    expect(diff.toFixed(2)).toBe('10.00');
  });

  it('counted < expected: diferencia negativa', () => {
    const diff = calculateDifference(
      new Prisma.Decimal('290.00'),
      new Prisma.Decimal('300.00'),
    );
    expect(diff.toFixed(2)).toBe('-10.00');
  });

  it('counted = expected: diferencia exactamente cero', () => {
    const diff = calculateDifference(
      new Prisma.Decimal('300.00'),
      new Prisma.Decimal('300.00'),
    );
    expect(diff.isZero()).toBe(true);
  });

  it('exactitud Decimal: sin arrastre de punto flotante en centavos', () => {
    const diff = calculateDifference(
      new Prisma.Decimal('0.30'),
      new Prisma.Decimal('0.10'),
    );
    // 0.30 - 0.10 en JS float = 0.19999999999999998; Decimal debe dar 0.20 exacto.
    expect(diff.toFixed(2)).toBe('0.20');
  });
});

describe('normalizeOptionalCashSessionText', () => {
  it('undefined -> null', () => {
    expect(normalizeOptionalCashSessionText(undefined)).toBeNull();
  });

  it('null -> null', () => {
    expect(normalizeOptionalCashSessionText(null)).toBeNull();
  });

  it('cadena vacía tras trim -> null', () => {
    expect(normalizeOptionalCashSessionText('   ')).toBeNull();
  });

  it('recorta espacios', () => {
    expect(normalizeOptionalCashSessionText('  hola  ')).toBe('hola');
  });

  it('más de 500 caracteres: lanza', () => {
    expect(() => normalizeOptionalCashSessionText('a'.repeat(501))).toThrow(
      BadRequestException,
    );
  });

  it('exactamente 500 caracteres: no lanza', () => {
    expect(() =>
      normalizeOptionalCashSessionText('a'.repeat(500)),
    ).not.toThrow();
  });
});

describe('normalizeRejectionReason', () => {
  it('recorta espacios', () => {
    expect(normalizeRejectionReason('  motivo  ')).toBe('motivo');
  });

  it('vacío: lanza', () => {
    expect(() => normalizeRejectionReason('')).toThrow(BadRequestException);
  });

  it('solo espacios: lanza', () => {
    expect(() => normalizeRejectionReason('   ')).toThrow(BadRequestException);
  });

  it('más de 500 caracteres: lanza', () => {
    expect(() => normalizeRejectionReason('a'.repeat(501))).toThrow(
      BadRequestException,
    );
  });
});

describe('assertClosingObservationRequiredForDifference', () => {
  it('diferencia cero: nunca exige observación', () => {
    expect(() =>
      assertClosingObservationRequiredForDifference(
        new Prisma.Decimal(0),
        null,
      ),
    ).not.toThrow();
  });

  it('diferencia distinta de cero + observación null: lanza', () => {
    expect(() =>
      assertClosingObservationRequiredForDifference(
        new Prisma.Decimal('-10.00'),
        null,
      ),
    ).toThrow(BadRequestException);
  });

  it('diferencia distinta de cero + observación en blanco: lanza', () => {
    expect(() =>
      assertClosingObservationRequiredForDifference(
        new Prisma.Decimal('10.00'),
        '   ',
      ),
    ).toThrow(BadRequestException);
  });

  it('diferencia distinta de cero + observación válida: no lanza', () => {
    expect(() =>
      assertClosingObservationRequiredForDifference(
        new Prisma.Decimal('10.00'),
        'Faltante justificado',
      ),
    ).not.toThrow();
  });
});

describe('calculateCashSessionTotals', () => {
  function makePayment(
    overrides: Partial<CashSessionPaymentSnapshot> = {},
  ): CashSessionPaymentSnapshot {
    return {
      amount: new Prisma.Decimal('100.00'),
      status: PaymentStatus.ACTIVE,
      paymentMethodId: 'pm-cash',
      paymentMethodCode: 'CASH',
      paymentMethodName: 'Efectivo',
      paymentMethodAffectsCashDrawer: true,
      ...overrides,
    };
  }

  it('opening 0 sin pagos: expectedCashAmount = 0, sin desglose', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal(0), []);
    expect(totals.collectionsTotal.toFixed(2)).toBe('0.00');
    expect(totals.cashCollectionsTotal.toFixed(2)).toBe('0.00');
    expect(totals.expectedCashAmount.toFixed(2)).toBe('0.00');
    expect(totals.breakdown).toHaveLength(0);
  });

  it('opening positivo sin pagos: expectedCashAmount = opening', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal('100.00'), []);
    expect(totals.expectedCashAmount.toFixed(2)).toBe('100.00');
  });

  it('un pago que afecta caja (CASH-like): suma a cashCollectionsTotal y a expectedCashAmount', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal('100.00'), [
      makePayment({ amount: new Prisma.Decimal('200.00') }),
    ]);
    expect(totals.collectionsTotal.toFixed(2)).toBe('200.00');
    expect(totals.cashCollectionsTotal.toFixed(2)).toBe('200.00');
    expect(totals.expectedCashAmount.toFixed(2)).toBe('300.00');
  });

  it('un pago que NO afecta caja (CARD-like): suma a collectionsTotal pero no a cashCollectionsTotal ni a expectedCashAmount', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal('100.00'), [
      makePayment({
        amount: new Prisma.Decimal('300.00'),
        paymentMethodId: 'pm-card',
        paymentMethodCode: 'CARD',
        paymentMethodName: 'Tarjeta',
        paymentMethodAffectsCashDrawer: false,
      }),
    ]);
    expect(totals.collectionsTotal.toFixed(2)).toBe('300.00');
    expect(totals.cashCollectionsTotal.toFixed(2)).toBe('0.00');
    expect(totals.expectedCashAmount.toFixed(2)).toBe('100.00');
  });

  it('mixto CASH+CARD (ejemplo aprobado del plan): opening 100, CASH 200, CARD 300 -> expected 300, collectionsTotal 500, cashCollectionsTotal 200', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal('100.00'), [
      makePayment({ amount: new Prisma.Decimal('200.00') }),
      makePayment({
        amount: new Prisma.Decimal('300.00'),
        paymentMethodId: 'pm-card',
        paymentMethodCode: 'CARD',
        paymentMethodName: 'Tarjeta',
        paymentMethodAffectsCashDrawer: false,
      }),
    ]);
    expect(totals.collectionsTotal.toFixed(2)).toBe('500.00');
    expect(totals.cashCollectionsTotal.toFixed(2)).toBe('200.00');
    expect(totals.expectedCashAmount.toFixed(2)).toBe('300.00');
    expect(totals.breakdown).toHaveLength(2);
  });

  it('un Payment CANCELLED vinculado se excluye por completo del cálculo', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal('100.00'), [
      makePayment({ amount: new Prisma.Decimal('200.00') }),
      makePayment({
        amount: new Prisma.Decimal('999.00'),
        status: PaymentStatus.CANCELLED,
      }),
    ]);
    expect(totals.collectionsTotal.toFixed(2)).toBe('200.00');
    expect(totals.expectedCashAmount.toFixed(2)).toBe('300.00');
  });

  it('agrupa varios pagos del MISMO método en una sola fila de desglose', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal(0), [
      makePayment({ amount: new Prisma.Decimal('50.00') }),
      makePayment({ amount: new Prisma.Decimal('75.00') }),
    ]);
    expect(totals.breakdown).toHaveLength(1);
    expect(totals.breakdown[0].totalAmount.toFixed(2)).toBe('125.00');
  });

  it('nunca genera filas de desglose para un método sin ningún Payment ACTIVE', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal(0), [
      makePayment({
        amount: new Prisma.Decimal('50.00'),
        status: PaymentStatus.CANCELLED,
      }),
    ]);
    expect(totals.breakdown).toHaveLength(0);
  });

  it('usa el snapshot del Payment (code/name), nunca datos externos', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal(0), [
      makePayment({
        paymentMethodCode: 'CUSTOM_CASH',
        paymentMethodName: 'Nombre Original Snapshoteado',
      }),
    ]);
    expect(totals.breakdown[0].paymentMethodCode).toBe('CUSTOM_CASH');
    expect(totals.breakdown[0].paymentMethodName).toBe(
      'Nombre Original Snapshoteado',
    );
  });

  it('exactitud Decimal: montos con centavos no acumulan error de punto flotante', () => {
    const totals = calculateCashSessionTotals(new Prisma.Decimal('0.10'), [
      makePayment({ amount: new Prisma.Decimal('0.20') }),
    ]);
    expect(totals.expectedCashAmount.toFixed(2)).toBe('0.30');
  });
});
