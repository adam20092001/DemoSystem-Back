/**
 * Input público de PaymentsService.register() (pago posterior, Bloque B).
 * No es un DTO HTTP: sin decoradores, no se construye en ningún controller
 * todavía (Bloque C). amount llega como texto sin convertir (lo parsea el
 * propio servicio antes de abrir la transacción); status/paidAt/createdBy/
 * campos de anulación nunca se aceptan aquí: son valores de sistema.
 * `method` es el código dinámico crudo tal como llegó del DTO HTTP (Ticket
 * C, Bloque C3): PaymentsService no lo normaliza ni lo resuelve, solo lo
 * propaga — la resolución real ocurre dentro de PaymentEngine.register().
 */
export interface RegisterPaymentInput {
  saleId: string;
  method: string;
  amount: string;
  reference?: string;
  actorUserId: string;
  ipAddress?: string | null;
}

/**
 * Input público de PaymentsService.cancel() (anulación manual). El origen
 * (`source`) nunca lo elige el llamador público: PaymentsService siempre
 * invoca al motor con MANUAL (D2 aprobado); SALE_CANCELLATION es una vía
 * exclusiva de SalesService.cancel() -> PaymentEngine.cancelAllActiveForSale.
 */
export interface CancelPaymentInput {
  saleId: string;
  paymentId: string;
  reason: string;
  actorUserId: string;
  ipAddress?: string | null;
}

/**
 * Pago inicial opcional embebido en la confirmación de una venta (directa o
 * desde cotización, Bloque B). Sin paidAt/status/actor propios: el actor ya
 * es el actorUserId de la venta que lo contiene (D no hay un segundo actor
 * anidado). `method` es el código dinámico crudo, mismo criterio que
 * RegisterPaymentInput (Ticket C, Bloque C3).
 */
export interface InitialPaymentInput {
  method: string;
  amount: string;
  reference?: string;
}
