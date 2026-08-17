import { AccountingEventType, AccountingSourceType } from '@prisma/client';

/**
 * Forma segura y compacta de un asiento contable para el listado (Fase 8,
 * Bloque C, §10 del plan aprobado). Nunca sourceNumber (requeriría una
 * consulta polimórfica adicional a Sale/Payment, fuera del plan cerrado),
 * nunca líneas ni createdBy: el libro diario debe permanecer compacto.
 */
export interface SafeAccountingEntryListItem {
  id: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  eventType: AccountingEventType;
  reversesEntryId: string | null;
  description: string;
  postedAt: Date;
  createdAt: Date;
}

/** Identidad mínima segura de un usuario, igual criterio que PaymentSafeRow.createdBy. */
export interface SafeAccountingEntryUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/**
 * Línea segura con el código/nombre de cuenta ya resueltos (join a
 * chart_of_accounts, nunca snapshot duplicado: las cuentas son inmutables
 * en este MVP — §24 del plan aprobado). Montos siempre string de 2
 * decimales fijos.
 */
export interface SafeAccountingEntryLine {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: string;
  creditAmount: string;
}

/** Forma segura completa del detalle de un asiento, con su actor y sus líneas. */
export interface SafeAccountingEntry extends SafeAccountingEntryListItem {
  createdBy: SafeAccountingEntryUser;
  lines: SafeAccountingEntryLine[];
}
