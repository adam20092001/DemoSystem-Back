import { Prisma } from '@prisma/client';
import { SafePaymentMethod } from '../types/safe-payment-method';

/** Select explícito: única fuente de verdad de qué sale hacia el dominio HTTP. */
export const PAYMENT_METHOD_SAFE_SELECT = {
  id: true,
  code: true,
  name: true,
  active: true,
  requiresReference: true,
  affectsCashDrawer: true,
  accountingDestination: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.PaymentMethodSelect;

export type PaymentMethodSafeRow = Prisma.PaymentMethodGetPayload<{
  select: typeof PAYMENT_METHOD_SAFE_SELECT;
}>;

export function toSafePaymentMethod(
  row: PaymentMethodSafeRow,
): SafePaymentMethod {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    active: row.active,
    requiresReference: row.requiresReference,
    affectsCashDrawer: row.affectsCashDrawer,
    accountingDestination: row.accountingDestination,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
