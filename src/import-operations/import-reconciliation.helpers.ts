import {
  ImportShipmentStatus,
  Prisma,
  PurchaseReceiptStatus,
} from '@prisma/client';
import {
  ConsolidatedReconciliationStatus,
  ExpenseCurrencyAggregate,
  ShipmentDiscrepancyCode,
  ShipmentReconciliationLinkRef,
  ShipmentReconciliationRow,
} from './types/import-reports.types';

const ZERO = new Prisma.Decimal(0);

export interface ShipmentLineRow {
  id: string;
  importShipmentId: string;
  shipmentStatus: ImportShipmentStatus;
  importOperationId: string;
  productId: string | null;
  descriptionSnapshot: string;
  unitCode: string | null;
  purchaseInvoiceLineId: string | null;
  plannedQuantity: Prisma.Decimal;
}

export interface ReceiptLinkRow {
  importReceiptLinkId: string;
  importShipmentLineId: string;
  purchaseReceiptLineId: string;
  purchaseReceiptId: string;
  receiptStatus: PurchaseReceiptStatus;
  linkStatus: 'ACTIVE' | 'CANCELLED';
  linkedQuantity: Prisma.Decimal;
  receiptLineProductId: string | null;
  receiptLinePurchaseInvoiceLineId: string;
}

/**
 * Reconciliación PURA (Fase B4, CLAUDE.md B4 §2) de UNA línea de embarque
 * contra sus vínculos de recepción física (B3) — extraída de
 * ImportReportsService para que la clasificación de discrepancias sea
 * directamente verificable sin mockear Prisma. Nunca equipara cantidad
 * sin vincular con pérdida o faltante comprobado. Las cantidades
 * CANCELLED (de `links`) nunca participan en `linkedQuantity`/
 * `remainingQuantity`, solo se preservan en `links` para trazabilidad.
 */
export function buildReconciliationRow(
  line: ShipmentLineRow,
  links: ReceiptLinkRow[],
): ShipmentReconciliationRow {
  const activeLinks = links.filter((l) => l.linkStatus === 'ACTIVE');
  const linkedQuantity = activeLinks.reduce(
    (sum, l) => sum.plus(l.linkedQuantity),
    ZERO,
  );
  const remainingRaw = line.plannedQuantity.minus(linkedQuantity);
  const remainingQuantity = remainingRaw.lessThan(0) ? ZERO : remainingRaw;

  const discrepancyCodes: ShipmentDiscrepancyCode[] = [];
  if (remainingRaw.lessThan(0)) {
    discrepancyCodes.push('QUANTITY_EXCEEDS_SHIPPED');
  }
  if (line.shipmentStatus === ImportShipmentStatus.ARRIVED) {
    if (remainingQuantity.greaterThan(0)) {
      discrepancyCodes.push(
        linkedQuantity.greaterThan(0)
          ? 'PARTIAL_RECEIPT_LINKAGE'
          : 'ARRIVED_WITH_UNLINKED_CARGO',
      );
    }
    if (line.purchaseInvoiceLineId === null) {
      discrepancyCodes.push('MISSING_PURCHASE_INVOICE_LINK');
    }
  }
  for (const link of activeLinks) {
    const productMismatch =
      line.productId !== null &&
      link.receiptLineProductId !== null &&
      line.productId !== link.receiptLineProductId;
    const invoiceLineMismatch =
      line.purchaseInvoiceLineId !== null &&
      line.purchaseInvoiceLineId !== link.receiptLinePurchaseInvoiceLineId;
    if (
      (productMismatch || invoiceLineMismatch) &&
      !discrepancyCodes.includes('INCONSISTENT_PRODUCT_REFERENCE')
    ) {
      discrepancyCodes.push('INCONSISTENT_PRODUCT_REFERENCE');
    }
  }

  const linkRefs: ShipmentReconciliationLinkRef[] = links.map((l) => ({
    importReceiptLinkId: l.importReceiptLinkId,
    purchaseReceiptLineId: l.purchaseReceiptLineId,
    purchaseReceiptId: l.purchaseReceiptId,
    receiptStatus: l.receiptStatus,
    linkStatus: l.linkStatus,
    linkedQuantity: l.linkedQuantity.toFixed(3),
  }));

  return {
    importShipmentLineId: line.id,
    importShipmentId: line.importShipmentId,
    importOperationId: line.importOperationId,
    shipmentStatus: line.shipmentStatus,
    productId: line.productId,
    descriptionSnapshot: line.descriptionSnapshot,
    unitCode: line.unitCode,
    purchaseInvoiceLineId: line.purchaseInvoiceLineId,
    plannedQuantity: line.plannedQuantity.toFixed(3),
    linkedQuantity: linkedQuantity.toFixed(3),
    remainingQuantity: remainingQuantity.toFixed(3),
    links: linkRefs,
    discrepancyCodes,
  };
}

