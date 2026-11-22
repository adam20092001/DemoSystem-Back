import { MovementLocationSummary } from './safe-inventory-movement';

/** Una fila del desglose: ubicación y su cantidad (R2-B1b). */
export interface SafeStockByLocationRow {
  location: MovementLocationSummary;
  quantity: string;
}

/** Respuesta de GET /inventory/products/:productId/stock-by-location. */
export interface SafeProductStockByLocation {
  productId: string;
  sku: string;
  name: string;
  /** Consolidado (Product.stockCurrent). */
  stockCurrent: string;
  unitAbbreviation: string;
  allowDecimal: boolean;
  /**
   * Solo ubicaciones con cantidad > 0, ordenadas por código de almacén y de
   * ubicación. Una ubicación sin existencias (sin fila de saldo o con saldo 0)
   * se OMITE: el desglose suma exactamente stockCurrent.
   */
  locations: SafeStockByLocationRow[];
}
