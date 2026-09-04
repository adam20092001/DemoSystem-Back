import { Prisma } from '@prisma/client';
import { SafeCashSession } from '../types/safe-cash-session';

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
