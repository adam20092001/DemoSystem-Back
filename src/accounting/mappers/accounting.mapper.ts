import { Prisma } from '@prisma/client';
import {
  SafeAccountingEntry,
  SafeAccountingEntryListItem,
} from '../types/safe-accounting-entry';
import { SafeAccount } from '../types/safe-account';

/** Select explícito y seguro de una cuenta: nunca createdAt (sin caso de uso real, §8 del plan aprobado). */
export const ACCOUNT_SAFE_SELECT = {
  id: true,
  code: true,
  name: true,
  type: true,
  systemKey: true,
} satisfies Prisma.AccountSelect;

export type AccountSafeRow = Prisma.AccountGetPayload<{
  select: typeof ACCOUNT_SAFE_SELECT;
}>;

export function toSafeAccount(row: AccountSafeRow): SafeAccount {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    type: row.type,
    systemKey: row.systemKey,
  };
}

/** Select compacto del listado: sin lines, sin createdBy (§10 del plan aprobado). */
export const ACCOUNTING_ENTRY_LIST_SELECT = {
  id: true,
  sourceType: true,
  sourceId: true,
  eventType: true,
  reversesEntryId: true,
  description: true,
  postedAt: true,
  createdAt: true,
} satisfies Prisma.AccountingEntrySelect;

export type AccountingEntryListRow = Prisma.AccountingEntryGetPayload<{
  select: typeof ACCOUNTING_ENTRY_LIST_SELECT;
}>;

export function toSafeAccountingEntryListItem(
  row: AccountingEntryListRow,
): SafeAccountingEntryListItem {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    eventType: row.eventType,
    reversesEntryId: row.reversesEntryId,
    description: row.description,
    postedAt: row.postedAt,
    createdAt: row.createdAt,
  };
}

const ACCOUNTING_ENTRY_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

/**
 * Select del detalle: createdBy mínimo seguro + líneas con su cuenta ya
 * resuelta (join a chart_of_accounts, nunca snapshot duplicado — las
 * cuentas son inmutables en la Fase 8). Sin columna de orden de línea
 * aprobada en el esquema (§12/§24 del plan aprobado): orden determinista
 * createdAt ASC, id ASC directamente en el nested read de Prisma.
 */
export const ACCOUNTING_ENTRY_DETAIL_SELECT = {
  id: true,
  sourceType: true,
  sourceId: true,
  eventType: true,
  reversesEntryId: true,
  description: true,
  postedAt: true,
  createdAt: true,
  createdBy: { select: ACCOUNTING_ENTRY_USER_SELECT },
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

export type AccountingEntryDetailRow = Prisma.AccountingEntryGetPayload<{
  select: typeof ACCOUNTING_ENTRY_DETAIL_SELECT;
}>;

/** Decimal(14,2) siempre como string de 2 decimales, nunca Prisma.Decimal ni number. */
export function toSafeAccountingEntry(
  row: AccountingEntryDetailRow,
): SafeAccountingEntry {
  return {
    id: row.id,
    sourceType: row.sourceType,
    sourceId: row.sourceId,
    eventType: row.eventType,
    reversesEntryId: row.reversesEntryId,
    description: row.description,
    postedAt: row.postedAt,
    createdAt: row.createdAt,
    createdBy: row.createdBy,
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
