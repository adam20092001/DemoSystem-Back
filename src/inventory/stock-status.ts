import { Prisma } from '@prisma/client';

/**
 * NR-04: clasificación de stock derivada, nunca persistida. El umbral es
 * SIEMPRE el `Product.stockMinimum` de cada producto (configurable por
 * ADMIN/WAREHOUSE desde antes de NR-04, Fase 9 Bloque A) — no existe un
 * umbral global fijo; "3" es únicamente el valor por defecto que
 * ProductsService aplica a un producto NUEVO cuando el llamador omite
 * stockMinimum (ver createProduct()), nunca una regla de clasificación.
 */
export type StockStatus = 'NORMAL' | 'LOW_STOCK' | 'OUT_OF_STOCK';

/**
 * stockCurrent = 0 -> OUT_OF_STOCK; 0 < stockCurrent <= stockMinimum ->
 * LOW_STOCK; en cualquier otro caso -> NORMAL. PURA: solo Prisma.Decimal,
 * sin acceso a base de datos. Reutilizada por InventoryService.listLowStock
 * (donde el resultado solo puede ser LOW_STOCK u OUT_OF_STOCK, porque ese
 * endpoint ya filtra por stockCurrent <= stockMinimum).
 */
export function deriveStockStatus(
  stockCurrent: Prisma.Decimal,
  stockMinimum: Prisma.Decimal,
): StockStatus {
  if (stockCurrent.lessThanOrEqualTo(0)) {
    return 'OUT_OF_STOCK';
  }
  if (stockCurrent.lessThanOrEqualTo(stockMinimum)) {
    return 'LOW_STOCK';
  }
  return 'NORMAL';
}
