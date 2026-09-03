import { PaymentStatus } from '@prisma/client';

/**
 * Consulta interna de listado (Bloque B: sin decoradores HTTP todavía, eso
 * llega en el Bloque C con el DTO real). paidFrom/paidTo son fechas de
 * negocio America/Lima en formato YYYY-MM-DD, mismo criterio que
 * ListSalesQuery.confirmedFrom/confirmedTo. `method` filtra por el CÓDIGO
 * dinámico snapshoteado (Payment.paymentMethodCode), nunca por un join en
 * vivo contra el PaymentMethod actual (Ticket C, Bloque C3): un listado
 * histórico debe usar la identidad de método que realmente tenía el pago
 * en el momento de cobrarse.
 */
export interface ListPaymentsQuery {
  page?: number;
  limit?: number;
  method?: string;
  status?: PaymentStatus;
  createdByUserId?: string;
  paidFrom?: string;
  paidTo?: string;
}
