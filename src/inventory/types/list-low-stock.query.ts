import { ProductStatus } from '@prisma/client';

/**
 * Datos ya transformados y listos para InventoryService.listLowStock().
 * Sin decoradores, sin dependencias HTTP.
 */
export interface ListLowStockQuery {
  page?: number;
  limit?: number;
  categoryId?: string;
  unitId?: string;
  search?: string;
  brand?: string;
  status?: ProductStatus;
}
