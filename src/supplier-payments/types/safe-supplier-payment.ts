import { SupplierPaymentStatus } from '@prisma/client';

export interface SafeSupplierPaymentAllocation {
  id: string;
  purchaseInvoiceId: string;
  amount: string;
}

/** Respuesta segura de SupplierPayment. */
export interface SafeSupplierPayment {
  id: string;
  supplierId: string;
  paymentDate: string;
  amount: string;
  currencyCode: string;
  paymentMethodId: string;
  paymentMethodCode: string;
  paymentMethodName: string;
  reference: string | null;
  idempotencyKey: string | null;
  status: SupplierPaymentStatus;
  postedEntryId: string;
  createdByUserId: string;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  allocations: SafeSupplierPaymentAllocation[];
}
