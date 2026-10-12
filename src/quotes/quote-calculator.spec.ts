import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma, QuoteStatus } from '@prisma/client';
import {
  assertAcceptable,
  assertDiscountWithinConfiguredLimit,
  assertDiscountWithinSubtotal,
  assertEditable,
  assertQuantityAllowedForUnit,
  assertRejectable,
  buildEffectiveQuoteStatusCondition,
  calculateLineTotal,
  calculateSubtotal,
  calculateTaxableBase,
  calculateTaxAmount,
  calculateTaxInclusiveTotals,
  calculateTotal,
  effectiveStatus,
  parseDiscountAmount,
  parseQuantity,
  TaxInclusiveTotals,
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
  const ZERO_TAX = new Prisma.Decimal(0);

  it('subtotal - descuento + impuesto (impuesto 0, IGV deshabilitado)', () => {
    const result = calculateTotal(
      new Prisma.Decimal('100.00'),
      new Prisma.Decimal('10.00'),
      ZERO_TAX,
    );
    expect(result.toFixed(2)).toBe('90.00');
  });

  it('sin descuento', () => {
    const result = calculateTotal(
      new Prisma.Decimal('50.00'),
      new Prisma.Decimal('0'),
      ZERO_TAX,
    );
    expect(result.toFixed(2)).toBe('50.00');
  });

  it('descuento igual al subtotal produce total exactamente 0.00', () => {
    const result = calculateTotal(
      new Prisma.Decimal('75.00'),
      new Prisma.Decimal('75.00'),
      ZERO_TAX,
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('con impuesto no-cero (Fase 10, Bloque C): subtotal - descuento + impuesto', () => {
    const result = calculateTotal(
      new Prisma.Decimal('100.00'),
      new Prisma.Decimal('10.00'),
      new Prisma.Decimal('16.20'),
    );
    expect(result.toFixed(2)).toBe('106.20');
  });

  it('invariante total + descuento = subtotal + impuesto', () => {
    const subtotal = new Prisma.Decimal('100.00');
    const discountAmount = new Prisma.Decimal('10.00');
    const taxAmount = new Prisma.Decimal('16.20');
    const total = calculateTotal(subtotal, discountAmount, taxAmount);
    expect(total.plus(discountAmount).toFixed(2)).toBe(
      subtotal.plus(taxAmount).toFixed(2),
    );
  });
});

describe('calculateTaxableBase (Fase 10, Bloque C)', () => {
  it('subtotal - discountAmount', () => {
    const result = calculateTaxableBase(
      new Prisma.Decimal('100.00'),
      new Prisma.Decimal('10.00'),
    );
    expect(result.toFixed(2)).toBe('90.00');
  });

  it('sin descuento: taxableBase = subtotal', () => {
    const result = calculateTaxableBase(
      new Prisma.Decimal('50.00'),
      new Prisma.Decimal('0'),
    );
    expect(result.toFixed(2)).toBe('50.00');
  });

  it('descuento total: taxableBase = 0.00', () => {
    const result = calculateTaxableBase(
      new Prisma.Decimal('100.00'),
      new Prisma.Decimal('100.00'),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });
});

describe('calculateTaxAmount (Fase 10, Bloque C)', () => {
  it('taxEnabled=false -> 0.00 sin importar taxRate (18)', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('100.00'),
      false,
      new Prisma.Decimal('18.00'),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('taxEnabled=false -> 0.00 con taxRate=0', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('100.00'),
      false,
      new Prisma.Decimal('0.00'),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('taxEnabled=false -> 0.00 con taxRate=99.99', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('100.00'),
      false,
      new Prisma.Decimal('99.99'),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('taxEnabled=true, 18% normal', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('100.00'),
      true,
      new Prisma.Decimal('18.00'),
    );
    expect(result.toFixed(2)).toBe('18.00');
  });

  it('taxEnabled=true, taxableBase=0 (descuento total) -> 0.00, sin anomalía', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('0.00'),
      true,
      new Prisma.Decimal('18.00'),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });

  it('taxEnabled=true, taxRate=100.00', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('50.00'),
      true,
      new Prisma.Decimal('100.00'),
    );
    expect(result.toFixed(2)).toBe('50.00');
  });

  it('redondeo: caso claramente por debajo de la mitad (3.333 -> 3.33)', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('10.00'),
      true,
      new Prisma.Decimal('33.33'),
    );
    expect(result.toFixed(2)).toBe('3.33');
  });

  it("redondeo: caso EXACTAMENTE en la mitad (2.005 -> 2.01, HALF_UP nunca banker's rounding)", () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('50.00'),
      true,
      new Prisma.Decimal('4.01'),
    );
    expect(result.toFixed(2)).toBe('2.01');
  });

  it('redondeo: caso claramente por encima de la mitad, con acarreo (5.9994 -> 6.00)', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('33.33'),
      true,
      new Prisma.Decimal('18.00'),
    );
    expect(result.toFixed(2)).toBe('6.00');
  });

  it('nunca usa Number()/parseFloat(): resultado sigue siendo instancia de Prisma.Decimal', () => {
    const result = calculateTaxAmount(
      new Prisma.Decimal('100.00'),
      true,
      new Prisma.Decimal('18.00'),
    );
    expect(result).toBeInstanceOf(Prisma.Decimal);
  });
});

