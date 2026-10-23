import {
  ImportExpenseCategory,
  ImportExpenseDocumentType,
  ImportExpenseStatus,
} from '@prisma/client';

interface SafeImportExpenseActor {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/** Respuesta segura de ImportExpense (Fase B2). */
export interface SafeImportExpense {
  id: string;
  importOperationId: string;
  category: ImportExpenseCategory;
  description: string | null;
  supplierId: string | null;
  purchaseInvoiceLineId: string | null;
  documentType: ImportExpenseDocumentType | null;
  documentReference: string | null;
  expenseDate: string;
  currencyCode: string;
  amount: string;
  remarks: string | null;
  status: ImportExpenseStatus;
  createdBy: SafeImportExpenseActor;
  createdAt: Date;
  updatedAt: Date;
  finalizedAt: Date | null;
  finalizedBy: SafeImportExpenseActor | null;
  cancelledAt: Date | null;
  cancelledBy: SafeImportExpenseActor | null;
  cancellationReason: string | null;
  /** Suma de ImportExpenseAllocation.amount de todos los lotes de este gasto — SIEMPRE en currencyCode, nunca convertida. */
  allocatedAmount: string;
  /** amount - allocatedAmount, nunca negativo por construcción (los lotes nunca exceden el remanente, ver ImportExpensesService). */
  unallocatedAmount: string;
}
