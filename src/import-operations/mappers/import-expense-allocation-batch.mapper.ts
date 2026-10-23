import { Prisma } from '@prisma/client';
import { SafeImportExpenseAllocationBatch } from '../types/safe-import-expense-allocation-batch';

const ACTOR_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

export const IMPORT_EXPENSE_ALLOCATION_BATCH_SAFE_SELECT = {
  id: true,
  importExpenseId: true,
  method: true,
  requestedAmount: true,
  createdBy: { select: ACTOR_SUMMARY_SELECT },
  createdAt: true,
  allocations: {
    select: { id: true, importShipmentLineId: true, amount: true },
    orderBy: { createdAt: 'asc' },
  },
} satisfies Prisma.ImportExpenseAllocationBatchSelect;

export type ImportExpenseAllocationBatchSafeRow =
  Prisma.ImportExpenseAllocationBatchGetPayload<{
    select: typeof IMPORT_EXPENSE_ALLOCATION_BATCH_SAFE_SELECT;
  }>;

export function toSafeImportExpenseAllocationBatch(
  row: ImportExpenseAllocationBatchSafeRow,
): SafeImportExpenseAllocationBatch {
  return {
    id: row.id,
    importExpenseId: row.importExpenseId,
    method: row.method,
    requestedAmount: row.requestedAmount.toFixed(2),
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    allocations: row.allocations.map((line) => ({
      id: line.id,
      importShipmentLineId: line.importShipmentLineId,
      amount: line.amount.toFixed(2),
    })),
  };
}
