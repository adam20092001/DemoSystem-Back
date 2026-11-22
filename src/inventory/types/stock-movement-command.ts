import {
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
} from '@prisma/client';

/**
 * Comando interno de StockMovementEngine.apply() (Bloque B). No es un DTO
 * HTTP: no lleva decoradores de class-validator y no se construye en el
 * controller. quantity ya llega convertida a Prisma.Decimal — el motor no
 * acepta strings sin convertir. No incluye direction (se deriva de
 * movementType) ni auditAction (la resuelve el motor internamente), ni
 * previousStock/newStock (los calcula el motor), ni el TransactionClient
 * (es un parámetro separado de apply(), no parte del comando).
 */
export interface StockMovementCommand {
  productId: string;
  quantity: Prisma.Decimal;
  movementType: InventoryMovementType;
  origin: InventoryMovementOrigin;
  reason: string;
  notes: string | null;
  actorUserId: string;
  ipAddress: string | null;
  referenceType: string | null;
  referenceId: string | null;
  /**
   * R2-ACT: ubicación donde ocurre el movimiento. Opcional: si se omite se
   * usa la ubicación DEFAULT del almacén predeterminado (MAIN/DEFAULT).
   * Ningún endpoint público la expone todavía (selección explícita = R2-B);
   * solo los servicios internos pueden fijarla (p. ej. una reversa que
   * reingresa a la ubicación del movimiento original).
   */
  locationId?: string;
}
