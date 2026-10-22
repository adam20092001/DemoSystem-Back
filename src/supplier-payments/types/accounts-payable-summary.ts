/** Totales de cuentas por pagar agrupados por proveedor + total general (Fase A5.4). */
export interface AccountsPayableSupplierSummary {
  supplierId: string;
  supplierLegalName: string;
  supplierDocumentNumber: string;
  invoiceCount: number;
  totalOriginal: string;
  totalPaid: string;
  totalPending: string;
}

export interface AccountsPayableSummaryTotals {
  invoiceCount: number;
  totalOriginal: string;
  totalPaid: string;
  totalPending: string;
}

export interface AccountsPayableSummaryReport {
  bySupplier: AccountsPayableSupplierSummary[];
  grandTotal: AccountsPayableSummaryTotals;
}
