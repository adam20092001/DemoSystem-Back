import { InitialPaymentInput } from '../../payments/types/payment.input';

/**
 * Input interno de conversión de cotización a venta (Bloque B). Sin cuerpo
 * comercial: los montos/ítems/precio se copian exactamente del Quote (D9).
 * `sellerId` tampoco aparece aquí: para venta desde cotización siempre es
 * Quote.sellerId (D10), nunca el actor que ejecuta la conversión — ese
 * actor queda trazado únicamente en AuditLog.userId. `payment` (Fase 7,
 * Bloque B) es el ÚNICO dato de pago aceptado, opcional: nunca un campo de
 * precio/descuento/cliente/vendedor — esos siguen siendo copia exacta e
 * inmutable del Quote.
 */
export interface ConvertQuoteToSaleInput {
  quoteId: string;
  payment?: InitialPaymentInput;
  actorUserId: string;
  ipAddress?: string | null;
}
