import { RoleName } from '@prisma/client';

/**
 * Creación/apertura MANUAL de un periodo contable (ADMIN, A2.6) — distinta
 * de la auto-creación implícita de AccountingEngine (A2.4): esta es la vía
 * explícita para que ADMIN inicialice por adelantado un periodo futuro o
 * documente su apertura con auditoría propia. Nace siempre OPEN; no admite
 * crear un periodo ya CLOSED.
 */
export interface CreateAccountingPeriodInput {
  year: number;
  month: number;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
