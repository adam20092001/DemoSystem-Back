import { AccountingEventType, AccountingSourceType } from '@prisma/client';

/**
 * Consulta interna del listado de asientos contables (Fase 8, Bloque C).
 * Sin saleNumber/paymentId/accountId/búsqueda de descripción/sort/rango de
 * monto/balance/status: el plan cerrado no los incluye — ver §14 del plan
 * aprobado.
 */
export interface ListAccountingEntriesQuery {
  page?: number;
  limit?: number;
  sourceType?: AccountingSourceType;
  eventType?: AccountingEventType;
  sourceId?: string;
  postedFrom?: string;
  postedTo?: string;
}
