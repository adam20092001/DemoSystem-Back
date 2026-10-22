/** Comando interno de InventoryValuationEngine.reverseForReceiptLine() — no es un DTO HTTP. */
export interface ReverseValuationForLineCommand {
  purchaseReceiptLineId: string;
  newInventoryMovementId: string;
  actorUserId: string;
  ipAddress: string | null;
}

/** Comando interno de InventoryValuationEngine.reverseForSaleItem() (Fase A6.2) — no es un DTO HTTP. */
export interface ReverseValuationForSaleItemCommand {
  saleItemId: string;
  newInventoryMovementId: string;
  actorUserId: string;
  ipAddress: string | null;
}
