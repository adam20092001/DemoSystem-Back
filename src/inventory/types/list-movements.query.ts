import { InventoryMovementOrigin, InventoryMovementType } from '@prisma/client';

/**
 * Datos ya transformados y listos para InventoryService.listMovements() /
 * listProductMovements(). Sin decoradores, sin dependencias HTTP: lo
 * construye el controller a partir del DTO de query.
 */
export interface ListMovementsQuery {
  page?: number;
  limit?: number;
  productId?: string;
  movementType?: InventoryMovementType;
  origin?: InventoryMovementOrigin;
  createdByUserId?: string;
  dateFrom?: Date;
  dateTo?: Date;
  search?: string;
}
