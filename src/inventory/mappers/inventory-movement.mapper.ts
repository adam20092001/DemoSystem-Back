import { Prisma } from '@prisma/client';
import { SafeInventoryMovement } from '../types/safe-inventory-movement';

const MOVEMENT_PRODUCT_SUMMARY_SELECT = {
  id: true,
  sku: true,
  name: true,
} satisfies Prisma.ProductSelect;

const MOVEMENT_CREATED_BY_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

/**
 * Select explícito y seguro de un movimiento de inventario: nunca
 * passwordHash/roleId/failedLoginAttempts del autor, nunca
 * referenceType/referenceId (reservados para uso interno).
 */
export const INVENTORY_MOVEMENT_SAFE_SELECT = {
  id: true,
  product: { select: MOVEMENT_PRODUCT_SUMMARY_SELECT },
  movementType: true,
  origin: true,
  quantity: true,
  previousStock: true,
  newStock: true,
  reason: true,
  notes: true,
  createdBy: { select: MOVEMENT_CREATED_BY_SUMMARY_SELECT },
  createdAt: true,
} satisfies Prisma.InventoryMovementSelect;

export type InventoryMovementSafeRow = Prisma.InventoryMovementGetPayload<{
  select: typeof INVENTORY_MOVEMENT_SAFE_SELECT;
}>;

/** Decimal(14,3) siempre como string de 3 decimales, nunca Prisma.Decimal ni number. */
export function toSafeInventoryMovement(
  row: InventoryMovementSafeRow,
): SafeInventoryMovement {
  return {
    id: row.id,
    product: row.product,
    movementType: row.movementType,
    origin: row.origin,
    quantity: row.quantity.toFixed(3),
    previousStock: row.previousStock.toFixed(3),
    newStock: row.newStock.toFixed(3),
    reason: row.reason,
    notes: row.notes,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
  };
}
