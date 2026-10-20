import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import { JournalEntryRow, JournalLineRow } from '../types/journal-report.types';
import { LedgerMovementRow } from '../types/ledger-report.types';

export const JOURNAL_ENTRY_SELECT = {
  id: true,
  sourceType: true,
  sourceId: true,
  eventType: true,
  reversesEntryId: true,
  description: true,
  postedAt: true,
  accountingDate: true,
  periodId: true,
  journalNumber: true,
  period: { select: { year: true, month: true } },
  lines: {
    select: {
      id: true,
      accountId: true,
      debitAmount: true,
      creditAmount: true,
      account: { select: { code: true, name: true } },
    },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.AccountingEntrySelect;

export type JournalEntryQueryRow = Prisma.AccountingEntryGetPayload<{
  select: typeof JOURNAL_ENTRY_SELECT;
}>;

/**
 * totalDebit/totalCredit se SUMAN aquí a partir de las líneas ya
 * persistidas (nunca recalculadas desde Sale/Quote/impuestos actuales —
 * A3.1: "never reconstruct historical journal amounts"). Ambos totales se
 * exponen siempre, incluso si por algún motivo no coincidieran: el
 * reporte muestra el dato real, nunca lo corrige en silencio.
 */
export function toJournalEntryRow(row: JournalEntryQueryRow): JournalEntryRow {
  const lines: JournalLineRow[] = row.lines.map((line) => ({
    id: line.id,
    accountId: line.accountId,
    accountCode: line.account.code,
    accountName: line.account.name,
    debitAmount: line.debitAmount.toFixed(2),
    creditAmount: line.creditAmount.toFixed(2),
  }));
  const totalDebit = row.lines.reduce(
    (sum, line) => sum.plus(line.debitAmount),
    new Prisma.Decimal(0),
  );
  const totalCredit = row.lines.reduce(
    (sum, line) => sum.plus(line.creditAmount),
    new Prisma.Decimal(0),
  );

  return {
    id: row.id,
    accountingDate: fromPrismaDate(row.accountingDate),
    periodId: row.periodId,
    periodYear: row.period.year,
    periodMonth: row.period.month,
    journalNumber: row.journalNumber,
    description: row.description,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    eventType: row.eventType,
    reversesEntryId: row.reversesEntryId,
    postedAt: row.postedAt,
    lines,
    totalDebit: totalDebit.toFixed(2),
    totalCredit: totalCredit.toFixed(2),
  };
}

export const LEDGER_LINE_SELECT = {
  id: true,
  debitAmount: true,
  creditAmount: true,
  entry: {
    select: {
      id: true,
      accountingDate: true,
      periodId: true,
      journalNumber: true,
      description: true,
      eventType: true,
      sourceType: true,
      sourceId: true,
    },
  },
} satisfies Prisma.AccountingEntryLineSelect;

export type LedgerLineQueryRow = Prisma.AccountingEntryLineGetPayload<{
  select: typeof LEDGER_LINE_SELECT;
}>;

/** runningBalance se calcula en el servicio (acumulado sobre toda la secuencia ordenada) y se inyecta aquí. */
export function toLedgerMovementRow(
  row: LedgerLineQueryRow,
  runningBalance: Prisma.Decimal,
): LedgerMovementRow {
  return {
    entryId: row.entry.id,
    accountingDate: fromPrismaDate(row.entry.accountingDate),
    periodId: row.entry.periodId,
    journalNumber: row.entry.journalNumber,
    description: row.entry.description,
    eventType: row.entry.eventType,
    sourceType: row.entry.sourceType,
    sourceId: row.entry.sourceId,
    debitAmount: row.debitAmount.toFixed(2),
    creditAmount: row.creditAmount.toFixed(2),
    runningBalance: runningBalance.toFixed(2),
  };
}
