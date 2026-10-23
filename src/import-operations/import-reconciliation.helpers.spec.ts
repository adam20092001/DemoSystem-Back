import {
  ImportShipmentStatus,
  Prisma,
  PurchaseReceiptStatus,
} from '@prisma/client';
import {
  buildReconciliationRow,
  classifyReconciliation,
  ReceiptLinkRow,
  ShipmentLineRow,
} from './import-reconciliation.helpers';
import { ExpenseCurrencyAggregate } from './types/import-reports.types';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeLine(overrides: Partial<ShipmentLineRow> = {}): ShipmentLineRow {
  return {
    id: 'line-1',
    importShipmentId: 'shipment-1',
    shipmentStatus: ImportShipmentStatus.ARRIVED,
    importOperationId: 'operation-1',
    productId: null,
    descriptionSnapshot: 'Carga',
    unitCode: 'kg',
    purchaseInvoiceLineId: 'invoice-line-1',
    plannedQuantity: d('100.000'),
    ...overrides,
  };
}

function makeLink(overrides: Partial<ReceiptLinkRow> = {}): ReceiptLinkRow {
  return {
    importReceiptLinkId: 'link-1',
    importShipmentLineId: 'line-1',
    purchaseReceiptLineId: 'receipt-line-1',
    purchaseReceiptId: 'receipt-1',
    receiptStatus: PurchaseReceiptStatus.ACTIVE,
    linkStatus: 'ACTIVE',
    linkedQuantity: d('100.000'),
    receiptLineProductId: null,
    receiptLinePurchaseInvoiceLineId: 'invoice-line-1',
    ...overrides,
  };
}

describe('buildReconciliationRow', () => {
  it('ARRIVED totalmente vinculado: sin discrepancias', () => {
    const row = buildReconciliationRow(makeLine(), [makeLink()]);
    expect(row.discrepancyCodes).toHaveLength(0);
    expect(row.remainingQuantity).toBe('0.000');
  });

  it('ARRIVED sin ningún vínculo: ARRIVED_WITH_UNLINKED_CARGO', () => {
    const row = buildReconciliationRow(makeLine(), []);
    expect(row.discrepancyCodes).toContain('ARRIVED_WITH_UNLINKED_CARGO');
    expect(row.discrepancyCodes).not.toContain('PARTIAL_RECEIPT_LINKAGE');
  });

  it('ARRIVED con vínculo parcial: PARTIAL_RECEIPT_LINKAGE', () => {
    const row = buildReconciliationRow(makeLine(), [
      makeLink({ linkedQuantity: d('30.000') }),
    ]);
    expect(row.discrepancyCodes).toContain('PARTIAL_RECEIPT_LINKAGE');
    expect(row.linkedQuantity).toBe('30.000');
    expect(row.remainingQuantity).toBe('70.000');
  });

  it('PLANNED/IN_TRANSIT sin vínculos: nunca discrepancia (todavía no corresponde recibir)', () => {
    const row = buildReconciliationRow(
      makeLine({ shipmentStatus: ImportShipmentStatus.IN_TRANSIT }),
      [],
    );
    expect(row.discrepancyCodes).toHaveLength(0);
  });

  it('ARRIVED sin purchaseInvoiceLineId: MISSING_PURCHASE_INVOICE_LINK', () => {
    const row = buildReconciliationRow(
      makeLine({ purchaseInvoiceLineId: null }),
      [makeLink()],
    );
    expect(row.discrepancyCodes).toContain('MISSING_PURCHASE_INVOICE_LINK');
  });

  it('vínculos CANCELLED nunca participan en linkedQuantity/remainingQuantity, solo se preservan en links', () => {
    const row = buildReconciliationRow(makeLine(), [
      makeLink({ linkStatus: 'CANCELLED', linkedQuantity: d('999.000') }),
    ]);
    expect(row.linkedQuantity).toBe('0.000');
    expect(row.remainingQuantity).toBe('100.000');
    expect(row.discrepancyCodes).toContain('ARRIVED_WITH_UNLINKED_CARGO');
    expect(row.links).toHaveLength(1);
  });

  it('producto inconsistente entre línea y recepción: INCONSISTENT_PRODUCT_REFERENCE', () => {
    const row = buildReconciliationRow(makeLine({ productId: 'product-a' }), [
      makeLink({ receiptLineProductId: 'product-b' }),
    ]);
    expect(row.discrepancyCodes).toContain('INCONSISTENT_PRODUCT_REFERENCE');
  });

  it('factura de compra inconsistente entre línea y recepción: INCONSISTENT_PRODUCT_REFERENCE', () => {
    const row = buildReconciliationRow(
      makeLine({ purchaseInvoiceLineId: 'invoice-line-a' }),
      [makeLink({ receiptLinePurchaseInvoiceLineId: 'invoice-line-b' })],
    );
    expect(row.discrepancyCodes).toContain('INCONSISTENT_PRODUCT_REFERENCE');
  });

  it('cantidad vinculada ACTIVE excede lo embarcado (dato legado inconsistente): QUANTITY_EXCEEDS_SHIPPED', () => {
    const row = buildReconciliationRow(
      makeLine({ plannedQuantity: d('10.000') }),
      [makeLink({ linkedQuantity: d('15.000') })],
    );
    expect(row.discrepancyCodes).toContain('QUANTITY_EXCEEDS_SHIPPED');
    expect(row.remainingQuantity).toBe('0.000');
  });
});

