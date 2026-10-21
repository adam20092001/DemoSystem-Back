import {
  PurchaseAcquisitionKind,
  PurchaseInvoiceDocumentType,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
  RoleName,
} from '@prisma/client';

/**
 * Una línea sin productId exige `description` explícita; con productId, es
 * opcional (el servicio la copia de Product.name por defecto). taxBasis
 * obligatorio únicamente cuando taxCategory=TAXED. creditableTaxAmount
 * nunca se infiere de taxCategory — default '0' si se omite (nunca asumir
 * deducibilidad, revisión de A5.2).
 */
export interface CreatePurchaseInvoiceLineInput {
  productId?: string;
  description?: string;
  unitLabel?: string;
  acquisitionKind: PurchaseAcquisitionKind;
  purchasePurpose: PurchasePurpose;
  quantity: string;
  unitCost: string;
  taxCategory: PurchaseLineTaxCategory;
  taxBasis?: PurchaseLineTaxBasis;
  creditableTaxAmount?: string;
}

/**
 * id, status, subtotal/taxAmount/totalAmount, postedEntryId,
 * confirmedAt/cancelledAt/... nunca se aceptan: son valores de sistema
 * fijados por PurchaseInvoicesService. currencyCode nunca se acepta del
 * cliente: siempre CompanySettings.currencyCode vigente (mismo criterio
 * que Sale, A0.2).
 */
export interface CreatePurchaseInvoiceInput {
  supplierId: string;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries?: string;
  documentNumber: string;
  issueDate: string;
  registrationDate?: string;
  accountingDate?: string;
  dueDate?: string;
  paymentTermsDays?: number;
  lines: CreatePurchaseInvoiceLineInput[];
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
