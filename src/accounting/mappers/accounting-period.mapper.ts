import { Prisma } from '@prisma/client';
import { SafeAccountingPeriod } from '../types/safe-accounting-period';

const ACCOUNTING_PERIOD_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

export const ACCOUNTING_PERIOD_SAFE_SELECT = {
  id: true,
  year: true,
  month: true,
  status: true,
  lastJournalNumber: true,
  closedAt: true,
  closedBy: { select: ACCOUNTING_PERIOD_USER_SELECT },
  reopenedAt: true,
  reopenedBy: { select: ACCOUNTING_PERIOD_USER_SELECT },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.AccountingPeriodSelect;

export type AccountingPeriodSafeRow = Prisma.AccountingPeriodGetPayload<{
  select: typeof ACCOUNTING_PERIOD_SAFE_SELECT;
}>;

export function toSafeAccountingPeriod(
  row: AccountingPeriodSafeRow,
): SafeAccountingPeriod {
  return {
    id: row.id,
    year: row.year,
    month: row.month,
    status: row.status,
    lastJournalNumber: row.lastJournalNumber,
    closedAt: row.closedAt,
    closedBy: row.closedBy,
    reopenedAt: row.reopenedAt,
    reopenedBy: row.reopenedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
