import { AccountingPeriodStatus } from '@prisma/client';

/** Identidad mínima segura de un usuario, mismo criterio que SafeAccountingEntryUser. */
export interface SafeAccountingPeriodUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/**
 * Forma segura de un periodo contable mensual (Fase A2.1). closedAt/
 * closedBy reflejan el cierre MÁS RECIENTE (una reapertura nunca los
 * limpia: siguen siendo evidencia histórica de ese cierre); reopenedAt/
 * reopenedBy son null hasta la primera reapertura.
 */
export interface SafeAccountingPeriod {
  id: string;
  year: number;
  month: number;
  status: AccountingPeriodStatus;
  lastJournalNumber: number;
  closedAt: Date | null;
  closedBy: SafeAccountingPeriodUser | null;
  reopenedAt: Date | null;
  reopenedBy: SafeAccountingPeriodUser | null;
  createdAt: Date;
  updatedAt: Date;
}
