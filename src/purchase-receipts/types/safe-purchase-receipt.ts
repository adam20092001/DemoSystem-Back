import { PurchaseReceiptStatus } from '@prisma/client';

export interface SafePurchaseReceiptLine {
  id: string;
  purchaseInvoiceLineId: string;
  quantity: string;
  /** NULL cuando esta línea no disparó reclasificación contable. */
  reclassifiedAmount: string | null;
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
  reclassificationEntryId: string | null;
  createdAt: Date;
  updatedAt: Date;
  lines: SafePurchaseReceiptLine[];
}
