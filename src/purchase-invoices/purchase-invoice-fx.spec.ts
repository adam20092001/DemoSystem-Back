import { Prisma } from '@prisma/client';
import {
  computeCarryingBase,
  convertLineToBase,
  distributeProportionally,
  parseExchangeRate,
  resolveDocumentCurrency,
  toBaseAmount,
} from './purchase-invoice-fx';

const d = (v: string): Prisma.Decimal => new Prisma.Decimal(v);

describe('purchase-invoice-fx (R4)', () => {
  describe('resolveDocumentCurrency', () => {
    it('sin moneda: usa la de la empresa con tasa 1', () => {
      const r = resolveDocumentCurrency({}, 'PEN', '2026-11-23');
      expect(r).toMatchObject({
        currencyCode: 'PEN',
        baseCurrencyCode: 'PEN',
        isForeign: false,
        exchangeRateDate: '2026-11-23',
      });
      expect(r.exchangeRate.equals(1)).toBe(true);
    });

    it('moneda igual a la de la empresa con tasa 1 explícita: acepta', () => {
      const r = resolveDocumentCurrency(
        { currencyCode: 'pen', exchangeRate: '1.00000000' },
        'PEN',
        '2026-11-23',
      );
      expect(r.isForeign).toBe(false);
    });

    it('moneda igual a la de la empresa con otra tasa: 400 (no se ignora)', () => {
      expect(() =>
        resolveDocumentCurrency(
          { currencyCode: 'PEN', exchangeRate: '3.70' },
          'PEN',
          '2026-11-23',
        ),
      ).toThrow(/tipo de cambio es 1/);
    });

    it('moneda distinta sin tasa: tasa obligatoria', () => {
      expect(() =>
        resolveDocumentCurrency({ currencyCode: 'USD' }, 'PEN', '2026-11-23'),
      ).toThrow(/obligatorio/);
    });

    it('moneda distinta con tasa: extranjera, fecha por defecto o indicada', () => {
      const r = resolveDocumentCurrency(
        {
          currencyCode: 'usd',
          exchangeRate: '3.70',
          exchangeRateDate: '2026-11-20',
        },
        'PEN',
        '2026-11-23',
      );
      expect(r).toMatchObject({
        currencyCode: 'USD',
        isForeign: true,
        exchangeRateDate: '2026-11-20',
      });
      expect(r.exchangeRate.equals('3.7')).toBe(true);
    });

    it('funciona con una moneda de empresa distinta de PEN', () => {
      const r = resolveDocumentCurrency(
        { currencyCode: 'USD', exchangeRate: '0.92' },
        'EUR',
        '2026-11-23',
      );
      expect(r.baseCurrencyCode).toBe('EUR');
      expect(r.isForeign).toBe(true);
    });

    it('código de moneda inválido y fecha inválida: 400', () => {
      expect(() =>
        resolveDocumentCurrency({ currencyCode: 'US' }, 'PEN', '2026-11-23'),
      ).toThrow(/3 letras/);
      expect(() =>
        resolveDocumentCurrency(
          {
            currencyCode: 'USD',
            exchangeRate: '3.7',
            exchangeRateDate: '2026-13-40',
          },
          'PEN',
          '2026-11-23',
        ),
      ).toThrow(/fecha real/);
    });
  });

  describe('parseExchangeRate', () => {
    it.each(['0', '-1', 'abc', '0.000000001', '2000000'])(
      'rechaza %s',
      (value) => {
        expect(() => parseExchangeRate(value)).toThrow();
      },
    );

    it('acepta hasta 8 decimales', () => {
      expect(parseExchangeRate('3.12345678').toFixed()).toBe('3.12345678');
    });
  });

  describe('conversión exacta (Decimal, HALF_UP a 2 decimales)', () => {
    it('USD 1000 × 3.70 = PEN 3700.00', () => {
      expect(toBaseAmount(d('1000'), d('3.70')).toFixed(2)).toBe('3700.00');
    });

    it('redondea HALF_UP el céntimo', () => {
      expect(toBaseAmount(d('10.05'), d('3.333')).toFixed(2)).toBe('33.50');
      expect(toBaseAmount(d('0.01'), d('0.5')).toFixed(2)).toBe('0.01');
    });

    it('cada componente se convierte y el total de línea es base + impuesto', () => {
      const base = convertLineToBase(
        {
          taxableBaseAmount: d('100.00'),
          taxAmount: d('18.00'),
          creditableTaxAmount: d('18.00'),
          lineTotal: d('118.00'),
        },
        d('3.3333'),
      );
      expect(base.taxableBaseAmount.toFixed(2)).toBe('333.33');
      expect(base.taxAmount.toFixed(2)).toBe('60.00');
      expect(base.lineTotal.toFixed(2)).toBe('393.33');
      expect(
        base.taxableBaseAmount.plus(base.taxAmount).equals(base.lineTotal),
      ).toBe(true);
      expect(base.creditableTaxAmount.lessThanOrEqualTo(base.taxAmount)).toBe(
        true,
      );
    });
  });

  describe('distributeProportionally', () => {
    it('suma exactamente el total, con el residuo en la última asignación', () => {
      const parts = distributeProportionally(d('100.00'), [
        d('1'),
        d('1'),
        d('1'),
      ]);
      expect(parts.map((p) => p.toFixed(2))).toEqual([
        '33.33',
        '33.33',
        '33.34',
      ]);
      expect(parts.reduce((s, p) => s.plus(p), d('0')).toFixed(2)).toBe(
        '100.00',
      );
    });

    it('ignora pesos cero y sin pesos devuelve ceros', () => {
      expect(
        distributeProportionally(d('50.00'), [d('0'), d('2')]).map((p) =>
          p.toFixed(2),
        ),
      ).toEqual(['0.00', '50.00']);
      expect(distributeProportionally(d('5'), [])).toEqual([]);
    });
  });

  describe('computeCarryingBase (valor en libros cancelado)', () => {
    // Factura USD 1000 × 3.70 = PEN 3700.
    const invoice = {
      invoiceBaseTotal: d('3700.00'),
      invoiceOriginalTotal: d('1000.00'),
    };

    it('pago parcial proporcional a la tasa histórica de la factura', () => {
      expect(
        computeCarryingBase({
          ...invoice,
          alreadyPaidOriginal: d('0'),
          alreadyCarryingBase: d('0'),
          allocationOriginal: d('400.00'),
        }).toFixed(2),
      ).toBe('1480.00');
    });

    it('el pago que SALDA toma exactamente el residuo (sin céntimos huérfanos)', () => {
      const first = computeCarryingBase({
        invoiceBaseTotal: d('100.00'),
        invoiceOriginalTotal: d('30.00'),
        alreadyPaidOriginal: d('0'),
        alreadyCarryingBase: d('0'),
        allocationOriginal: d('10.00'),
      });
      const second = computeCarryingBase({
        invoiceBaseTotal: d('100.00'),
        invoiceOriginalTotal: d('30.00'),
        alreadyPaidOriginal: d('10.00'),
        alreadyCarryingBase: first,
        allocationOriginal: d('10.00'),
      });
      const last = computeCarryingBase({
        invoiceBaseTotal: d('100.00'),
        invoiceOriginalTotal: d('30.00'),
        alreadyPaidOriginal: d('20.00'),
        alreadyCarryingBase: first.plus(second),
        allocationOriginal: d('10.00'),
      });
      expect(first.plus(second).plus(last).toFixed(2)).toBe('100.00');
    });

    it('misma moneda (tasa 1): el valor en libros es el propio monto', () => {
      expect(
        computeCarryingBase({
          invoiceBaseTotal: d('150.00'),
          invoiceOriginalTotal: d('150.00'),
          alreadyPaidOriginal: d('50.00'),
          alreadyCarryingBase: d('50.00'),
          allocationOriginal: d('30.00'),
        }).toFixed(2),
      ).toBe('30.00');
    });
  });
});
