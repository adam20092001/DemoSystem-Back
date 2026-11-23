import { PurchaseInvoiceDocumentType } from '@prisma/client';
import { AgingBucket } from '../accounts-payable-calculator';
import { AccountsPayableStatus } from '../supplier-payment-calculator';

/**
 * Una cuenta por pagar = UNA PurchaseInvoice CONFIRMED. Nace de la factura,
 * nunca de una recepción física (A5.2b es independiente). paidAmount/
 * balanceDue/status se calculan SIEMPRE en tiempo de lectura a partir de
 * SupplierPaymentAllocation ACTIVE — nunca una columna duplicada en
 * PurchaseInvoice (a diferencia de Sale.paidAmount/balanceDue, que sí
 * denormaliza: decisión explícita de A5.3 para no arriesgar
 * desincronización con asignaciones multi-factura). `agingBucket`/
 * `daysOverdue` (Fase A5.4) también se derivan siempre en tiempo de
 * lectura, a partir de `dueDate` y la fecha de negocio VIGENTE — nunca un
 * saldo reconstruido a una fecha de corte histórica (ver limitación
 * documentada en AccountsPayableService.getAging()).
 */
export interface AccountsPayableItem {
  purchaseInvoiceId: string;
  supplierId: string;
  supplierLegalName: string;
  supplierDocumentNumber: string;
  documentType: PurchaseInvoiceDocumentType;
  documentSeries: string | null;
  documentNumber: string;
  issueDate: string;
  dueDate: string | null;
  /** Moneda del DOCUMENTO: originalAmount, paidAmount y balanceDue están en ella. */
  currencyCode: string;
  originalAmount: string;
  paidAmount: string;
  balanceDue: string;
  /** Moneda de la EMPRESA (contable) y tasa histórica de la factura. */
  baseCurrencyCode: string;
  exchangeRate: string;
  exchangeRateDate: string;
  /** Mismos conceptos en la moneda de la EMPRESA: total contable, valor en libros cancelado y saldo en libros. */
  baseOriginalAmount: string;
  basePaidAmount: string;
  baseBalanceDue: string;
  status: AccountsPayableStatus;
  agingBucket: AgingBucket;
  daysOverdue: number | null;
}

export interface AccountsPayablePaymentHistoryItem {
  supplierPaymentId: string;
  status: 'ACTIVE' | 'CANCELLED';
  paymentDate: string;
  /** En la moneda del pago (= moneda de la factura). */
  amountApplied: string;
  currencyCode: string;
  exchangeRate: string;
  /** Valor en libros cancelado (moneda de la empresa). */
  baseCarryingAmount: string;
  /** Importe pagado (moneda de la empresa). */
  baseSettledAmount: string;
  /** Diferencia de cambio realizada (>0 pérdida, <0 ganancia). */
  fxDifferenceAmount: string;
  paymentMethodCode: string;
  reference: string | null;
}

export interface AccountsPayableDetail extends AccountsPayableItem {
  payments: AccountsPayablePaymentHistoryItem[];
}
