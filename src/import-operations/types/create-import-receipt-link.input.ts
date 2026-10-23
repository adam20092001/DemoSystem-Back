/** Comando interno de ImportReceiptLinksService.create() — no es un DTO HTTP. */
export interface CreateImportReceiptLinkInput {
  importShipmentLineId: string;
  purchaseReceiptLineId: string;
  linkedQuantity: string;
  idempotencyKey?: string;
  actorUserId: string;
  ipAddress: string | null;
}

/** Comando interno de ImportReceiptLinksService.cancel() — no es un DTO HTTP. */
export interface CancelImportReceiptLinkInput {
  importReceiptLinkId: string;
  reason: string;
  actorUserId: string;
  ipAddress: string | null;
}
