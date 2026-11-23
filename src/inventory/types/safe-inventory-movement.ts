import { InventoryMovementOrigin, InventoryMovementType } from '@prisma/client';

/** Resumen mínimo del producto en un movimiento: nunca datos internos. */
export interface MovementProductSummary {
  id: string;
  sku: string;
  name: string;
}

/** Resumen mínimo del autor: nunca passwordHash/roleId/failedLoginAttempts. */
export interface MovementCreatedBySummary {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/** R2-B1b: ubicación afectada por el movimiento. */
export interface MovementLocationSummary {
  id: string;
  code: string;
  name: string;
  warehouse: { id: string; code: string };
}

/**
 * Forma segura de un movimiento de inventario para salir del dominio (la
 * usará el mapper del Bloque C). Los campos Decimal (quantity, previousStock,
 * newStock) viajan siempre como string de escala fija, nunca como instancias
 * de Prisma.Decimal. Nunca incluye referenceType/referenceId (reservados
 * para uso interno hasta que una fase futura los exponga explícitamente).
 */
export interface SafeInventoryMovement {
  id: string;
  product: MovementProductSummary;
  movementType: InventoryMovementType;
  origin: InventoryMovementOrigin;
  quantity: string;
  previousStock: string;
  newStock: string;
  reason: string;
  notes: string | null;
  createdBy: MovementCreatedBySummary;
  /** R2-B1b (aditivo): null en movimientos históricos sin ubicación. */
  location: MovementLocationSummary | null;
  /** R2-C (aditivo): id de la transferencia del movimiento; null si no es de una transferencia. */
  transferId: string | null;
  createdAt: Date;
}
