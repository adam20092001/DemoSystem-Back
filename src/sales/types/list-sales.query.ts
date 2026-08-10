import {
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';

/**
 * Query interna de listado (Bloque B). `confirmedFrom`/`confirmedTo` son
 * fechas de negocio "YYYY-MM-DD" en America/Lima (nunca instantes), que el
 * servicio traduce a límites UTC mediante startOfBusinessDayUtc()/
 * endOfBusinessDayExclusiveUtc() antes de comparar contra Sale.confirmedAt.
 * Los tres enums admiten cualquier valor propio, incluido
 * SalePaymentStatus.PARTIALLY_PAID (D63): la Fase 6 nunca lo produce, pero
 * el filtro debe seguir siendo válido para preservar compatibilidad con la
 * Fase 7. Sin `sort`/`orderBy`: el orden es fijo (confirmedAt desc, id desc).
 */
export interface ListSalesQuery {
  page?: number;
  limit?: number;
  status?: SaleStatus;
  paymentStatus?: SalePaymentStatus;
  deliveryStatus?: SaleDeliveryStatus;
  customerId?: string;
  sellerId?: string;
  quoteId?: string;
  confirmedFrom?: string;
  confirmedTo?: string;
  search?: string;
}
