import { InitialPaymentInput } from '../../payments/types/payment.input';

export interface CreateSaleItemInput {
  productId: string;
  quantity: string;
}

/**
 * Input interno de venta directa (Bloque B). No es un DTO HTTP: sin
 * decoradores de class-validator, no se construye en ningún controller
 * todavía (eso llega en el Bloque C). `sellerId` no existe aquí a
 * propósito: para venta directa siempre es `actorUserId` (D10 del plan
 * aprobado); nunca se acepta del llamador. Tampoco existen number/status/
 * paymentStatus/paidAmount/balanceDue/deliveryStatus/unitPrice/lineTotal/
 * totales/snapshots/confirmedAt/notes: todos son valores de sistema
 * calculados por SalesService, nunca controlados por el llamador.
 * `payment` (Fase 7, Bloque B) es el ÚNICO dato de pago aceptado: opcional,
 * sin paidAt/status/actor propios (el actor ya es `actorUserId`).
 */
export interface CreateSaleInput {
  customerId: string;
  discountAmount?: string;
  items: CreateSaleItemInput[];
  payment?: InitialPaymentInput;
  actorUserId: string;
  ipAddress?: string | null;
}
