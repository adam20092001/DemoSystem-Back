import {
  PurchaseAcquisitionKind,
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
} from '@prisma/client';

export interface SafePurchaseInvoiceLine {
  id: string;
  productId: string | null;
  descriptionSnapshot: string;
  unitCodeSnapshot: string | null;
  unitNameSnapshot: string | null;
  acquisitionKind: PurchaseAcquisitionKind;
  purchasePurpose: PurchasePurpose;
  quantity: string;
  unitCost: string;
  taxCategory: PurchaseLineTaxCategory;
  taxBasis: PurchaseLineTaxBasis | null;
  taxRateSnapshot: string | null;
  taxableBaseAmount: string;
  taxAmount: string;
  creditableTaxAmount: string;
  lineTotal: string;
  isReceiptEligible: boolean | null;
}

/** Respuesta segura de PurchaseInvoice (sin campos internos ni de otras fases). */
export interface SafePurchaseInvoice {
  id: string;
  supplierId: string;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries: string | null;
  documentNumber: string;
  issueDate: string;
  registrationDate: string;
  accountingDate: string;
  dueDate: string | null;
  paymentTermsDays: number | null;
  currencyCode: string;
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  status: PurchaseInvoiceStatus;
  postedEntryId: string | null;
  createdByUserId: string;
  confirmedAt: Date | null;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  lines: SafePurchaseInvoiceLine[];
}