describe('calculateTaxInclusiveTotals (R2-B2)', () => {
  const D = (value: string | number) => new Prisma.Decimal(value);
  const IGV = D('18.00');
  const NO_LIMIT = D('100.00');

  function line(quantity: string, unitPrice: string): Prisma.Decimal {
    return calculateLineTotal(D(quantity), D(unitPrice));
  }

  function run(
    lineTotals: Prisma.Decimal[],
    customerDiscount = '0',
    taxEnabled = true,
    taxRate: Prisma.Decimal = IGV,
    maxDiscountPercent: Prisma.Decimal = NO_LIMIT,
  ): TaxInclusiveTotals {
    return calculateTaxInclusiveTotals({
      lineTotals,
      customerDiscount: D(customerDiscount),
      taxEnabled,
      taxRate,
      maxDiscountPercent,
    });
  }

  function fixed(result: TaxInclusiveTotals) {
    return {
      itemsTotal: result.itemsTotal.toFixed(2),
      subtotal: result.subtotal.toFixed(2),
      discountAmount: result.discountAmount.toFixed(2),
      taxableBase: result.taxableBase.toFixed(2),
      taxAmount: result.taxAmount.toFixed(2),
      total: result.total.toFixed(2),
    };
  }

  describe('escenarios aprobados (montos exactos)', () => {
    it.each([
      [
        '118.00 al 18%',
        () => run([line('1', '118.00')]),
        ['118.00', '100.00', '0.00', '100.00', '18.00', '118.00'],
      ],
      [
        '10.00 al 18% (nunca 9.99)',
        () => run([line('1', '10.00')]),
        ['10.00', '8.47', '0.00', '8.47', '1.53', '10.00'],
      ],
      [
        '2 × 10.00 (base a nivel de DOCUMENTO, no por línea)',
        () => run([line('2', '10.00')]),
        ['20.00', '16.95', '0.00', '16.95', '3.05', '20.00'],
      ],
      [
        '118.00 + 10.00',
        () => run([line('1', '118.00'), line('1', '10.00')]),
        ['128.00', '108.47', '0.00', '108.47', '19.53', '128.00'],
      ],
      [
        '1.5 × 10.00',
        () => run([line('1.5', '10.00')]),
        ['15.00', '12.71', '0.00', '12.71', '2.29', '15.00'],
      ],
      [
        '0.333 × 10.00',
        () => run([line('0.333', '10.00')]),
        ['3.33', '2.82', '0.00', '2.82', '0.51', '3.33'],
      ],
      [
        '118.00 con descuento 11.80',
        () => run([line('1', '118.00')], '11.80'),
        ['118.00', '100.00', '10.00', '90.00', '16.20', '106.20'],
      ],
      [
        '20.00 con descuento 1.00',
        () => run([line('2', '10.00')], '1.00'),
        ['20.00', '16.95', '0.85', '16.10', '2.90', '19.00'],
      ],
      [
        '118.00 con descuento del 100%',
        () => run([line('1', '118.00')], '118.00'),
        ['118.00', '100.00', '100.00', '0.00', '0.00', '0.00'],
      ],
      [
        '110.00 con IGV al 10%',
        () => run([line('1', '110.00')], '0', true, D('10.00')),
        ['110.00', '100.00', '0.00', '100.00', '10.00', '110.00'],
      ],
      [
        '118.00 con IGV desactivado',
        () => run([line('1', '118.00')], '0', false),
        ['118.00', '118.00', '0.00', '118.00', '0.00', '118.00'],
      ],
    ])('%s', (_label, compute, expected) => {
      const [
        itemsTotal,
        subtotal,
        discountAmount,
        taxableBase,
        taxAmount,
        total,
      ] = expected;
      expect(fixed(compute())).toEqual({
        itemsTotal,
        subtotal,
        discountAmount,
        taxableBase,
        taxAmount,
        total,
      });
    });
  });

  describe('casos borde', () => {
    it('documento sin montos (todo cero)', () => {
      expect(fixed(run([D('0.00')]))).toEqual({
        itemsTotal: '0.00',
        subtotal: '0.00',
        discountAmount: '0.00',
        taxableBase: '0.00',
        taxAmount: '0.00',
        total: '0.00',
      });
    });

    it('lista de líneas vacía: todo cero (sin lanzar)', () => {
      expect(run([]).total.toFixed(2)).toBe('0.00');
    });

    it('0.01 al 18%: base 0.01 e IGV 0.00 (nunca negativo)', () => {
      expect(fixed(run([D('0.01')]))).toMatchObject({
        taxableBase: '0.01',
        taxAmount: '0.00',
        total: '0.01',
      });
    });

    it('0.12 al 18%: base 0.10, IGV 0.02', () => {
      expect(fixed(run([D('0.12')]))).toMatchObject({
        taxableBase: '0.10',
        taxAmount: '0.02',
        total: '0.12',
      });
    });

    it('varias líneas con precisión decimal: total = suma exacta de líneas', () => {
      const result = run([
        line('3', '19.99'),
        line('0.125', '7.99'),
        line('2.500', '0.33'),
      ]);
      // 59.97 + 1.00 (0.99875 -> 1.00) + 0.83 (0.825 -> 0.83)
      expect(result.itemsTotal.toFixed(2)).toBe('61.80');
      expect(result.total.toFixed(2)).toBe('61.80');
      expect(result.taxableBase.toFixed(2)).toBe('52.37');
      expect(result.taxAmount.toFixed(2)).toBe('9.43');
    });

    it('tasa 0% con IGV activo: base = total, IGV 0', () => {
      expect(fixed(run([D('50.00')], '0', true, D('0.00')))).toMatchObject({
        taxableBase: '50.00',
        taxAmount: '0.00',
      });
    });

    it('tasa límite 100% aceptada por la configuración: divisor 2', () => {
      expect(fixed(run([D('10.00')], '0', true, D('100.00')))).toMatchObject({
        taxableBase: '5.00',
        taxAmount: '5.00',
      });
    });

    it('tasa con decimales (12.50%)', () => {
      expect(fixed(run([D('112.50')], '0', true, D('12.50')))).toMatchObject({
        taxableBase: '100.00',
        taxAmount: '12.50',
      });
    });

    it('IGV desactivado ignora la tasa configurada (incluso fuera de rango)', () => {
      expect(fixed(run([D('10.00')], '0', false, D('999')))).toMatchObject({
        taxableBase: '10.00',
        taxAmount: '0.00',
      });
    });

    it('importe máximo representable: suma exacta, sin desborde', () => {
      const result = run([D('999999999999.99')]);
      expect(result.total.toFixed(2)).toBe('999999999999.99');
      expect(
        result.taxableBase.plus(result.taxAmount).equals(result.total),
      ).toBe(true);
    });
  });

  describe('descuento existente (sin reglas nuevas)', () => {
    it('máximo configurado 10%: 11.80 sobre 118.00 se acepta', () => {
      expect(
        run([D('118.00')], '11.80', true, IGV, D('10.00')).total.toFixed(2),
      ).toBe('106.20');
    });

    it('máximo configurado 10%: 11.81 sobre 118.00 se rechaza con el error existente', () => {
      expect(() => run([D('118.00')], '11.81', true, IGV, D('10.00'))).toThrow(
        new BadRequestException(
          'El descuento supera el porcentaje máximo permitido por la configuración de la empresa',
        ),
      );
    });

    it('descuento mayor que el total de ítems -> 400 (regla existente)', () => {
      expect(() => run([D('118.00')], '118.01')).toThrow(
        new BadRequestException('El descuento no puede superar el subtotal'),
      );
    });

    it('descuento negativo -> 400', () => {
      expect(() => run([D('10.00')], '-1.00')).toThrow(BadRequestException);
    });

    it('descuento con más de 2 decimales -> 400', () => {
      expect(() => run([D('10.00')], '1.001')).toThrow(BadRequestException);
    });
  });

  describe('invariantes internas (409)', () => {
    it('lineTotal negativo -> 409', () => {
      expect(() => run([D('-1.00')])).toThrow(ConflictException);
    });

    it('lineTotal con más de 2 decimales -> 409', () => {
      expect(() => run([D('1.005')])).toThrow(ConflictException);
    });

    it('tasa activa fuera de 0-100 -> 409', () => {
      expect(() => run([D('10.00')], '0', true, D('100.01'))).toThrow(
        ConflictException,
      );
      expect(() => run([D('10.00')], '0', true, D('-1'))).toThrow(
        ConflictException,
      );
    });
  });

  describe('pureza y determinismo', () => {
    it('no muta las entradas', () => {
      const lineTotals = Object.freeze([D('10.00'), D('5.55')]);
      const customerDiscount = D('1.00');
      const before = lineTotals.map((value) => value.toString());

      calculateTaxInclusiveTotals({
        lineTotals,
        customerDiscount,
        taxEnabled: true,
        taxRate: IGV,
        maxDiscountPercent: NO_LIMIT,
      });

      expect(lineTotals.map((value) => value.toString())).toEqual(before);
      expect(customerDiscount.toString()).toBe('1');
    });

    it('mismo input -> mismo resultado', () => {
      const first = fixed(run([D('33.33'), D('66.67')], '7.77'));
      const second = fixed(run([D('33.33'), D('66.67')], '7.77'));
      expect(second).toEqual(first);
    });
  });

  describe('invariantes sistemáticas (detecta errores de 1 céntimo)', () => {
    // Oráculo independiente: decimal.js con 60 dígitos de precisión, sin
    // pasar por la corrección exacta de la implementación.
    const Oracle = Prisma.Decimal.clone({ precision: 60 });
    function oracleRound(numerator: Prisma.Decimal, divisor: Prisma.Decimal) {
      return new Oracle(numerator.toString())
        .dividedBy(new Oracle(divisor.toString()))
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP)
        .toFixed(2);
    }

    function assertInvariants(
      result: TaxInclusiveTotals,
      itemsTotal: Prisma.Decimal,
      customerDiscount: Prisma.Decimal,
      divisor: Prisma.Decimal,
    ): void {
      const values = [
        result.itemsTotal,
        result.subtotal,
        result.discountAmount,
        result.taxAmount,
        result.taxableBase,
        result.total,
      ];
      for (const value of values) {
        if (value.lessThan(0) || value.decimalPlaces() > 2) {
          throw new Error(`monto inválido ${value.toString()}`);
        }
      }
      const checks: [string, boolean][] = [
        [
          'total = itemsTotal - customerDiscount',
          result.total.equals(itemsTotal.minus(customerDiscount)),
        ],
        [
          'total = subtotal - discountAmount + taxAmount',
          result.total.equals(
            result.subtotal.minus(result.discountAmount).plus(result.taxAmount),
          ),
        ],
        [
          'taxableBase = subtotal - discountAmount',
          result.taxableBase.equals(
            result.subtotal.minus(result.discountAmount),
          ),
        ],
        [
          'total = taxableBase + taxAmount',
          result.total.equals(result.taxableBase.plus(result.taxAmount)),
        ],
        [
          'discountAmount <= subtotal',
          result.discountAmount.lessThanOrEqualTo(result.subtotal),
        ],
        [
          'taxableBase = ROUND_HALF_UP(total/divisor)',
          result.taxableBase.toFixed(2) === oracleRound(result.total, divisor),
        ],
        [
          'discountAmount = ROUND_HALF_UP(discount/divisor)',
          result.discountAmount.toFixed(2) ===
            oracleRound(customerDiscount, divisor),
        ],
      ];
      for (const [name, ok] of checks) {
        if (!ok) {
          throw new Error(
            `${name} falla: itemsTotal=${itemsTotal.toString()} descuento=${customerDiscount.toString()} divisor=${divisor.toString()}`,
          );
        }
      }
    }

    const RATES: [boolean, Prisma.Decimal][] = [
      [true, D('18.00')],
      [true, D('10.00')],
      [true, D('12.50')],
      [true, D('100.00')],
      [false, D('18.00')],
    ];

    it('todos los importes de 0.00 a 25.00 (céntimo a céntimo) × 5 tasas × 4 descuentos', () => {
      let evaluated = 0;
      for (let cents = 0; cents <= 2500; cents += 1) {
        const itemsTotal = D(cents).dividedBy(100);
        const discounts = [
          D(0),
          cents > 0 ? D('0.01') : D(0),
          D(Math.floor(cents / 7)).dividedBy(100),
          itemsTotal,
        ];
        for (const [taxEnabled, taxRate] of RATES) {
          const divisor = taxEnabled ? D(1).plus(taxRate.dividedBy(100)) : D(1);
          for (const customerDiscount of discounts) {
            const result = calculateTaxInclusiveTotals({
              lineTotals: [itemsTotal],
              customerDiscount,
              taxEnabled,
              taxRate,
              maxDiscountPercent: NO_LIMIT,
            });
            assertInvariants(result, itemsTotal, customerDiscount, divisor);
            evaluated += 1;
          }
        }
      }
      expect(evaluated).toBe(2501 * 5 * 4);
    });

    it('importes grandes cerca del máximo representable (12 enteros)', () => {
      const bases = [
        '999999999999.99',
        '999999999999.98',
        '123456789012.34',
        '847457627118.64',
        '500000000000.01',
      ];
      for (const base of bases) {
        for (let offset = 0; offset < 40; offset += 1) {
          const itemsTotal = D(base).minus(D(offset).dividedBy(100));
          const customerDiscount = D(offset).dividedBy(100);
          for (const [taxEnabled, taxRate] of RATES) {
            const divisor = taxEnabled
              ? D(1).plus(taxRate.dividedBy(100))
              : D(1);
            const result = calculateTaxInclusiveTotals({
              lineTotals: [itemsTotal],
              customerDiscount,
              taxEnabled,
              taxRate,
              maxDiscountPercent: NO_LIMIT,
            });
            assertInvariants(result, itemsTotal, customerDiscount, divisor);
          }
        }
      }
    });
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
