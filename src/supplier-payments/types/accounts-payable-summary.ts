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

/** Desglose en la moneda de cada documento (nunca suma monedas distintas). */
export interface AccountsPayableCurrencySummary {
  currencyCode: string;
  invoiceCount: number;
  totalOriginal: string;
  totalPaid: string;
  totalPending: string;
  /** Saldo pendiente en libros (moneda de la empresa) de las facturas de esta moneda. */
  baseTotalPending: string;
}

/**
 * bySupplier/grandTotal están SIEMPRE en la moneda de la EMPRESA (valor
 * contable: total de la factura, valor en libros cancelado y saldo en libros),
 * de modo que la suma entre monedas es válida. byCurrency detalla la deuda en
 * la moneda original de cada documento.
 */
export interface AccountsPayableSummaryReport {
  baseCurrencyCode: string | null;
  bySupplier: AccountsPayableSupplierSummary[];
  grandTotal: AccountsPayableSummaryTotals;
  byCurrency: AccountsPayableCurrencySummary[];
}
