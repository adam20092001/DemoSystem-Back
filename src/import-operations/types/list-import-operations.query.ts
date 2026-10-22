import { ImportOperationStatus } from '@prisma/client';

export interface ListImportOperationsQuery {
  page?: number;
  limit?: number;
  status?: ImportOperationStatus;
  originCountry?: string;
  destinationCountry?: string;
  search?: string;
}
