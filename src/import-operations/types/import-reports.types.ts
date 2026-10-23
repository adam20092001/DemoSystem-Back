import {
  ImportExpenseCategory,
  ImportExpenseStatus,
  ImportOperationStatus,
  ImportShipmentStatus,
  PurchaseReceiptStatus,
} from '@prisma/client';

/** Mismo significado que en B3: nunca "aprobado", siempre "todavía no decidido". */
export type PendingFinancialStatus = 'PENDING_FX' | 'PENDING_ACCOUNTING_POLICY';

export interface CargoUnitAggregate {
  unitCode: string | null;
  plannedQuantity: string;
  linkedReceivedQuantity: string;
  unlinkedQuantity: string;
}

export interface RelatedPurchaseInvoiceRef {
  id: string;
  documentType: string;
  documentSeries: string | null;
  documentNumber: string;
}

export interface ExpenseCurrencyAggregate {
  currencyCode: string;
  expenseCount: number;
  cancelledCount: number;
  totalAmount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  attributedAmount: string;
  unattributedAmount: string;
  financialStatus: PendingFinancialStatus;
}

export type ShipmentCountsByStatus = Record<ImportShipmentStatus, number>;

// ==========================================================================
// Reporte 1 — Resumen por operación de importación
// ==========================================================================

export interface ImportOperationSummaryRow {
  id: string;
  reference: string;
  status: ImportOperationStatus;
  originCountry: string;
  destinationCountry: string;
  createdAt: Date;
  completedAt: Date | null;
  cancelledAt: Date | null;
  shipmentCountsByStatus: ShipmentCountsByStatus;
  cargoByUnit: CargoUnitAggregate[];
  relatedPurchaseInvoices: RelatedPurchaseInvoiceRef[];
  expensesByCurrency: ExpenseCurrencyAggregate[];
}

export interface ImportOperationSummaryQuery {
  importOperationId?: string;
  status?: ImportOperationStatus;
  page?: number;
  limit?: number;
}

// ==========================================================================
// Reporte 2 — Reconciliación embarque / recepción
// ==========================================================================

export type ShipmentDiscrepancyCode =
  | 'ARRIVED_WITH_UNLINKED_CARGO'
  | 'PARTIAL_RECEIPT_LINKAGE'
  | 'MISSING_PURCHASE_INVOICE_LINK'
  | 'INCONSISTENT_PRODUCT_REFERENCE'
  | 'QUANTITY_EXCEEDS_SHIPPED';

export interface ShipmentReconciliationLinkRef {
  importReceiptLinkId: string;
  purchaseReceiptLineId: string;
  purchaseReceiptId: string;
  receiptStatus: PurchaseReceiptStatus;
  linkStatus: 'ACTIVE' | 'CANCELLED';
  linkedQuantity: string;
}

export interface ShipmentReconciliationRow {
  importShipmentLineId: string;
  importShipmentId: string;
  importOperationId: string;
  shipmentStatus: ImportShipmentStatus;
  productId: string | null;
  descriptionSnapshot: string;
  unitCode: string | null;
  purchaseInvoiceLineId: string | null;
  plannedQuantity: string;
  linkedQuantity: string;
  remainingQuantity: string;
  links: ShipmentReconciliationLinkRef[];
  discrepancyCodes: ShipmentDiscrepancyCode[];
}

export interface ShipmentReconciliationQuery {
  importOperationId?: string;
  shipmentStatus?: ImportShipmentStatus;
  onlyWithDiscrepancies?: boolean;
  page?: number;
  limit?: number;
}

// ==========================================================================
// Reporte 3 — Reconciliación de gastos de importación
// ==========================================================================

export interface ExpenseReconciliationRow {
  importExpenseId: string;
  importOperationId: string;
  category: ImportExpenseCategory;
  documentReference: string | null;
  supplierId: string | null;
  currencyCode: string;
  amount: string;
  status: ImportExpenseStatus;
  allocatedAmount: string;
  unallocatedAmount: string;
  attributedAmount: string;
  unattributedAmount: string;
  financialStatus: PendingFinancialStatus | null;
}

export interface ExpenseReconciliationQuery {
  importOperationId?: string;
  status?: ImportExpenseStatus;
  currencyCode?: string;
  page?: number;
  limit?: number;
}

// ==========================================================================
// Reporte 4 — Reconciliación consolidada
// ==========================================================================

export type ConsolidatedReconciliationStatus =
  | 'CONSISTENT'
  | 'PARTIAL_PENDING_OPERATIONAL_LINK'
  | 'PENDING_ACCOUNTING_POLICY'
  | 'PENDING_FX'
  | 'DATA_INCONSISTENCY';

export interface ConsolidatedReconciliationRow {
  importOperationId: string;
  reference: string;
  operationStatus: ImportOperationStatus;
  reconciliationStatus: ConsolidatedReconciliationStatus;
  reasons: string[];
  cargoByUnit: CargoUnitAggregate[];
  expensesByCurrency: ExpenseCurrencyAggregate[];
  discrepancyCodes: ShipmentDiscrepancyCode[];
}

export interface ConsolidatedReconciliationQuery {
  importOperationId?: string;
  status?: ImportOperationStatus;
  reconciliationStatus?: ConsolidatedReconciliationStatus;
  page?: number;
  limit?: number;
}
