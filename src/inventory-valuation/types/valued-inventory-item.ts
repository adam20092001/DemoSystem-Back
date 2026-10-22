import { InventoryValuationMethod } from '@prisma/client';

/**
 * Existencias valorizadas de UN producto (Fase A6.1), calculadas SIEMPRE
 * en tiempo de lectura replay-ando el historial inmutable de
 * InventoryValuation — nunca una columna duplicada. `physicalStockCurrent`
 * se incluye solo como REFERENCIA (Product.stockCurrent, la única fuente
 * de verdad del inventario físico, gobernada exclusivamente por
 * StockMovementEngine): puede diferir de `valuedQuantity` a propósito —
 * p. ej. si la valorización se habilitó después de que el producto ya
 * tuviera stock, o una vez que A6.2 reste valorización por venta sin que
 * esta fase lo haga todavía.
 */
export interface ValuedInventoryItem {
  productId: string;
  sku: string;
  name: string;
  method: InventoryValuationMethod;
  physicalStockCurrent: string;
  valuedQuantity: string;
  weightedAverageUnitCost: string;
  totalValue: string;
}

export interface PendingValuationItem {
  inventoryMovementId: string;
  productId: string;
  sku: string;
  name: string;
  purchaseReceiptId: string | null;
  quantity: string;
  createdAt: Date;
}
