import {
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
} from '@prisma/client';

export interface ListCustomersQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: CustomerStatus;
  customerType?: CustomerType;
  customerStage?: CustomerStage;
  documentType?: CustomerDocumentType;
  isGeneric?: boolean;
}
