import { PurchaseReceiptStatus } from '@prisma/client';

/** R2-B2: ubicación de destino de la línea (sin importes). */
export interface SafeReceiptLineLocation {
  id: string;
  code: string;
  name: string;
  warehouse: { id: string; code: string };
}

export interface SafePurchaseReceiptLine {
  id: string;
  purchaseInvoiceLineId: string;
  quantity: string;
  /** R2-B2: null en recepciones históricas (anteriores a R2-ACT). Visible para todos los roles lectores. */
  location: SafeReceiptLineLocation | null;
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
