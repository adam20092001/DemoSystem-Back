import { SupplierPaymentStatus } from '@prisma/client';

export interface ListSupplierPaymentsQuery {
  page?: number;
  limit?: number;
  supplierId?: string;
  status?: SupplierPaymentStatus;
}
