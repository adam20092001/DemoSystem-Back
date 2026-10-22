import { RoleName } from '@prisma/client';

/** Motivo siempre obligatorio, mismo criterio que el resto del dominio. */
export interface CancelSupplierPaymentInput {
  supplierPaymentId: string;
  reason: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
