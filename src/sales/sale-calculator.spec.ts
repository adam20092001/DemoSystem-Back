import { Prisma, SaleDeliveryStatus, SalePaymentStatus } from '@prisma/client';
import {
  SALE_TAX_AMOUNT,
  assertDiscountWithinSubtotal,
  assertQuantityAllowedForUnit,
  calculateLineTotal,
  calculateSubtotal,
  calculateTotal,
  deriveDeliveryStatus,
  deriveSalePaymentSummary,
  parseDiscountAmount,
  parseQuantity,
} from './sale-calculator';

describe('sale-calculator (reexport de las primitivas Decimal de quote-calculator)', () => {
  describe('parseQuantity', () => {
    it('acepta un entero simple', () => {
      expect(parseQuantity('3').toString()).toBe('3');
    });

    it('acepta un decimal de hasta 3 posiciones', () => {
      expect(parseQuantity('1.250').toString()).toBe('1.25');
    });

    it.each(['0', '-1', '1e3', '1E3', '1,5', '1.2345', '999999999999'])(
      'rechaza forma malformada/inválida: %s',
      (value) => {
        expect(() => parseQuantity(value)).toThrow();
      },
    );

    it('rechaza cantidad que excede la capacidad de Decimal(14,3)', () => {
      expect(() => parseQuantity('999999999999.999')).toThrow();
    });
  });

  describe('assertQuantityAllowedForUnit', () => {
    it('unidad allowDecimal=false exige cantidad entera', () => {
      expect(() =>
        assertQuantityAllowedForUnit(new Prisma.Decimal('1.5'), false),
      ).toThrow();
      expect(() =>
        assertQuantityAllowedForUnit(new Prisma.Decimal('2'), false),
      ).not.toThrow();
    });

    it('unidad allowDecimal=true admite fraccionario', () => {
      expect(() =>
        assertQuantityAllowedForUnit(new Prisma.Decimal('1.5'), true),
      ).not.toThrow();
    });
  });

  describe('parseDiscountAmount', () => {
    it('ausente equivale a 0.00', () => {
      expect(parseDiscountAmount(undefined).toString()).toBe('0');
    });

    it('acepta hasta 2 decimales', () => {
      expect(parseDiscountAmount('10.50').toString()).toBe('10.5');
    });

    it.each(['-5.00', '1e2', '10,00', '10.999'])(
      'rechaza forma malformada: %s',
      (value) => {
        expect(() => parseDiscountAmount(value)).toThrow();
      },
    );
  });

  describe('calculateLineTotal (HALF_UP)', () => {
    it('redondea 0.500 * 0.01 = 0.005 hacia arriba (0.01)', () => {
      const result = calculateLineTotal(
        new Prisma.Decimal('0.500'),
        new Prisma.Decimal('0.01'),
      );
      expect(result.toFixed(2)).toBe('0.01');
    });

    it('precio cero produce línea cero', () => {
      const result = calculateLineTotal(
        new Prisma.Decimal('5.000'),
        new Prisma.Decimal('0.00'),
      );
      expect(result.toFixed(2)).toBe('0.00');
    });

    it('desbordamiento monetario lanza error controlado (409-shaped)', () => {
      expect(() =>
        calculateLineTotal(
          new Prisma.Decimal('2.000'),
          new Prisma.Decimal('999999999999.99'),
        ),
      ).toThrow();
    });
  });

  describe('calculateSubtotal', () => {
    it('suma líneas ya redondeadas sin volver a redondear', () => {
      const result = calculateSubtotal([
        new Prisma.Decimal('0.01'),
        new Prisma.Decimal('39.98'),
      ]);
      expect(result.toFixed(2)).toBe('39.99');
    });
  });

  describe('assertDiscountWithinSubtotal / calculateTotal', () => {
    it('discount = 0 -> total = subtotal', () => {
      const subtotal = new Prisma.Decimal('50.00');
      assertDiscountWithinSubtotal(new Prisma.Decimal('0.00'), subtotal);
      const total = calculateTotal(
        subtotal,
        new Prisma.Decimal('0.00'),
        SALE_TAX_AMOUNT,
      );
      expect(total.toFixed(2)).toBe('50.00');
    });

    it('discount = subtotal -> total = 0.00', () => {
      const subtotal = new Prisma.Decimal('20.00');
      assertDiscountWithinSubtotal(subtotal, subtotal);
      const total = calculateTotal(subtotal, subtotal, SALE_TAX_AMOUNT);
      expect(total.toFixed(2)).toBe('0.00');
    });

    it('discount > subtotal lanza error controlado', () => {
      expect(() =>
        assertDiscountWithinSubtotal(
          new Prisma.Decimal('999.00'),
          new Prisma.Decimal('10.00'),
        ),
      ).toThrow();
    });
  });

  describe('SALE_TAX_AMOUNT', () => {
    it('siempre 0.00', () => {
      expect(SALE_TAX_AMOUNT.toFixed(2)).toBe('0.00');
    });
  });

  describe('deriveSalePaymentSummary', () => {
    describe('sin segundo argumento (comportamiento exacto de la Fase 6)', () => {
      it('total > 0 -> UNPAID, paidAmount=0.00, balanceDue=total', () => {
        const summary = deriveSalePaymentSummary(new Prisma.Decimal('149.90'));
        expect(summary.paymentStatus).toBe(SalePaymentStatus.UNPAID);
        expect(summary.paidAmount.toFixed(2)).toBe('0.00');
        expect(summary.balanceDue.toFixed(2)).toBe('149.90');
      });

      it('total = 0 -> PAID, paidAmount=0.00, balanceDue=0.00', () => {
        const summary = deriveSalePaymentSummary(new Prisma.Decimal('0.00'));
        expect(summary.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(summary.paidAmount.toFixed(2)).toBe('0.00');
        expect(summary.balanceDue.toFixed(2)).toBe('0.00');
      });

      it('nunca produce PARTIALLY_PAID', () => {
        const positive = deriveSalePaymentSummary(new Prisma.Decimal('10.00'));
        const zero = deriveSalePaymentSummary(new Prisma.Decimal('0.00'));
        expect(positive.paymentStatus).not.toBe(
          SalePaymentStatus.PARTIALLY_PAID,
        );
        expect(zero.paymentStatus).not.toBe(SalePaymentStatus.PARTIALLY_PAID);
      });
    });

    describe('con paidAmount explícito (Fase 7, Bloque B)', () => {
      it('total=0, paidAmount=0 -> PAID/0.00/0.00 (evaluado como paidAmount==total)', () => {
        const summary = deriveSalePaymentSummary(
          new Prisma.Decimal('0.00'),
          new Prisma.Decimal('0.00'),
        );
        expect(summary.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(summary.paidAmount.toFixed(2)).toBe('0.00');
        expect(summary.balanceDue.toFixed(2)).toBe('0.00');
      });

      it('100/0 -> UNPAID, balanceDue=100.00', () => {
        const summary = deriveSalePaymentSummary(
          new Prisma.Decimal('100.00'),
          new Prisma.Decimal('0.00'),
        );
        expect(summary.paymentStatus).toBe(SalePaymentStatus.UNPAID);
        expect(summary.paidAmount.toFixed(2)).toBe('0.00');
        expect(summary.balanceDue.toFixed(2)).toBe('100.00');
      });

      it('100/40 -> PARTIALLY_PAID, balanceDue=60.00', () => {
        const summary = deriveSalePaymentSummary(
          new Prisma.Decimal('100.00'),
          new Prisma.Decimal('40.00'),
        );
        expect(summary.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
        expect(summary.paidAmount.toFixed(2)).toBe('40.00');
        expect(summary.balanceDue.toFixed(2)).toBe('60.00');
      });

      it('100/100 -> PAID, balanceDue=0.00', () => {
        const summary = deriveSalePaymentSummary(
          new Prisma.Decimal('100.00'),
          new Prisma.Decimal('100.00'),
        );
        expect(summary.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(summary.paidAmount.toFixed(2)).toBe('100.00');
        expect(summary.balanceDue.toFixed(2)).toBe('0.00');
      });

      it('paidAmount negativo -> ConflictException (invariante interno, nunca 400)', () => {
        expect(() =>
          deriveSalePaymentSummary(
            new Prisma.Decimal('100.00'),
            new Prisma.Decimal('-1.00'),
          ),
        ).toThrow();
      });

      it('paidAmount > total -> ConflictException (sobrepago, invariante interno)', () => {
        expect(() =>
          deriveSalePaymentSummary(
            new Prisma.Decimal('100.00'),
            new Prisma.Decimal('100.01'),
          ),
        ).toThrow();
      });
    });
  });

  describe('deriveDeliveryStatus', () => {
    it('algún ítem inventariable -> PENDING', () => {
      expect(deriveDeliveryStatus(true)).toBe(SaleDeliveryStatus.PENDING);
    });

    it('ningún ítem inventariable -> NOT_APPLICABLE', () => {
      expect(deriveDeliveryStatus(false)).toBe(
        SaleDeliveryStatus.NOT_APPLICABLE,
      );
    });
  });
});
