import { ConflictException } from '@nestjs/common';
import { Prisma, SaleDeliveryStatus, SalePaymentStatus } from '@prisma/client';

/**
 * Reutiliza las primitivas Decimal PURAS de quote-calculator.ts
 * (parseQuantity/parseDiscountAmount/assertQuantityAllowedForUnit/
 * calculateLineTotal/calculateSubtotal/assertDiscountWithinSubtotal/
 * calculateTotal) en vez de duplicarlas: ninguna depende de QuoteStatus ni
 * de ningún estado propio de Cotizaciones — son aritmética Decimal(14,2)/
 * Decimal(14,3) con las mismas reglas de redondeo (HALF_UP) y los mismos
 * patrones textuales estrictos exigidos para Ventas (Bloque B, Fase 6). No
 * se modifica quote-calculator.ts. Duplicarlas aquí arriesgaría que ambas
 * fases divergieran silenciosamente en el redondeo comercial; reexportarlas
 * mantiene una única fuente de verdad para "cómo se calcula una línea".
 * effectiveStatus()/assertEditable()/assertAcceptable()/assertRejectable()
 * de quote-calculator.ts SÍ son específicos de QuoteStatus y
 * deliberadamente no se reutilizan aquí.
 */
export {
  parseQuantity,
  parseDiscountAmount,
  assertQuantityAllowedForUnit,
  calculateLineTotal,
  calculateSubtotal,
  assertDiscountWithinSubtotal,
  calculateTotal,
} from '../quotes/quote-calculator';

/** IGV siempre 0.00 en la Fase 6 (mismo criterio D5 heredado de Quotes/Fase 5). */
export const SALE_TAX_AMOUNT: Prisma.Decimal = new Prisma.Decimal(0);

export interface SalePaymentSummary {
  paymentStatus: SalePaymentStatus;
  paidAmount: Prisma.Decimal;
  balanceDue: Prisma.Decimal;
}

/**
 * Derivación PURA del resumen de pago (D1/D18/D32 del plan de la Fase 6;
 * generalizada en la Fase 7, Bloque B, para reconciliar contra
 * SUM(Payment ACTIVE)). `paidAmount` por defecto 0.00 preserva EXACTAMENTE
 * el comportamiento de la Fase 6 cuando se invoca con un solo argumento
 * (deriveSalePaymentSummary(total)): total=0 -> PAID/0/0; total>0 -> UNPAID/
 * 0/total. Con paidAmount explícito (Fase 7): paidAmount==total -> PAID
 * (cubre también total=0/paidAmount=0, evaluado primero); paidAmount==0 y
 * total>0 -> UNPAID; en cualquier otro caso -> PARTIALLY_PAID. paidAmount
 * fuera de rango (negativo o mayor que el total) es un invariante interno
 * roto, nunca un error de payload del cliente: 409, no 400, mismo criterio
 * que assertMoneyWithinRange más arriba en este archivo.
 */
export function deriveSalePaymentSummary(
  total: Prisma.Decimal,
  paidAmount: Prisma.Decimal = new Prisma.Decimal(0),
): SalePaymentSummary {
  if (paidAmount.lessThan(0)) {
    throw new ConflictException('El monto pagado no puede ser negativo');
  }
  if (paidAmount.greaterThan(total)) {
    throw new ConflictException(
      'El monto pagado no puede superar el total de la venta',
    );
  }
  if (paidAmount.equals(total)) {
    return {
      paymentStatus: SalePaymentStatus.PAID,
      paidAmount,
      balanceDue: new Prisma.Decimal(0),
    };
  }
  if (paidAmount.equals(0)) {
    return {
      paymentStatus: SalePaymentStatus.UNPAID,
      paidAmount,
      balanceDue: total,
    };
  }
  return {
    paymentStatus: SalePaymentStatus.PARTIALLY_PAID,
    paidAmount,
    balanceDue: total.minus(paidAmount),
  };
}

/**
 * Estado de entrega por defecto al confirmar (D12/D33): algún ítem con
 * Product.isInventoryTracked=true VIGENTE al momento de la confirmación
 * implica PENDING; si ninguno lo tiene, NOT_APPLICABLE. Nunca se deriva de
 * ProductType (un PRODUCT puede legítimamente no ser inventariable).
 */
export function deriveDeliveryStatus(
  hasCurrentlyTrackedItem: boolean,
): SaleDeliveryStatus {
  return hasCurrentlyTrackedItem
    ? SaleDeliveryStatus.PENDING
    : SaleDeliveryStatus.NOT_APPLICABLE;
}
