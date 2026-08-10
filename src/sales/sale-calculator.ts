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
 * Derivación PURA del resumen de pago (D1/D18/D32 del plan aprobado). Sin
 * modelo Payment en la Fase 6: nunca produce PARTIALLY_PAID de forma
 * operativa — ese valor solo existe en el esquema para que la Fase 7 no
 * requiera migrar el enum ni el CHECK sales_payment_status_consistency.
 */
export function deriveSalePaymentSummary(
  total: Prisma.Decimal,
): SalePaymentSummary {
  if (total.equals(0)) {
    return {
      paymentStatus: SalePaymentStatus.PAID,
      paidAmount: new Prisma.Decimal(0),
      balanceDue: new Prisma.Decimal(0),
    };
  }
  return {
    paymentStatus: SalePaymentStatus.UNPAID,
    paidAmount: new Prisma.Decimal(0),
    balanceDue: total,
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
