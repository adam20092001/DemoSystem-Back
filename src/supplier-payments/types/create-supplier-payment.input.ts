import { RoleName } from '@prisma/client';

export interface CreateSupplierPaymentAllocationInput {
  purchaseInvoiceId: string;
  amount: string;
}

/**
 * id/status/postedEntryId/currencyCode/.../cancelledAt/... nunca se
 * aceptan: son valores de sistema fijados por SupplierPaymentsService.
 * `amount` debe coincidir EXACTAMENTE con la suma de `allocations` —
 * validado por el servicio, nunca inferido de las asignaciones (para que
 * un error de captura en una sola línea nunca pase inadvertido).
 */
export interface CreateSupplierPaymentInput {
  supplierId: string;
  paymentDate?: string;
  amount: string;
  method: string;
  reference?: string;
  idempotencyKey?: string;
  allocations: CreateSupplierPaymentAllocationInput[];
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
