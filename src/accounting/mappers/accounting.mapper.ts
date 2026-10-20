import { InternalServerErrorException } from '@nestjs/common';
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

/**
 * A1 (PCGE): `systemKey` es nullable en el schema desde la Fase A1 (una
 * cuenta PCGE nueva nace sin mapeo), pero `toSafeAccount()` solo recibe
 * filas YA filtradas por `AccountingService.listAccounts()`
 * (`systemKey: { not: null } `) — el único llamador de esta función en
 * todo el dominio. Si esa invariante se rompiera (un llamador nuevo
 * pasara una fila sin mapeo), es un error de programación interno, nunca
 * un caso de negocio: 500 explícito, jamás un `systemKey: null` filtrado
 * en silencio hacia `SafeAccount` (que sigue siendo no-nullable a
 * propósito — contrato histórico de GET /accounts, Fase 8).
 */
export function toSafeAccount(row: AccountSafeRow): SafeAccount {
  if (row.systemKey === null) {
    throw new InternalServerErrorException(
      'toSafeAccount() recibió una cuenta sin systemKey; el llamador debe filtrar systemKey no nulo antes de mapear',
    );
  }
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
