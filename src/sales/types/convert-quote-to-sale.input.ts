/**
 * Input interno de conversión de cotización a venta (Bloque B). Sin cuerpo
 * comercial: los montos/ítems/precio se copian exactamente del Quote (D9),
 * y en la Fase 6 no existe ningún dato de pago que aceptar todavía (D1).
 * `sellerId` tampoco aparece aquí: para venta desde cotización siempre es
 * Quote.sellerId (D10), nunca el actor que ejecuta la conversión — ese
 * actor queda trazado únicamente en AuditLog.userId.
 */
export interface ConvertQuoteToSaleInput {
  quoteId: string;
  actorUserId: string;
  ipAddress?: string | null;
}
