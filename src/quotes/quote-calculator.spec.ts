import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, QuoteStatus } from '@prisma/client';
import {
  QUOTE_TAX_AMOUNT,
  assertAcceptable,
  assertDiscountWithinSubtotal,
  assertEditable,
  assertQuantityAllowedForUnit,
  assertRejectable,
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
