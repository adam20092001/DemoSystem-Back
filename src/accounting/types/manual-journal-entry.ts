import { ManualJournalDraftStatus, RoleName } from '@prisma/client';

export interface ManualJournalLineInput {
  accountId: string;
  debitAmount: string;
  creditAmount: string;
}

export interface CreateManualJournalDraftInput {
  accountingDate: string;
  description: string;
  lines?: ManualJournalLineInput[];
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

/** undefined = no tocar ese campo; `lines` presente SIEMPRE reemplaza el arreglo completo (nunca un parche línea a línea). */
export interface UpdateManualJournalDraftInput {
  draftId: string;
  accountingDate?: string;
  description?: string;
  lines?: ManualJournalLineInput[];
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

export interface PostManualJournalDraftInput {
  draftId: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

export interface ReverseManualJournalEntryInput {
  draftId: string;
  reason: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}

export interface ListManualJournalDraftsQuery {
  page?: number;
  limit?: number;
  status?: ManualJournalDraftStatus;
}

export interface SafeManualJournalDraftLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: string;
  creditAmount: string;
}

export interface SafeManualJournalDraft {
  id: string;
  accountingDate: string;
  description: string;
  status: ManualJournalDraftStatus;
  postedEntryId: string | null;
  createdByUserId: string;
  createdAt: Date;
  updatedAt: Date;
  lines: SafeManualJournalDraftLine[];
}
