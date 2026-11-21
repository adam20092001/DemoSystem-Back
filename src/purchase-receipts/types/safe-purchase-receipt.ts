import { PurchaseReceiptStatus } from '@prisma/client';

export interface SafePurchaseReceiptLine {
  id: string;
  purchaseInvoiceLineId: string;
  quantity: string;
  /** NULL cuando esta línea no disparó reclasificación contable. */
  /** R1: se OMITE (la clave no existe) para roles sin visibilidad financiera (WAREHOUSE). */
  reclassifiedAmount?: string | null;
}

/** Respuesta segura de PurchaseReceipt (sin costos/montos de factura). */
export interface SafePurchaseReceipt {
  id: string;
  purchaseInvoiceId: string;
  receivedDate: string;
  status: PurchaseReceiptStatus;
  idempotencyKey: string | null;
  notes: string | null;
  createdByUserId: string;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancellationReason: string | null;
  /** R1: se OMITE (la clave no existe) para roles sin visibilidad financiera (WAREHOUSE). */
  reclassificationEntryId?: string | null;
  createdAt: Date;
  updatedAt: Date;
  lines: SafePurchaseReceiptLine[];
}
