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
  /** R4: moneda del pago (por defecto la de la empresa). Debe coincidir con la de TODAS las facturas pagadas. */
  currencyCode?: string;
  /** R4: moneda de la empresa por 1 unidad de moneda del pago (obligatoria si la moneda difiere de la de la empresa). */
  exchangeRate?: string;
  exchangeRateDate?: string;
  reference?: string;
  idempotencyKey?: string;
  allocations: CreateSupplierPaymentAllocationInput[];
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
