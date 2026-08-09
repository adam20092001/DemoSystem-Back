export interface UpdateQuoteItemInput {
  productId: string;
  quantity: string;
}

/**
 * No expone number/status/customerId/sellerId/issueDate/totales/snapshots:
 * inmutables desde update() en la Fase 5. El cliente no puede reasignarse.
 * items ausente conserva los ítems actuales; presente exige no vacío y
 * reemplaza el conjunto completo (ver QuotesService.update()).
 */
export interface UpdateQuoteInput {
  quoteId: string;
  /** YYYY-MM-DD. undefined = no tocar. */
  expirationDate?: string;
  discountAmount?: string;
  /** undefined = no tocar; null = limpiar. */
  notes?: string | null;
  items?: UpdateQuoteItemInput[];
  actorUserId: string;
  ipAddress?: string | null;
}
