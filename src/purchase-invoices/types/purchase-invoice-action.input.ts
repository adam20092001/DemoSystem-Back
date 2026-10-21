import { RoleName } from '@prisma/client';

/** Input de confirm(). */
export interface ConfirmPurchaseInvoiceInput {
  purchaseInvoiceId: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

/** Input de cancel(): motivo siempre obligatorio (mismo criterio que PaymentEngine.cancel()). */
export interface CancelPurchaseInvoiceInput {
  purchaseInvoiceId: string;
  reason: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
