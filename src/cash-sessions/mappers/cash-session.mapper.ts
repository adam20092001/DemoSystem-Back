import { Prisma } from '@prisma/client';
import { CashSessionMethodBreakdownRow } from '../cash-session-calculator';
import {
  SafeCashSession,
  SafeCashSessionMethodBreakdownRow,
} from '../types/safe-cash-session';

/**
 * Select explícito: única fuente de verdad de qué sale hacia el dominio
 * HTTP. Nunca incluye la relación `user`/`approvedBy` completa — solo los
 * IDs planos (userId/approvedByUserId), mismo criterio que
 * PAYMENT_SAFE_SELECT nunca exponiendo más que createdBy/cancelledBy
 * mínimos. Sin `payments`/`paymentMethodSummaries`: B2 es lectura del
 * estado propio de la sesión, nunca de sus relaciones (eso es contenido de
 * un bloque de negocio posterior si alguna vez se necesita).
 */
export const CASH_SESSION_SAFE_SELECT = {
  id: true,
  userId: true,
  status: true,
  openingAmount: true,
  openedAt: true,
  closeRequestedAt: true,
  expectedCashAmount: true,
  countedCashAmount: true,
  differenceAmount: true,
  closingObservation: true,
  closedAt: true,
  approvedByUserId: true,
  approvedAt: true,
  approvalComment: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CashSessionSelect;

export type CashSessionSafeRow = Prisma.CashSessionGetPayload<{
  select: typeof CASH_SESSION_SAFE_SELECT;
}>;

/** Decimal(14,2) siempre como string de 2 decimales, nunca Prisma.Decimal ni number. */
export function toSafeCashSession(row: CashSessionSafeRow): SafeCashSession {
  return {
    id: row.id,
    userId: row.userId,
    status: row.status,
    openingAmount: row.openingAmount.toFixed(2),
    openedAt: row.openedAt,
    closeRequestedAt: row.closeRequestedAt,
    expectedCashAmount: row.expectedCashAmount?.toFixed(2) ?? null,
    countedCashAmount: row.countedCashAmount?.toFixed(2) ?? null,
    differenceAmount: row.differenceAmount?.toFixed(2) ?? null,
    closingObservation: row.closingObservation,
    closedAt: row.closedAt,
    approvedByUserId: row.approvedByUserId,
    approvedAt: row.approvedAt,
    approvalComment: row.approvalComment,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

// ==========================================================================
// Ticket B, Bloque B3 — Payments vinculados y desglose por método
// ==========================================================================

/**
 * Select mínimo de Payment necesario para
 * calculateCashSessionTotals()/CashSessionPaymentSnapshot — nunca el
 * modelo Payment completo. `status` se incluye a propósito: el cálculo
 * filtra ACTIVE internamente (defensa en profundidad), así que este select
 * trae CUALQUIER estado vinculado a la sesión, nunca pre-filtrado aquí.
 */
export const CASH_SESSION_LINKED_PAYMENT_SELECT = {
  amount: true,
  status: true,
  paymentMethodId: true,
  paymentMethodCode: true,
  paymentMethodName: true,
  paymentMethodAffectsCashDrawer: true,
} satisfies Prisma.PaymentSelect;

export type CashSessionLinkedPaymentRow = Prisma.PaymentGetPayload<{
  select: typeof CASH_SESSION_LINKED_PAYMENT_SELECT;
}>;

/** Select explícito de una fila YA PERSISTIDA de CashSessionPaymentMethodSummary (snapshot congelado del cierre). */
export const CASH_SESSION_PAYMENT_METHOD_SUMMARY_SAFE_SELECT = {
  paymentMethodId: true,
  paymentMethodCode: true,
  paymentMethodName: true,
  totalAmount: true,
} satisfies Prisma.CashSessionPaymentMethodSummarySelect;

export type CashSessionPaymentMethodSummarySafeRow =
  Prisma.CashSessionPaymentMethodSummaryGetPayload<{
    select: typeof CASH_SESSION_PAYMENT_METHOD_SUMMARY_SAFE_SELECT;
  }>;

/**
 * Convierte una fila de desglose (en vivo, del calculador puro, o
 * congelada, ya persistida en CashSessionPaymentMethodSummary) a su forma
 * seria — mismo shape en ambos orígenes, así que un único mapper sirve
 * para los dos casos de uso.
 */
export function toSafeCashSessionMethodBreakdownRow(
  row: CashSessionMethodBreakdownRow | CashSessionPaymentMethodSummarySafeRow,
): SafeCashSessionMethodBreakdownRow {
  return {
    paymentMethodId: row.paymentMethodId,
    paymentMethodCode: row.paymentMethodCode,
    paymentMethodName: row.paymentMethodName,
    totalAmount: row.totalAmount.toFixed(2),
  };
}
