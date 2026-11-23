import { RoleName } from '@prisma/client';

/** Input interno de StockTransfersService.create() (no es un DTO HTTP). */
export interface CreateStockTransferInput {
  productId: string;
  sourceLocationId: string;
  destinationLocationId: string;
  quantity: string;
  reason: string;
  notes?: string;
  idempotencyKey?: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

/** Filtros ya transformados de GET /inventory/transfers. */
export interface ListStockTransfersQuery {
  page?: number;
  limit?: number;
  productId?: string;
  sourceLocationId?: string;
  destinationLocationId?: string;
  /** Almacén del origen O del destino. */
  warehouseId?: string;
  dateFrom?: Date;
  dateTo?: Date;
}
