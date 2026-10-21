import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import { SafeManualJournalDraft } from '../types/manual-journal-entry';

export const MANUAL_JOURNAL_DRAFT_SAFE_SELECT = {
  id: true,
  accountingDate: true,
  description: true,
  status: true,
  postedEntryId: true,
  createdByUserId: true,
  createdAt: true,
  updatedAt: true,
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
} satisfies Prisma.ManualJournalDraftSelect;

export type ManualJournalDraftSafeRow = Prisma.ManualJournalDraftGetPayload<{
  select: typeof MANUAL_JOURNAL_DRAFT_SAFE_SELECT;
}>;

export function toSafeManualJournalDraft(
  row: ManualJournalDraftSafeRow,
): SafeManualJournalDraft {
  return {
    id: row.id,
    accountingDate: fromPrismaDate(row.accountingDate),
    description: row.description,
    status: row.status,
    postedEntryId: row.postedEntryId,
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lines: row.lines.map((line) => ({
      id: line.id,
      accountId: line.accountId,
      accountCode: line.account.code,
      accountName: line.account.name,
      debitAmount: line.debitAmount.toFixed(2),
      creditAmount: line.creditAmount.toFixed(2),
    })),
  };
}
