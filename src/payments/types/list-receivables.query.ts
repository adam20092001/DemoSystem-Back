/**
 * Consulta interna de cuentas por cobrar (Bloque C: sin decoradores HTTP,
 * eso vive en ListReceivablesQueryDto). confirmedFrom/confirmedTo son
 * fechas de negocio America/Lima en formato YYYY-MM-DD, mismo criterio que
 * ListSalesQuery.confirmedFrom/confirmedTo.
 */
export interface ListReceivablesQuery {
  page?: number;
  limit?: number;
  customerId?: string;
  sellerId?: string;
  confirmedFrom?: string;
  confirmedTo?: string;
}
