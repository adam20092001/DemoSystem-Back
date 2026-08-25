import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, QuoteStatus } from '@prisma/client';
import {
  QUOTE_TAX_AMOUNT,
  assertAcceptable,
  assertDiscountWithinConfiguredLimit,
  assertDiscountWithinSubtotal,
  assertEditable,
  assertQuantityAllowedForUnit,
  assertRejectable,
  buildEffectiveQuoteStatusCondition,
  calculateLineTotal,
  calculateSubtotal,
  calculateTotal,
  effectiveStatus,
  parseDiscountAmount,
  parseQuantity,
} from './quote-calculator';

describe('parseQuantity', () => {
  it('entero válido', () => {
    expect(parseQuantity('5').toFixed(3)).toBe('5.000');
  });

  it('decimal válido (3 decimales)', () => {
    expect(parseQuantity('2.500').toFixed(3)).toBe('2.500');
  });

  it('más de 3 decimales -> error', () => {
    expect(() => parseQuantity('1.2345')).toThrow(BadRequestException);
  });

  it('cero -> error', () => {
    expect(() => parseQuantity('0')).toThrow(BadRequestException);
  });

  it('negativo -> error', () => {
    expect(() => parseQuantity('-1')).toThrow(BadRequestException);
  });

  it('excede Decimal(14,3) -> error', () => {
    expect(() => parseQuantity('100000000000.000')).toThrow(
      BadRequestException,
    );
  });

  it('cadena vacía -> error', () => {
    expect(() => parseQuantity('')).toThrow(BadRequestException);
  });

  it('no numérico -> error', () => {
    expect(() => parseQuantity('abc')).toThrow(BadRequestException);
  });

  it('notación científica -> error', () => {
    expect(() => parseQuantity('1e3')).toThrow(BadRequestException);
  });
});

describe('assertQuantityAllowedForUnit', () => {
  it('allowDecimal=false con cantidad entera: no lanza', () => {
    expect(() =>
      assertQuantityAllowedForUnit(new Prisma.Decimal('5'), false),
    ).not.toThrow();
  });

  it('allowDecimal=false con cantidad fraccionaria: lanza', () => {
    expect(() =>
      assertQuantityAllowedForUnit(new Prisma.Decimal('5.5'), false),
    ).toThrow(BadRequestException);
  });

  it('allowDecimal=true con cantidad fraccionaria: no lanza', () => {
    expect(() =>
      assertQuantityAllowedForUnit(new Prisma.Decimal('5.5'), true),
    ).not.toThrow();
  });
});

describe('parseDiscountAmount', () => {
  it('ausente -> 0.00', () => {
    expect(parseDiscountAmount(undefined).toFixed(2)).toBe('0.00');
  });

  it('"0" válido', () => {
    expect(parseDiscountAmount('0').toFixed(2)).toBe('0.00');
  });

  it('válido con 2 decimales', () => {
    expect(parseDiscountAmount('15.50').toFixed(2)).toBe('15.50');
  });

  it('negativo -> error', () => {
    expect(() => parseDiscountAmount('-1')).toThrow(BadRequestException);
  });

  it('más de 2 decimales -> error', () => {
    expect(() => parseDiscountAmount('1.005')).toThrow(BadRequestException);
  });

  it('excede Decimal(14,2) -> error', () => {
    expect(() => parseDiscountAmount('10000000000000.00')).toThrow(
      BadRequestException,
    );
  });

  it('no numérico -> error', () => {
    expect(() => parseDiscountAmount('abc')).toThrow(BadRequestException);
  });
});

