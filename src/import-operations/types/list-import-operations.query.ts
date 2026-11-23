import { ImportOperationStatus } from '@prisma/client';

export interface ListImportOperationsQuery {
  page?: number;
  limit?: number;
  status?: ImportOperationStatus;
  originCountry?: string;
  purchaseInvoiceId?: string;
  isLegacyUnlinked?: boolean;
  destinationCountry?: string;
  search?: string;
}
