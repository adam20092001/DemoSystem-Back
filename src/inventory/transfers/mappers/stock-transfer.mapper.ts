import { Prisma } from '@prisma/client';
import { SafeStockTransfer } from '../types/safe-stock-transfer';

const LOCATION_SUMMARY_SELECT = {
  id: true,
  code: true,
  name: true,
  warehouse: { select: { id: true, code: true } },
} satisfies Prisma.WarehouseLocationSelect;

/** Select explícito y seguro: nunca passwordHash/roleId del autor ni datos de costo. */
export const STOCK_TRANSFER_SAFE_SELECT = {
  id: true,
  product: { select: { id: true, sku: true, name: true } },
  sourceLocation: { select: LOCATION_SUMMARY_SELECT },
  destinationLocation: { select: LOCATION_SUMMARY_SELECT },
  quantity: true,
  reason: true,
  notes: true,
  idempotencyKey: true,
  createdBy: {
    select: { id: true, username: true, firstName: true, lastName: true },
  },
  exitMovementId: true,
  entryMovementId: true,
  createdAt: true,
} satisfies Prisma.StockTransferSelect;

export type StockTransferSafeRow = Prisma.StockTransferGetPayload<{
  select: typeof STOCK_TRANSFER_SAFE_SELECT;
}>;

export function toSafeStockTransfer(
  row: StockTransferSafeRow,
): SafeStockTransfer {
  return {
    id: row.id,
    product: row.product,
    sourceLocation: row.sourceLocation,
    destinationLocation: row.destinationLocation,
    quantity: row.quantity.toFixed(3),
    reason: row.reason,
    notes: row.notes,
    idempotencyKey: row.idempotencyKey,
    createdBy: row.createdBy,
    exitMovementId: row.exitMovementId,
    entryMovementId: row.entryMovementId,
    createdAt: row.createdAt,
  };
}
