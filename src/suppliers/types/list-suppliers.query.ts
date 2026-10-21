import { SupplierDocumentType, SupplierStatus } from '@prisma/client';

export interface ListSuppliersQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: SupplierStatus;
  documentType?: SupplierDocumentType;
  countryCode?: string;
}