describe('classifyReconciliation', () => {
  function pendingAccountingPolicyAggregate(
    allocatedAmount = '100.00',
  ): ExpenseCurrencyAggregate {
    return {
      currencyCode: 'PEN',
      expenseCount: 1,
      cancelledCount: 0,
      totalAmount: '100.00',
      allocatedAmount,
      unallocatedAmount: '0.00',
      attributedAmount: '30.00',
      unattributedAmount: '70.00',
      financialStatus: 'PENDING_ACCOUNTING_POLICY',
    };
  }

  function pendingFxAggregate(): ExpenseCurrencyAggregate {
    return {
      ...pendingAccountingPolicyAggregate(),
      currencyCode: 'USD',
      financialStatus: 'PENDING_FX',
    };
  }

  it('DATA_INCONSISTENCY tiene precedencia sobre todo lo demás', () => {
    const result = classifyReconciliation(
      ['QUANTITY_EXCEEDS_SHIPPED', 'ARRIVED_WITH_UNLINKED_CARGO'],
      [pendingFxAggregate()],
    );
    expect(result.status).toBe('DATA_INCONSISTENCY');
  });

  it('PARTIAL_PENDING_OPERATIONAL_LINK tiene precedencia sobre lo financiero', () => {
    const result = classifyReconciliation(
      ['ARRIVED_WITH_UNLINKED_CARGO'],
      [pendingFxAggregate()],
    );
    expect(result.status).toBe('PARTIAL_PENDING_OPERATIONAL_LINK');
  });

  it('PENDING_FX tiene precedencia sobre PENDING_ACCOUNTING_POLICY', () => {
    const result = classifyReconciliation(
      [],
      [pendingFxAggregate(), pendingAccountingPolicyAggregate()],
    );
    expect(result.status).toBe('PENDING_FX');
  });

  it('PENDING_ACCOUNTING_POLICY cuando hay monto asignado en la misma moneda de la empresa', () => {
    const result = classifyReconciliation(
      [],
      [pendingAccountingPolicyAggregate()],
    );
    expect(result.status).toBe('PENDING_ACCOUNTING_POLICY');
  });

  it('CONSISTENT cuando no hay discrepancias ni monto asignado', () => {
    const result = classifyReconciliation(
      [],
      [pendingAccountingPolicyAggregate('0.00')],
    );
    expect(result.status).toBe('CONSISTENT');
  });

  it('CONSISTENT cuando no hay ningún gasto ni discrepancia', () => {
    const result = classifyReconciliation([], []);
    expect(result.status).toBe('CONSISTENT');
  });

  it('siempre entrega al menos un motivo explicando la clasificación', () => {
    const result = classifyReconciliation([], []);
    expect(result.reasons.length).toBeGreaterThan(0);
  });
});
