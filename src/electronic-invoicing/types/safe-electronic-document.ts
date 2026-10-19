import {
  CustomerDocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
  LineDiscountType,
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
  // NR-03: copiado EXACTAMENTE del SaleItem de origen al emitir.
  discountType: LineDiscountType | null;
  discountValue: string | null;
  discountAmount: string;
}

/**
 * Forma segura de detalle (Bloque 11D §15): agrega identidad del emisor,
 * dirección del cliente, mensaje del proveedor ya saneado, contador de
 * intentos e ítems. NUNCA providerExternalId (reservado para reconciliación
 * interna futura), ni ningún campo crudo del proveedor.
 */
export interface SafeElectronicDocument extends SafeElectronicDocumentListItem {
  /** R2-B5: false = histórico (IGV sumado); true = precios finales con IGV incluido. */
  pricesIncludeTax: boolean;
  /** R2-B5: contexto de impuesto congelado de la venta de origen (nunca CompanySettings vigente). */
  taxEnabled: boolean;
  taxRate: string;
  /** R2-B5: Σ lineTotal de los ítems persistidos. */
  itemsTotal: string;
  /** R2-B5: descuento que vio el cliente (itemsTotal - total si pricesIncludeTax; = discountAmount si es histórico). */
  customerDiscountAmount: string;

  issuerTaxId: string;
  issuerBusinessName: string;
  issuerAddress: string | null;

  customerAddress: string | null;

  providerMessage: string | null;
  submissionCount: number;

  items: SafeElectronicDocumentItem[];
}
