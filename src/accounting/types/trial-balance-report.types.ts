import { AccountStatus, AccountType } from '@prisma/client';

export interface TrialBalanceQuery {
  accountingDateFrom: string;
  accountingDateTo: string;
  /** Si se envía, SOLO estas cuentas (la reconciliación deja de aplicarse). */
  accountIds?: string[];
  /** Por defecto false: cuentas sin saldo ni movimiento relevante se omiten. */
  includeZeroBalances?: boolean;
}

export interface TrialBalanceAccountRow {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  accountStatus: AccountStatus;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  endingDebit: string;
  endingCredit: string;
}

/**
 * `applicable=false` cuando el llamador filtró un subconjunto de cuentas
 * (accountIds): en ese caso los *Balanced quedan en null — un subconjunto
 * arbitrario de cuentas nunca tiene por qué cuadrar por sí solo, y afirmar
 * "desbalanceado" sobre él sería un falso positivo. Los totales SÍ se
 * exponen siempre (son informativos), solo el booleano de cuadre se omite.
 */
export interface TrialBalanceReconciliation {
  applicable: boolean;
  openingBalanced: boolean | null;
  periodBalanced: boolean | null;
  endingBalanced: boolean | null;
  totalOpeningDebit: string;
  totalOpeningCredit: string;
  totalPeriodDebit: string;
  totalPeriodCredit: string;
  totalEndingDebit: string;
  totalEndingCredit: string;
}

export interface TrialBalanceReportResult {
  accountingDateFrom: string;
  accountingDateTo: string;
  data: TrialBalanceAccountRow[];
  reconciliation: TrialBalanceReconciliation;
}
