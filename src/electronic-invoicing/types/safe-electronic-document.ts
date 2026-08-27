import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
} from '@prisma/client';

/** Forma segura de listado (Bloque 11D §14): nunca items, nunca providerExternalId. */
export interface SafeElectronicDocumentListItem {
  id: string;
  saleId: string;
  saleNumber: string;
  documentType: FiscalDocumentType;
  series: string;
  number: number;
  /** Computado: series + "-" + number relleno a 8 dígitos. Nunca almacenado en BD. */
  fullNumber: string;
  status: ElectronicDocumentStatus;
  currencyCode: string;

  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;

  subtotal: string;
  discountAmount: string;
  taxableBase: string;
  taxAmount: string;
  total: string;

  providerCode: string;
  providerStatus: string | null;

  issuedAt: Date;
  lastSubmittedAt: Date | null;
  acceptedAt: Date | null;
  rejectedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SafeElectronicDocumentItem {
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
 * Forma segura de detalle (Bloque 11D §15): agrega identidad del emisor,
 * dirección del cliente, mensaje del proveedor ya saneado, contador de
 * intentos e ítems. NUNCA providerExternalId (reservado para reconciliación
 * interna futura), ni ningún campo crudo del proveedor.
 */
export interface SafeElectronicDocument extends SafeElectronicDocumentListItem {
  issuerTaxId: string;
  issuerBusinessName: string;
  issuerAddress: string | null;

  customerAddress: string | null;

  providerMessage: string | null;
  submissionCount: number;

  items: SafeElectronicDocumentItem[];
}
