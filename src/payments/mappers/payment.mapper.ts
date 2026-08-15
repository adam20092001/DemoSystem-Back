import { Prisma } from '@prisma/client';
import { SafePayment } from '../types/safe-payment';

const PAYMENT_USER_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

/**
 * Select explícito y seguro de un pago: nunca passwordHash/roleId/campos de
 * seguridad de createdBy/cancelledBy, nunca la relación Sale completa.
 */
export const PAYMENT_SAFE_SELECT = {
  id: true,
  saleId: true,
  method: true,
  amount: true,
  reference: true,
  status: true,
  paidAt: true,
  createdBy: { select: PAYMENT_USER_SUMMARY_SELECT },
  cancelledAt: true,
  cancellationReason: true,
  cancellationSource: true,
  cancelledBy: { select: PAYMENT_USER_SUMMARY_SELECT },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentSelect;

export type PaymentSafeRow = Prisma.PaymentGetPayload<{
  select: typeof PAYMENT_SAFE_SELECT;
}>;

/** Decimal(14,2) siempre como string de 2 decimales, nunca Prisma.Decimal ni number. */
export function toSafePayment(row: PaymentSafeRow): SafePayment {
  return {
    id: row.id,
    saleId: row.saleId,
    method: row.method,
    amount: row.amount.toFixed(2),
    reference: row.reference,
    status: row.status,
    paidAt: row.paidAt,
    createdBy: row.createdBy,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    cancellationSource: row.cancellationSource,
    cancelledBy: row.cancelledBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
