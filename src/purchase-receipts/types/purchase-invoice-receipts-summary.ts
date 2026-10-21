import { PurchaseInvoiceLineReceiptStatus } from '../receipt-line-status';
import { SafePurchaseReceipt } from './safe-purchase-receipt';

export interface PurchaseInvoiceLineReceiptSummary {
  purchaseInvoiceLineId: string;
  invoicedQuantity: string;
  receivedQuantity: string;
  pendingQuantity: string;
  status: PurchaseInvoiceLineReceiptStatus;
}

/**
 * Respuesta de GET /purchase-invoices/:id/receipts: el historial de
 * recepciones MÁS el resumen pendiente/parcial/completo por línea
 * elegible, calculado siempre en tiempo de lectura (nunca una fuente de
 * verdad duplicada).
 */
export interface PurchaseInvoiceReceiptsSummary {
  purchaseInvoiceId: string;
  receipts: SafePurchaseReceipt[];
  lines: PurchaseInvoiceLineReceiptSummary[];
}
