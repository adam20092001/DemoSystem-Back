/** Comando interno de InventoryValuationEngine.reverseForReceiptLine() — no es un DTO HTTP. */
export interface ReverseValuationForLineCommand {
  purchaseReceiptLineId: string;
  newInventoryMovementId: string;
  actorUserId: string;
  ipAddress: string | null;
}
