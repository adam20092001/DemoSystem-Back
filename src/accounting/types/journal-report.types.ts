import { AccountingEventType, AccountingSourceType } from '@prisma/client';

export interface JournalReportQuery {
  accountingDateFrom: string;
  accountingDateTo: string;
  periodId?: string;
  page?: number;
  limit?: number;
}

export interface JournalLineRow {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: string;
  creditAmount: string;
}

/**
 * Una fila = un AccountingEntry COMPLETO con todas sus líneas (nunca una
 * línea suelta): la paginación de A3.1 corta por asiento, nunca a mitad de
 * uno, para que totalDebit/totalCredit de cada fila sean siempre exactos.
 */
export interface JournalEntryRow {
  id: string;
  accountingDate: string;
  periodId: string;
  periodYear: number;
  periodMonth: number;
  journalNumber: number;
  description: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  eventType: AccountingEventType;
  reversesEntryId: string | null;
  postedAt: Date;
  lines: JournalLineRow[];
  totalDebit: string;
  totalCredit: string;
}

export interface JournalReportResult {
  data: JournalEntryRow[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
  accountingDateFrom: string;
  accountingDateTo: string;
  periodId: string | null;
}
