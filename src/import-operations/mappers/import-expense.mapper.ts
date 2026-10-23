import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import { SafeImportExpense } from '../types/safe-import-expense';

const ACTOR_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

export const IMPORT_EXPENSE_SAFE_SELECT = {
  id: true,
  importOperationId: true,
  category: true,
  description: true,
  supplierId: true,
  purchaseInvoiceLineId: true,
  documentType: true,
  documentReference: true,
  expenseDate: true,
  currencyCode: true,
  amount: true,
  remarks: true,
  status: true,
  createdBy: { select: ACTOR_SUMMARY_SELECT },
  createdAt: true,
  updatedAt: true,
  finalizedAt: true,
  finalizedBy: { select: ACTOR_SUMMARY_SELECT },
  cancelledAt: true,
  cancelledBy: { select: ACTOR_SUMMARY_SELECT },
  cancellationReason: true,
  // Fase B2: la suma de asignaciones se calcula SIEMPRE en tiempo de
  // lectura (nunca una columna duplicada) — aquí vía la relación anidada
  // completa (una sola consulta); ver toSafeImportExpense().
  allocationBatches: {
    select: { allocations: { select: { amount: true } } },
  },
} satisfies Prisma.ImportExpenseSelect;

export type ImportExpenseSafeRow = Prisma.ImportExpenseGetPayload<{
  select: typeof IMPORT_EXPENSE_SAFE_SELECT;
}>;

const ZERO = new Prisma.Decimal(0);

export function toSafeImportExpense(
  row: ImportExpenseSafeRow,
): SafeImportExpense {
  const allocatedAmount = row.allocationBatches.reduce(
    (batchSum, batch) =>
      batch.allocations.reduce(
        (lineSum, line) => lineSum.plus(line.amount),
        batchSum,
      ),
    ZERO,
  );
  const unallocatedAmount = row.amount.minus(allocatedAmount);

  return {
    id: row.id,
    importOperationId: row.importOperationId,
    category: row.category,
    description: row.description,
    supplierId: row.supplierId,
    purchaseInvoiceLineId: row.purchaseInvoiceLineId,
    documentType: row.documentType,
    documentReference: row.documentReference,
    expenseDate: fromPrismaDate(row.expenseDate),
    currencyCode: row.currencyCode,
    amount: row.amount.toFixed(2),
    remarks: row.remarks,
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    finalizedAt: row.finalizedAt,
    finalizedBy: row.finalizedBy,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
    allocatedAmount: allocatedAmount.toFixed(2),
    unallocatedAmount: unallocatedAmount.toFixed(2),
  };
}
