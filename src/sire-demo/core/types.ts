import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
  Prisma,
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
  SupplierDocumentType,
} from '@prisma/client';

export const SIRE_REGISTERS = ['RVIE', 'RCE'] as const;
export type SireRegister = (typeof SIRE_REGISTERS)[number];

export const SIRE_SOURCES = ['POS', 'DEMO_FIXTURES'] as const;
export type SireSource = (typeof SIRE_SOURCES)[number];

/** Alertas de calidad de datos calculadas por el normalizador (y el motor). */
export const DATA_QUALITY_FLAGS = [
  'TAX_TREATMENT_UNCLASSIFIED',
  'CURRENCY_UNSUPPORTED',
  'DOC_TYPE_UNMAPPED',
  'COUNTERPARTY_DOC_TYPE_UNMAPPED',
  'COUNTERPARTY_INCOMPLETE',
  'COUNTERPARTY_DOC_FORMAT_INVALID',
  'ARITHMETIC_INCONSISTENT',
  /** Solo la asigna el motor: dos documentos POS con la misma clave. */
  'DUPLICATE_POS_KEY',
] as const;
export type DataQualityFlag = (typeof DATA_QUALITY_FLAGS)[number];

/** Alertas que impiden asignar una clave de conciliación a un documento POS. */
export const KEY_BLOCKING_FLAGS: readonly DataQualityFlag[] = [
  'DOC_TYPE_UNMAPPED',
  'CURRENCY_UNSUPPORTED',
  'DUPLICATE_POS_KEY',
];

export const RECONCILIATION_CLASSIFICATIONS = [
  'MATCHED',
  'MISSING_IN_POS',
  'MISSING_IN_PROPOSAL',
  'AMOUNT_MISMATCH',
  'PARTY_MISMATCH',
  'DATE_MISMATCH',
  'DUPLICATE_IN_PROPOSAL',
  'INSUFFICIENT_DATA',
] as const;
export type ReconciliationClassification =
  (typeof RECONCILIATION_CLASSIFICATIONS)[number];

/**
 * Fila cruda de un comprobante de venta (forma de ElectronicDocument). Es la
 * misma forma para el origen POS y para DEMO_FIXTURES: ambos pasan por el
 * mismo normalizador.
 */
export interface RawRvieDocument {
  register: 'RVIE';
  refId: string;
  documentType: FiscalDocumentType;
  series: string;
  number: number;
  status: ElectronicDocumentStatus;
  providerCode: string;
  issuedAt: Date;
  currencyCode: string;
  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  taxableBase: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  total: Prisma.Decimal;
}

/** Fila cruda de una factura de compra (forma de PurchaseInvoice + Supplier). */
export interface RawRceDocument {
  register: 'RCE';
  refId: string;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries: string | null;
  documentNumber: string;
  status: PurchaseInvoiceStatus;
  /** Fecha de emisión del proveedor (@db.Date, medianoche UTC). */
  issueDate: Date;
  /** Fecha contable (@db.Date, medianoche UTC). Regla DEMO provisional del periodo RCE. */
  accountingDate: Date;
  currencyCode: string;
  supplierDocumentType: SupplierDocumentType;
  supplierDocumentNumber: string;
  supplierLegalName: string;
  subtotal: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
}

export type RawTaxDocument = RawRvieDocument | RawRceDocument;

export interface CounterpartyIdentity {
  /** Código SUNAT (provisional) del tipo de documento de identidad. */
  docTypeCode: string | null;
  docNumber: string | null;
  name: string | null;
}

/** Documento normalizado: la única forma que ve el motor de conciliación. */
export interface NormalizedTaxDocument {
  refId: string;
  register: SireRegister;
  /** YYYYMM según la regla DEMO provisional de cada registro. */
  period: string;
  /** Código SUNAT (provisional) de comprobante; null si no está mapeado. */
  docTypeCode: string | null;
  series: string;
  number: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  /** Solo RCE. */
  accountingDate: string | null;
  counterparty: CounterpartyIdentity;
  currencyCode: string;
  /** null cuando el tratamiento tributario no puede clasificarse. */
  taxableBase: Prisma.Decimal | null;
  igv: Prisma.Decimal;
  total: Prisma.Decimal;
  internalStatus: string;
  flags: DataQualityFlag[];
}

export interface DocumentKey {
  docTypeCode: string;
  series: string;
  number: string;
  /** Solo RCE. */
  supplierDocNumber?: string;
}

/** Fila de una propuesta DEMO_V1 ya validada. */
export interface ProposalRow {
  /** Posición (1..n) de la fila de datos dentro del archivo. */
  lineNumber: number;
  docTypeCode: string;
  series: string;
  number: string;
  /** YYYY-MM-DD. */
  issueDate: string;
  cpDocTypeCode: string | null;
  cpDocNumber: string | null;
  cpName: string | null;
  currencyCode: string;
  taxableBase: Prisma.Decimal;
  igv: Prisma.Decimal;
  total: Prisma.Decimal;
}
