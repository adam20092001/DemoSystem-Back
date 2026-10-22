import { PurchaseInvoiceDocumentType } from '@prisma/client';
import { AccountsPayableStatus } from '../supplier-payment-calculator';

/**
 * Una cuenta por pagar = UNA PurchaseInvoice CONFIRMED. Nace de la factura,
 * nunca de una recepción física (A5.2b es independiente). paidAmount/
 * balanceDue/status se calculan SIEMPRE en tiempo de lectura a partir de
 * SupplierPaymentAllocation ACTIVE — nunca una columna duplicada en
 * PurchaseInvoice (a diferencia de Sale.paidAmount/balanceDue, que sí
 * denormaliza: decisión explícita de A5.3 para no arriesgar
 * desincronización con asignaciones multi-factura).
 */
export interface AccountsPayableItem {
  purchaseInvoiceId: string;
  supplierId: string;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries: string | null;
  documentNumber: string;
  issueDate: string;
  dueDate: string | null;
  currencyCode: string;
  originalAmount: string;
  paidAmount: string;
  balanceDue: string;
  status: AccountsPayableStatus;
}

export interface AccountsPayablePaymentHistoryItem {
  supplierPaymentId: string;
  status: 'ACTIVE' | 'CANCELLED';
  paymentDate: string;
  amountApplied: string;
  paymentMethodCode: string;
  reference: string | null;
}

export interface AccountsPayableDetail extends AccountsPayableItem {
  payments: AccountsPayablePaymentHistoryItem[];
}
