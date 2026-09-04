import { CashSessionStatus } from '@prisma/client';

/**
 * Consulta interna de listado (Ticket B, Bloque B2). `userId` viaja aquí
 * como el filtro OPCIONAL solicitado por el cliente HTTP — nunca la
 * identidad del actor: CashSessionsService.list() decide por separado,
 * usando el actor real (nunca este campo), si SELLER debe quedar forzado a
 * su propio ID (ver §10/§11 del plan aprobado: "no confiar en el query
 * param").
 */
export interface ListCashSessionsQuery {
  page?: number;
  limit?: number;
  userId?: string;
  status?: CashSessionStatus;
  openedFrom?: string;
  openedTo?: string;
  closedFrom?: string;
  closedTo?: string;
  hasDifference?: boolean;
}
