/**
 * Discrepancia real detectada entre el saldo operativo (A5.3,
 * SupplierPaymentAllocation) y los asientos contables realmente
 * posteados (AccountingEngine) — nunca un ajuste inventado. Fase A5.4.
 */
export type ApReconciliationDiscrepancyCode =
  /** PurchaseInvoice CONFIRMED sin AccountingEntry asociado — invariante interno roto. */
  | 'MISSING_ORIGINAL_ENTRY'
  /** El asiento original no tiene EXACTAMENTE una línea de crédito de pasivo. */
  | 'INVALID_CREDIT_LINE_COUNT'
  /** El monto acreditado en el asiento original no coincide con PurchaseInvoice.totalAmount. */
  | 'CREDIT_AMOUNT_MISMATCH';

/** Discrepancia a nivel de cuenta de pasivo histórica (agregada, Fase A5.4). */
export type ApAccountReconciliationDiscrepancyCode = 'ACCOUNT_BALANCE_MISMATCH';

export interface ApInvoiceReconciliationRow {
  purchaseInvoiceId: string;
  supplierId: string;
  originalAmount: string;
  postedEntryId: string | null;
  /** Cuenta REALMENTE acreditada en el asiento original — null solo si hay una discrepancia que impide determinarla. */
  historicalLiabilityAccountId: string | null;
  creditedAmount: string | null;
  operationalPaidAmount: string;
  operationalPendingBalance: string;
  discrepancies: ApReconciliationDiscrepancyCode[];
}

export interface ApAccountReconciliationRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  /** Suma de SupplierPaymentAllocation ACTIVE de las facturas cuya cuenta histórica es esta (fuente operativa, A5.3). */
  operationalPaidAmount: string;
  /** Neto (débito − crédito) de TODAS las líneas de asientos sourceType=SUPPLIER_PAYMENT contra esta cuenta (fuente contable, AccountingEngine) — ORIGINAL y REVERSAL incluidos, cálculo independiente del anterior. */
  accountingNetDebitAmount: string;
  difference: string;
  discrepancies: ApAccountReconciliationDiscrepancyCode[];
}

/**
 * Conciliación de SOLO LECTURA (Fase A5.4): nunca crea asientos
 * correctivos ni modifica ningún saldo. Compara dos fuentes
 * independientes ya existentes — nunca inventa una tercera: el saldo
 * operativo de A5.3 (SupplierPaymentAllocation) contra lo realmente
 * posteado por AccountingEngine, agrupado por la cuenta de pasivo
 * HISTÓRICA de cada factura (nunca el mapeo VIGENTE de
 * ACCOUNTS_PAYABLE, que pudo reasignarse después de confirmar).
 */
export interface ApReconciliationReport {
  generatedAt: string;
  invoices: ApInvoiceReconciliationRow[];
  accounts: ApAccountReconciliationRow[];
  overallConsistent: boolean;
  limitations: string[];
}
