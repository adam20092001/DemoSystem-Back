/**
 * Entrada pública de InventoryService (Bloque B). No es un DTO HTTP: no
 * lleva decoradores de class-validator (esos viven en el Bloque C, en los
 * DTOs del controller). No incluye movementType/origin/direction/
 * auditAction/referenceType/referenceId/previousStock/newStock: el tipo, el
 * origen y las referencias los fija cada wrapper de InventoryService, nunca
 * el llamador.
 */
export interface RegisterMovementInput {
  productId: string;
  quantity: string;
  reason: string;
  notes?: string | null;
  actorUserId: string;
  ipAddress?: string | null;
}
