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
  /** Costo unitario en la MONEDA DEL DOCUMENTO (6 decimales). */
  unitCost: string;
  /** Costo unitario en la moneda de la EMPRESA (informativo). */
  baseUnitCost: string;
  taxCategory: PurchaseLineTaxCategory;
  taxBasis: PurchaseLineTaxBasis | null;
  taxRateSnapshot: string | null;
  /** Importes de la línea en la MONEDA DEL DOCUMENTO. */
  taxableBaseAmount: string;
  taxAmount: string;
  creditableTaxAmount: string;
  lineTotal: string;
  /** Los mismos importes convertidos a la moneda de la EMPRESA (los que contabiliza el sistema). */
  baseTaxableBaseAmount: string;
  baseTaxAmount: string;
  baseCreditableTaxAmount: string;
  baseLineTotal: string;
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
  /** Moneda del DOCUMENTO. subtotal/taxAmount/totalAmount están en esta moneda. */
  currencyCode: string;
  /** Moneda de la EMPRESA (contable). */
  baseCurrencyCode: string;
  /** Unidades de moneda de la empresa por 1 unidad de moneda del documento; 1 si coinciden. */
  exchangeRate: string;
  exchangeRateDate: string;
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  /** Totales en la moneda de la EMPRESA (suma de las líneas convertidas). */
  baseSubtotal: string;
  baseTaxAmount: string;
  baseTotalAmount: string;
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
