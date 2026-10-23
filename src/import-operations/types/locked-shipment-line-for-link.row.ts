import { Prisma } from '@prisma/client';

/** Fila bloqueada (`FOR UPDATE`) de import_shipment_lines + su embarque, para el vínculo de recepción (Fase B3). */
export interface LockedShipmentLineForLinkRow {
  id: string;
  plannedQuantity: Prisma.Decimal;
  productId: string | null;
  purchaseInvoiceLineId: string | null;
  shipmentStatus: string;
}

/** Fila bloqueada (`FOR UPDATE`) de purchase_receipt_lines + su recepción, para el vínculo de recepción (Fase B3). */
export interface LockedReceiptLineForLinkRow {
  id: string;
  quantity: Prisma.Decimal;
  purchaseInvoiceLineId: string;
  productId: string | null;
  receiptStatus: string;
}
