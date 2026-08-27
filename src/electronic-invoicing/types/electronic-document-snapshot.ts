import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
} from '@prisma/client';

/** Forma interna de una línea ya persistida, expuesta por el servicio (sin DTO/Swagger todavía). */
export interface ElectronicDocumentItemSnapshot {
  id: string;
  lineNumber: number;
  productSku: string;
  description: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

/**
 * Forma interna de ElectronicDocument devuelta por ElectronicDocumentsService
 * (issue()/retrySubmission()). No es un DTO HTTP: no hay controller ni
 * Swagger en este bloque; existe para que el resultado del servicio esté
 * explícitamente tipado (nunca `any`) y sea reutilizable como base cuando
 * la Fase 11D agregue el DTO público real.
 */
export interface ElectronicDocumentSnapshot {
  id: string;
  saleId: string;
  fiscalSeriesId: string;
  documentType: FiscalDocumentType;
  series: string;
  number: number;
  status: ElectronicDocumentStatus;
  providerCode: string;
  currencyCode: string;

  issuerTaxId: string;
  issuerBusinessName: string;
  issuerAddress: string | null;

  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;

  subtotal: string;
  discountAmount: string;
  taxableBase: string;
  taxAmount: string;
  total: string;

  providerExternalId: string | null;
  providerStatus: string | null;
  providerMessage: string | null;
  submissionCount: number;

  issuedAt: Date;
  lastSubmittedAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;

  createdAt: Date;
  updatedAt: Date;

  items: ElectronicDocumentItemSnapshot[];
}
