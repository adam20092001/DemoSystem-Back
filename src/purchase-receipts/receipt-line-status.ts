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

/**
 * Cantidades de recepción de UNA línea de factura, derivadas en tiempo de
 * lectura (nunca persistidas): única fuente del cálculo "facturado vs.
 * recibido ACTIVE vs. pendiente", compartida por el resumen de recepciones
 * de una factura y por la vista de recepción de almacén (R1), para que
 * ambas nunca diverjan. La cantidad pendiente nunca es negativa.
 */
export interface ReceiptLineQuantities {
  invoicedQuantity: string;
  receivedQuantity: string;
  pendingQuantity: string;
  status: PurchaseInvoiceLineReceiptStatus;
}

export function computeReceiptLineQuantities(
  receivedQuantity: Prisma.Decimal,
  invoicedQuantity: Prisma.Decimal,
): ReceiptLineQuantities {
  const pending = invoicedQuantity.minus(receivedQuantity);
  return {
    invoicedQuantity: invoicedQuantity.toFixed(3),
    receivedQuantity: receivedQuantity.toFixed(3),
    pendingQuantity: (pending.lessThan(0)
      ? new Prisma.Decimal(0)
      : pending
    ).toFixed(3),
    status: computeReceiptLineStatus(receivedQuantity, invoicedQuantity),
  };
}
