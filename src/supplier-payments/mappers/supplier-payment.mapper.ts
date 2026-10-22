import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import {
  SafeSupplierPayment,
  SafeSupplierPaymentAllocation,
} from '../types/safe-supplier-payment';

export const SUPPLIER_PAYMENT_ALLOCATION_SAFE_SELECT = {
  id: true,
  purchaseInvoiceId: true,
  amount: true,
} satisfies Prisma.SupplierPaymentAllocationSelect;

export const SUPPLIER_PAYMENT_SAFE_SELECT = {
  id: true,
  supplierId: true,
  paymentDate: true,
  amount: true,
  currencyCode: true,
  paymentMethodId: true,
  paymentMethodCode: true,
  paymentMethodName: true,
  reference: true,
  idempotencyKey: true,
  status: true,
  postedEntryId: true,
  createdByUserId: true,
  cancelledAt: true,
  cancelledByUserId: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  allocations: {
    select: SUPPLIER_PAYMENT_ALLOCATION_SAFE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.SupplierPaymentSelect;

export type SupplierPaymentAllocationSafeRow =
  Prisma.SupplierPaymentAllocationGetPayload<{
    select: typeof SUPPLIER_PAYMENT_ALLOCATION_SAFE_SELECT;
  }>;

export type SupplierPaymentSafeRow = Prisma.SupplierPaymentGetPayload<{
  select: typeof SUPPLIER_PAYMENT_SAFE_SELECT;
}>;

function toSafeSupplierPaymentAllocation(
  row: SupplierPaymentAllocationSafeRow,
): SafeSupplierPaymentAllocation {
  return {
    id: row.id,
    purchaseInvoiceId: row.purchaseInvoiceId,
    amount: row.amount.toFixed(2),
  };
}

export function toSafeSupplierPayment(
  row: SupplierPaymentSafeRow,
): SafeSupplierPayment {
  return {
    id: row.id,
    supplierId: row.supplierId,
    paymentDate: fromPrismaDate(row.paymentDate),
    amount: row.amount.toFixed(2),
    currencyCode: row.currencyCode,
    paymentMethodId: row.paymentMethodId,
    paymentMethodCode: row.paymentMethodCode,
    paymentMethodName: row.paymentMethodName,
    reference: row.reference,
    idempotencyKey: row.idempotencyKey,
    status: row.status,
    postedEntryId: row.postedEntryId,
    createdByUserId: row.createdByUserId,
    cancelledAt: row.cancelledAt,
    cancelledByUserId: row.cancelledByUserId,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    allocations: row.allocations.map(toSafeSupplierPaymentAllocation),
  };
}
