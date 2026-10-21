import {
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
} from '@prisma/client';

export interface ListPurchaseInvoicesQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: PurchaseInvoiceStatus;
  documentType?: PurchaseInvoiceDocumentType;
  supplierId?: string;
}