describe('calculateLineTotal', () => {
  it('cantidad entera x precio exacto', () => {
    const result = calculateLineTotal(
      new Prisma.Decimal('3'),
      new Prisma.Decimal('10.00'),
    );
    expect(result.toFixed(2)).toBe('30.00');
  });

  it('precio 0 produce lineTotal 0', () => {
    const result = calculateLineTotal(
      new Prisma.Decimal('5'),
      new Prisma.Decimal('0'),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it.each([
    ['0.005', '1.00', '0.01'],
    ['1.005', '1.00', '1.01'],
    ['1', '24.875', '24.88'],
    ['12.500', '1.99', '24.88'],
  ])(
    'frontera de redondeo HALF_UP: %s x %s -> %s',
    (quantity, unitPrice, expected) => {
      const result = calculateLineTotal(
        new Prisma.Decimal(quantity),
        new Prisma.Decimal(unitPrice),
      );
      expect(result.toFixed(2)).toBe(expected);
    },
  );

  it('desborda Decimal(14,2) -> ConflictException', () => {
    expect(() =>
      calculateLineTotal(
        new Prisma.Decimal('99999999999.999'),
        new Prisma.Decimal('999999999999.99'),
      ),
    ).toThrow(ConflictException);
  });
});

describe('calculateSubtotal', () => {
  it('suma líneas ya redondeadas', () => {
    const result = calculateSubtotal([
      new Prisma.Decimal('10.00'),
      new Prisma.Decimal('20.50'),
      new Prisma.Decimal('5.25'),
    ]);
    expect(result.toFixed(2)).toBe('35.75');
  });

  it('arreglo vacío -> 0.00', () => {
    expect(calculateSubtotal([]).toFixed(2)).toBe('0.00');
  });

  it('desborda Decimal(14,2) -> ConflictException', () => {
    expect(() =>
      calculateSubtotal([
        new Prisma.Decimal('999999999999.99'),
        new Prisma.Decimal('999999999999.99'),
      ]),
    ).toThrow(ConflictException);
  });
});

describe('assertDiscountWithinSubtotal', () => {
  it('descuento 0 con subtotal positivo: no lanza', () => {
    expect(() =>
      assertDiscountWithinSubtotal(
        new Prisma.Decimal('0'),
        new Prisma.Decimal('100.00'),
      ),
    ).not.toThrow();
  });

  it('descuento == subtotal: no lanza (total 0 es válido)', () => {
    expect(() =>
      assertDiscountWithinSubtotal(
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('100.00'),
      ),
    ).not.toThrow();
  });

  it('descuento > subtotal: BadRequestException', () => {
    expect(() =>
      assertDiscountWithinSubtotal(
        new Prisma.Decimal('100.01'),
        new Prisma.Decimal('100.00'),
      ),
    ).toThrow(BadRequestException);
  });
});

describe('assertDiscountWithinConfiguredLimit (Fase 10, Bloque B)', () => {
  it('max = 0, descuento 0: no lanza', () => {
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('0'),
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('0.00'),
      ),
    ).not.toThrow();
  });

  it('max = 0, descuento > 0: BadRequestException', () => {
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('0.01'),
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('0.00'),
      ),
    ).toThrow(BadRequestException);
  });

  it('max = 10%, descuento exactamente en el límite: no lanza', () => {
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('10.00'),
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('10.00'),
      ),
    ).not.toThrow();
  });

  it('max = 10%, descuento apenas por encima del límite: BadRequestException', () => {
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('10.01'),
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('10.00'),
      ),
    ).toThrow(BadRequestException);
  });

  it('max = 100%, descuento total (== subtotal): no lanza', () => {
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('100.00'),
      ),
    ).not.toThrow();
  });

  it('subtotal = 0 y descuento = 0 (único caso posible por la invariante absoluta): no lanza sin importar max', () => {
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('0'),
        new Prisma.Decimal('0'),
        new Prisma.Decimal('0.00'),
      ),
    ).not.toThrow();
  });

  it('caso Decimal exacto sin error de redondeo de punto flotante (33.33 sobre 100.00 con max 33.33%)', () => {
    // 33.33 * 100 = 3333.00 <= 100.00 * 33.33 = 3333.00 exacto en Decimal;
    // Number(33.33)/100*100.00 en punto flotante JS podría no dar 33.33
    // exacto, produciendo un falso rechazo si se usara Number().
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('33.33'),
        new Prisma.Decimal('100.00'),
        new Prisma.Decimal('33.33'),
      ),
    ).not.toThrow();
  });

  it('caso Decimal exacto: 0.01 por encima del límite calculado con decimales largos se rechaza', () => {
    // subtotal=333.33, max=33.33% -> límite exacto = 333.33*33.33/100 =
    // 111.099889..., así que un descuento de 111.10 (redondeado a 2
    // decimales, como exige Decimal(14,2)) ya lo supera.
    expect(() =>
      assertDiscountWithinConfiguredLimit(
        new Prisma.Decimal('111.10'),
        new Prisma.Decimal('333.33'),
        new Prisma.Decimal('33.33'),
      ),
    ).toThrow(BadRequestException);
  });
});

