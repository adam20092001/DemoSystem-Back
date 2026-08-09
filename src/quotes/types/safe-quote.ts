import {
  CustomerDocumentType,
  CustomerType,
  QuoteStatus,
} from '@prisma/client';

export interface SafeQuoteStockInfo {
  currentStock: string;
  requestedQuantity: string;
  sufficient: boolean;
}

export interface SafeQuoteItem {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  /** null cuando el producto no es inventariable (SERVICE o isInventoryTracked=false). */
  stockInfo: SafeQuoteStockInfo | null;
}

/** Identidad mínima del vendedor: nunca role/passwordHash/campos de seguridad. */
export interface SafeQuoteSeller {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/** Forma de listado: sin ítems ni identidad completa del vendedor. */
export interface SafeQuoteListItem {
  id: string;
  number: string;
  /** Estado EFECTIVO (ver effectiveStatus en quote-calculator.ts), no necesariamente el almacenado. */
  status: QuoteStatus;
  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;
  sellerId: string;
  issueDate: string;
  expirationDate: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  itemCount: number;
  createdAt: Date;
  updatedAt: Date;
}

/** Forma de detalle: snapshot completo de cliente, vendedor seguro e ítems con stockInfo en vivo. */
export interface SafeQuote {
  id: string;
  number: string;
  status: QuoteStatus;
  customerId: string;
  customerType: CustomerType;
  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;
  seller: SafeQuoteSeller;
  issueDate: string;
  expirationDate: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  items: SafeQuoteItem[];
  createdAt: Date;
  updatedAt: Date;
}
