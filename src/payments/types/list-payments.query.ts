import { PaymentMethod, PaymentStatus } from '@prisma/client';

/**
 * Consulta interna de listado (Bloque B: sin decoradores HTTP todavía, eso
 * llega en el Bloque C con el DTO real). paidFrom/paidTo son fechas de
 * negocio America/Lima en formato YYYY-MM-DD, mismo criterio que
 * ListSalesQuery.confirmedFrom/confirmedTo.
 */
export interface ListPaymentsQuery {
  page?: number;
  limit?: number;
  method?: PaymentMethod;
  status?: PaymentStatus;
  createdByUserId?: string;
  paidFrom?: string;
  paidTo?: string;
}
