import {
  AccountingEventType,
  AccountStatus,
  AccountType,
} from '@prisma/client';
import { NormalBalance } from '../account-hierarchy.utils';

export interface LedgerReportQuery {
  accountId: string;
  accountingDateFrom: string;
  accountingDateTo: string;
  page?: number;
  limit?: number;
}

/**
 * Movimiento individual de UNA cuenta (A3.2). runningBalance está expresado
 * en la dirección NATURAL de la cuenta (accountNormalBalance): crece con un
 * débito si la cuenta es de naturaleza deudora, con un crédito si es
 * acreedora — mismo criterio ya establecido por
 * account-hierarchy.utils.ts, nunca un segundo criterio de signo inventado
 * aquí.
 */
export interface LedgerMovementRow {
  entryId: string;
  accountingDate: string;
  periodId: string;
  journalNumber: number;
  description: string;
  eventType: AccountingEventType;
  sourceType: string;
  sourceId: string;
  debitAmount: string;
  creditAmount: string;
  runningBalance: string;
}

export interface LedgerReportResult {
  accountId: string;
  accountCode: string;
  accountName: string;
  accountType: AccountType;
  accountStatus: AccountStatus;
  normalBalance: NormalBalance;
  accountingDateFrom: string;
  accountingDateTo: string;
  openingBalance: string;
  closingBalance: string;
  data: LedgerMovementRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