describe('calculateTotal', () => {
  it('subtotal - descuento + impuesto (impuesto siempre 0)', () => {
    const result = calculateTotal(
      new Prisma.Decimal('100.00'),
      new Prisma.Decimal('10.00'),
      QUOTE_TAX_AMOUNT,
    );
    expect(result.toFixed(2)).toBe('90.00');
  });

  it('sin descuento', () => {
    const result = calculateTotal(
      new Prisma.Decimal('50.00'),
      new Prisma.Decimal('0'),
      QUOTE_TAX_AMOUNT,
    );
    expect(result.toFixed(2)).toBe('50.00');
  });

  it('descuento igual al subtotal produce total exactamente 0.00', () => {
    const result = calculateTotal(
      new Prisma.Decimal('75.00'),
      new Prisma.Decimal('75.00'),
      QUOTE_TAX_AMOUNT,
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('QUOTE_TAX_AMOUNT siempre es 0.00', () => {
    expect(QUOTE_TAX_AMOUNT.toFixed(2)).toBe('0.00');
  });
});

describe('effectiveStatus', () => {
  it('PENDING con vigencia futura permanece PENDING', () => {
    expect(
      effectiveStatus(QuoteStatus.PENDING, '2026-03-20', '2026-03-15'),
    ).toBe(QuoteStatus.PENDING);
  });

  it('PENDING con vigencia igual a hoy permanece PENDING (no vencida)', () => {
    expect(
      effectiveStatus(QuoteStatus.PENDING, '2026-03-15', '2026-03-15'),
    ).toBe(QuoteStatus.PENDING);
  });

  it('PENDING con vigencia pasada se reinterpreta como EXPIRED', () => {
    expect(
      effectiveStatus(QuoteStatus.PENDING, '2026-03-14', '2026-03-15'),
    ).toBe(QuoteStatus.EXPIRED);
  });

  it('ACCEPTED con vigencia pasada se reinterpreta como EXPIRED', () => {
    expect(
      effectiveStatus(QuoteStatus.ACCEPTED, '2026-03-14', '2026-03-15'),
    ).toBe(QuoteStatus.EXPIRED);
  });

  it('ACCEPTED con vigencia vigente permanece ACCEPTED', () => {
    expect(
      effectiveStatus(QuoteStatus.ACCEPTED, '2026-03-20', '2026-03-15'),
    ).toBe(QuoteStatus.ACCEPTED);
  });

  it('REJECTED permanece REJECTED sin importar la fecha', () => {
    expect(
      effectiveStatus(QuoteStatus.REJECTED, '2020-01-01', '2026-03-15'),
    ).toBe(QuoteStatus.REJECTED);
  });

  it('CONVERTED permanece CONVERTED sin importar la fecha', () => {
    expect(
      effectiveStatus(QuoteStatus.CONVERTED, '2020-01-01', '2026-03-15'),
    ).toBe(QuoteStatus.CONVERTED);
  });

  it('EXPIRED almacenado permanece EXPIRED', () => {
    expect(
      effectiveStatus(QuoteStatus.EXPIRED, '2099-01-01', '2026-03-15'),
    ).toBe(QuoteStatus.EXPIRED);
  });
});

describe('buildEffectiveQuoteStatusCondition', () => {
  const BUSINESS_DATE_AS_DATE = new Date('2026-03-15T00:00:00.000Z');

  it('EXPIRED: OR entre status=EXPIRED (nunca persistido hoy, pero se mantiene correcto) y PENDING/ACCEPTED vencidas', () => {
    expect(
      buildEffectiveQuoteStatusCondition(
        QuoteStatus.EXPIRED,
        BUSINESS_DATE_AS_DATE,
      ),
    ).toEqual({
      OR: [
        { status: QuoteStatus.EXPIRED },
        {
          status: { in: [QuoteStatus.PENDING, QuoteStatus.ACCEPTED] },
          expirationDate: { lt: BUSINESS_DATE_AS_DATE },
        },
      ],
    });
  });

  it('PENDING: excluye las vencidas (expirationDate >= fecha de negocio)', () => {
    expect(
      buildEffectiveQuoteStatusCondition(
        QuoteStatus.PENDING,
        BUSINESS_DATE_AS_DATE,
      ),
    ).toEqual({
      status: QuoteStatus.PENDING,
      expirationDate: { gte: BUSINESS_DATE_AS_DATE },
    });
  });

  it('ACCEPTED: excluye las vencidas (expirationDate >= fecha de negocio)', () => {
    expect(
      buildEffectiveQuoteStatusCondition(
        QuoteStatus.ACCEPTED,
        BUSINESS_DATE_AS_DATE,
      ),
    ).toEqual({
      status: QuoteStatus.ACCEPTED,
      expirationDate: { gte: BUSINESS_DATE_AS_DATE },
    });
  });

  it('REJECTED: igualdad directa, sin importar la fecha de negocio', () => {
    expect(
      buildEffectiveQuoteStatusCondition(
        QuoteStatus.REJECTED,
        BUSINESS_DATE_AS_DATE,
      ),
    ).toEqual({ status: QuoteStatus.REJECTED });
  });

  it('CONVERTED: igualdad directa, sin importar la fecha de negocio', () => {
    expect(
      buildEffectiveQuoteStatusCondition(
        QuoteStatus.CONVERTED,
        BUSINESS_DATE_AS_DATE,
      ),
    ).toEqual({ status: QuoteStatus.CONVERTED });
  });

  it('coherencia con effectiveStatus(): una PENDING vencida cae en la condición EXPIRED y no en la condición PENDING', () => {
    const expirationDate = new Date('2026-03-14T00:00:00.000Z'); // antes de BUSINESS_DATE_AS_DATE
    // effectiveStatus() ya clasifica esta combinación como EXPIRED (ver
    // describe('effectiveStatus') más arriba); esta prueba verifica que la
    // condición de filtro concuerda con esa misma clasificación:
    expect(
      effectiveStatus(QuoteStatus.PENDING, '2026-03-14', '2026-03-15'),
    ).toBe(QuoteStatus.EXPIRED);
    const expiredCondition = buildEffectiveQuoteStatusCondition(
      QuoteStatus.EXPIRED,
      BUSINESS_DATE_AS_DATE,
    );
    const pendingCondition = buildEffectiveQuoteStatusCondition(
      QuoteStatus.PENDING,
      BUSINESS_DATE_AS_DATE,
    );
    // La rama PENDING/ACCEPTED vencida de la condición EXPIRED cubre
    // exactamente expirationDate < fecha de negocio.
    expect(expiredCondition).toMatchObject({
      OR: [
        {},
        {
          status: { in: [QuoteStatus.PENDING, QuoteStatus.ACCEPTED] },
          expirationDate: { lt: BUSINESS_DATE_AS_DATE },
        },
      ],
    });
    expect(expirationDate.getTime()).toBeLessThan(
      BUSINESS_DATE_AS_DATE.getTime(),
    );
    // La condición PENDING exige expirationDate >= fecha de negocio: la
    // misma cotización vencida queda excluida de ese filtro.
    expect(pendingCondition).toEqual({
      status: QuoteStatus.PENDING,
      expirationDate: { gte: BUSINESS_DATE_AS_DATE },
    });
  });
});

describe('assertEditable', () => {
  it('PENDING efectivo: no lanza', () => {
    expect(() => assertEditable(QuoteStatus.PENDING)).not.toThrow();
  });

  it.each([
    QuoteStatus.ACCEPTED,
    QuoteStatus.REJECTED,
    QuoteStatus.EXPIRED,
    QuoteStatus.CONVERTED,
  ])('%s efectivo: ConflictException', (status) => {
    expect(() => assertEditable(status)).toThrow(ConflictException);
  });
});

describe('assertAcceptable', () => {
  it('PENDING efectivo: no lanza', () => {
    expect(() => assertAcceptable(QuoteStatus.PENDING)).not.toThrow();
  });

  it.each([
    QuoteStatus.ACCEPTED,
    QuoteStatus.REJECTED,
    QuoteStatus.EXPIRED,
    QuoteStatus.CONVERTED,
  ])('%s efectivo: ConflictException', (status) => {
    expect(() => assertAcceptable(status)).toThrow(ConflictException);
  });
});

describe('assertRejectable', () => {
  it('PENDING efectivo: no lanza', () => {
    expect(() => assertRejectable(QuoteStatus.PENDING)).not.toThrow();
  });

  it.each([
    QuoteStatus.ACCEPTED,
    QuoteStatus.REJECTED,
    QuoteStatus.EXPIRED,
    QuoteStatus.CONVERTED,
  ])('%s efectivo: ConflictException', (status) => {
    expect(() => assertRejectable(status)).toThrow(ConflictException);
  });
});
