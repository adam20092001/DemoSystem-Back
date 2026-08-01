/** Respuesta de GET /inventory/products/:productId/stock. */
export interface SafeProductStock {
  productId: string;
  sku: string;
  name: string;
  stockCurrent: string;
  stockMinimum: string;
  unitAbbreviation: string;
  allowDecimal: boolean;
}

/** Resumen mínimo dentro de un elemento de stock bajo. */
export interface LowStockCategorySummary {
  id: string;
  name: string;
}

export interface LowStockUnitSummary {
  id: string;
  abbreviation: string;
}

/** Elemento de GET /inventory/low-stock. */
export interface SafeLowStockItem {
  id: string;
  sku: string;
  name: string;
  stockCurrent: string;
  stockMinimum: string;
  category: LowStockCategorySummary;
  unit: LowStockUnitSummary;
}
