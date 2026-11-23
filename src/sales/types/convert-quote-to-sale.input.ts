import { InitialPaymentInput } from '../../payments/types/payment.input';

/**
 * Input interno de conversión de cotización a venta (Bloque B). Sin cuerpo
 * comercial: los montos/ítems/precio se copian exactamente del Quote (D9).
 * `sellerId` tampoco aparece aquí: para venta desde cotización siempre es
 * Quote.sellerId (D10), nunca el actor que ejecuta la conversión — ese
 * actor queda trazado únicamente en AuditLog.userId. `payment` (Fase 7,
 * Bloque B) y `payments` (R1, lote) son los ÚNICOS datos de pago aceptados,
 * opcionales y mutuamente excluyentes: nunca un campo de
 * precio/descuento/cliente/vendedor — esos siguen siendo copia exacta e
 * inmutable del Quote.
 */
/** R2-B3: ubicación de origen de un producto inventariable de la cotización. */
export interface ConvertQuoteLocationInput {
  productId: string;
  locationId: string;
}

export interface ConvertQuoteToSaleInput {
  quoteId: string;
  /** R2-B3: opcional; los productos omitidos salen de MAIN/DEFAULT. */
  locations?: ConvertQuoteLocationInput[];
  payment?: InitialPaymentInput;
  payments?: InitialPaymentInput[];
  actorUserId: string;
  ipAddress?: string | null;
}
