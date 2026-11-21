import {
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
} from '@prisma/client';
import { ReceiptLineQuantities } from '../receipt-line-status';

/**
 * Vistas de RECEPCIÓN FÍSICA para almacén (R1). Contienen exclusivamente lo
 * necesario para identificar y recibir mercadería: documento, proveedor,
 * producto, unidad y CANTIDADES. Deliberadamente NO incluyen ningún monto
 * (precio, costo, base imponible, impuesto, total), ni ids contables, ni
 * datos de contacto del proveedor: WAREHOUSE nunca ve información financiera.
 */
export interface ReceivableInvoiceSupplier {
  id: string;
  legalName: string;
  tradeName: string | null;
}

export interface ReceivableInvoiceListItem {
  id: string;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries: string | null;
  documentNumber: string;
  issueDate: string;
  supplier: ReceivableInvoiceSupplier;
  pendingLinesCount: number;
}

export interface ReceivableInvoiceLine extends ReceiptLineQuantities {
  purchaseInvoiceLineId: string;
  productId: string;
  productSku: string;
  productName: string;
  unitCode: string | null;
  unitName: string | null;
}

export interface ReceivableInvoiceDetail {
  id: string;
  status: PurchaseInvoiceStatus;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries: string | null;
  documentNumber: string;
  issueDate: string;
  supplier: ReceivableInvoiceSupplier;
  pendingLinesCount: number;
  lines: ReceivableInvoiceLine[];
}
