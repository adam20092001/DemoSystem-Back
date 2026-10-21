import { RoleName } from '@prisma/client';

export interface CreatePurchaseReceiptLineInput {
  purchaseInvoiceLineId: string;
  quantity: string;
}

/**
 * id/status/cancelledAt/reclassificationEntryId/... nunca se aceptan: son
 * valores de sistema fijados por PurchaseReceiptsService. `idempotencyKey`
 * es opcional — si se omite, no hay protección de idempotencia para esta
 * solicitud (ver §3 del encargo A5.2b).
 */
export interface CreatePurchaseReceiptInput {
  purchaseInvoiceId: string;
  receivedDate?: string;
  notes?: string;
  idempotencyKey?: string;
  lines: CreatePurchaseReceiptLineInput[];
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
