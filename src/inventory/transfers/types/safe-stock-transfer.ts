import {
  MovementCreatedBySummary,
  MovementLocationSummary,
  MovementProductSummary,
} from '../../types/safe-inventory-movement';

/**
 * Forma segura de una transferencia (R2-C). Nunca incluye importes de costo
 * ni referencias contables: una transferencia no tiene efecto financiero.
 */
export interface SafeStockTransfer {
  id: string;
  product: MovementProductSummary;
  sourceLocation: MovementLocationSummary;
  destinationLocation: MovementLocationSummary;
  /** Decimal con 3 decimales fijos, como string. */
  quantity: string;
  reason: string;
  notes: string | null;
  idempotencyKey: string | null;
  createdBy: MovementCreatedBySummary;
  exitMovementId: string;
  entryMovementId: string;
  createdAt: Date;
}