/**
 * Clasificación PURA con precedencia fija (CLAUDE.md B4 §4): una
 * inconsistencia de datos real es siempre lo más urgente; un vínculo
 * operativo pendiente (mercadería sin recepción vinculada) es más
 * fundamental que una brecha financiera; dentro de lo financiero, FX es
 * más bloqueante que la política de capitalización (que NUNCA existe
 * todavía en este sistema — CLAUDE.md B4 §3/§7). Nunca reporta el total
 * asignado/atribuido como costo de inventario aprobado ni lo compara
 * contra el mayor contable como si ya estuviera contabilizado.
 */
export function classifyReconciliation(
  discrepancyCodes: ShipmentDiscrepancyCode[],
  expensesByCurrency: ExpenseCurrencyAggregate[],
): { status: ConsolidatedReconciliationStatus; reasons: string[] } {
  const reasons: string[] = [];

  const hasDataInconsistency = discrepancyCodes.some(
    (c) =>
      c === 'QUANTITY_EXCEEDS_SHIPPED' ||
      c === 'INCONSISTENT_PRODUCT_REFERENCE',
  );
  if (hasDataInconsistency) {
    reasons.push(
      'Se detectaron cantidades o referencias inconsistentes entre embarque y recepción física — requiere corrección manual antes de cualquier reconciliación financiera.',
    );
    return { status: 'DATA_INCONSISTENCY', reasons };
  }

  const hasOperationalGap =
    discrepancyCodes.includes('ARRIVED_WITH_UNLINKED_CARGO') ||
    discrepancyCodes.includes('PARTIAL_RECEIPT_LINKAGE');
  if (hasOperationalGap) {
    reasons.push(
      'Existe mercadería ARRIVED todavía sin vínculo a una recepción física (PurchaseReceiptLine) — no implica pérdida ni faltante, puede ser mercadería no recibida aún o un vínculo administrativo pendiente.',
    );
    return { status: 'PARTIAL_PENDING_OPERATIONAL_LINK', reasons };
  }
  if (discrepancyCodes.includes('MISSING_PURCHASE_INVOICE_LINK')) {
    reasons.push(
      'Al menos una línea ARRIVED no tiene vínculo a una línea de factura de compra — dificulta la trazabilidad administrativa.',
    );
  }

  const hasForeignCurrency = expensesByCurrency.some(
    (c) => c.financialStatus === 'PENDING_FX',
  );
  if (hasForeignCurrency) {
    reasons.push(
      'Existen gastos de importación asignados en una moneda distinta a la de la empresa — requiere un proceso de tipo de cambio aprobado antes de cualquier aplicación financiera.',
    );
    return { status: 'PENDING_FX', reasons };
  }

  const hasAllocatedSameCurrency = expensesByCurrency.some(
    (c) =>
      c.financialStatus === 'PENDING_ACCOUNTING_POLICY' &&
      Number(c.allocatedAmount) > 0,
  );
  if (hasAllocatedSameCurrency) {
    reasons.push(
      'Existen montos asignados (B2) sin una política contable de capitalización de costos de importación aprobada — el monto asignado/atribuido NUNCA constituye un costo de inventario reconocido.',
    );
    return { status: 'PENDING_ACCOUNTING_POLICY', reasons };
  }

  reasons.push(
    'Sin discrepancias operativas detectadas y sin exposición financiera pendiente de clasificar.',
  );
  return { status: 'CONSISTENT', reasons };
}
