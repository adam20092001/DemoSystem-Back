import { PaymentMethod, Prisma } from '@prisma/client';

/**
 * Comando interno de PaymentEngine.register() (Bloque B). No es un DTO
 * HTTP: sin decoradores de class-validator, no se construye en ningún
 * controller. amount/reference ya llegan parseados/normalizados por el
 * llamador (PaymentsService/SalesService vía payment-calculator.ts); el
 * motor los revalida igual (defensa en profundidad, mismo criterio que
 * StockMovementCommand). saleNumber viaja explícito porque el motor nunca
 * consulta Sale por sí mismo (nunca abre transacción ni inyecta
 * PrismaService): lo necesita únicamente para la descripción/metadata de
 * auditoría.
 */
export interface RegisterPaymentCommand {
  saleId: string;
  saleNumber: string;
  method: PaymentMethod;
  amount: Prisma.Decimal;
  reference: string | null;
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de PaymentEngine.cancel() (anulación MANUAL, un único
 * pago). El motor mismo bloquea la fila (SELECT ... FOR UPDATE por
 * id+saleId): garantiza que el pago pertenece a la venta indicada, sin que
 * el llamador tenga que hacerlo por separado.
 */
export interface CancelPaymentCommand {
  saleId: string;
  saleNumber: string;
  paymentId: string;
  reason: string;
  actorUserId: string;
  ipAddress: string | null;
}

/**
 * Comando interno de PaymentEngine.cancelAllActiveForSale() — usado
 * EXCLUSIVAMENTE por SalesService.cancel() dentro de su propia transacción
 * de anulación de venta. cancellationSource siempre SALE_CANCELLATION,
 * cancellationReason siempre null (D2 aprobado): nunca se acepta un motivo
 * aquí, para que no exista la posibilidad de duplicar el texto libre de
 * Sale.cancellationReason dentro de un Payment. `cancelledAt` es el
 * instante único de la OPERACIÓN de anulación de venta (Fase 8, Bloque B,
 * plan final aprobado §30/§37): SalesService lo calcula una sola vez y lo
 * reutiliza aquí para cada Payment.cancelledAt Y para cada reversión
 * contable de pago, nunca instantes independientes por pago.
 */
export interface CancelAllActivePaymentsCommand {
  saleId: string;
  saleNumber: string;
  actorUserId: string;
  ipAddress: string | null;
  cancelledAt: Date;
}
