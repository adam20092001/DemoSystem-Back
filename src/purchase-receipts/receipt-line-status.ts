import { Prisma } from '@prisma/client';

/**
 * Fase A5.2b: clasificación derivada, nunca persistida — mismo criterio
 * exacto que StockStatus (NR-04). Calculada siempre a partir de la suma de
 * PurchaseReceiptLine.quantity de recepciones ACTIVE contra el
 * PurchaseInvoiceLine.quantity facturado, nunca de una columna propia.
 */
export type PurchaseInvoiceLineReceiptStatus =
  'PENDING' | 'PARTIAL' | 'COMPLETE';

/**
 * receivedQuantity <= 0 -> PENDING; receivedQuantity >= invoicedQuantity ->
 * COMPLETE; en cualquier otro caso -> PARTIAL. PURA: solo Prisma.Decimal,
 * sin acceso a base de datos.
 */
export function computeReceiptLineStatus(
  receivedQuantity: Prisma.Decimal,
  invoicedQuantity: Prisma.Decimal,
): PurchaseInvoiceLineReceiptStatus {
  if (receivedQuantity.lessThanOrEqualTo(0)) {
    return 'PENDING';
  }
  if (receivedQuantity.greaterThanOrEqualTo(invoicedQuantity)) {
    return 'COMPLETE';
  }
  return 'PARTIAL';
}
