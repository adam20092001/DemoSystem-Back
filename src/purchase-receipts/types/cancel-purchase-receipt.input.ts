import { RoleName } from '@prisma/client';

/** Motivo siempre obligatorio, mismo criterio que PaymentEngine.cancel()/PurchaseInvoicesService.cancel(). */
export interface CancelPurchaseReceiptInput {
  purchaseReceiptId: string;
  reason: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
