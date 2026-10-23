import {
  ImportExpenseCategory,
  ImportExpenseDocumentType,
} from '@prisma/client';

/** Comando interno de ImportExpensesService.create() — no es un DTO HTTP. */
export interface CreateImportExpenseInput {
  importOperationId: string;
  category: ImportExpenseCategory;
  description?: string;
  supplierId?: string;
  purchaseInvoiceLineId?: string;
  documentType?: ImportExpenseDocumentType;
  documentReference?: string;
  expenseDate: string;
  currencyCode: string;
  amount: string;
  remarks?: string;
  actorUserId: string;
  ipAddress: string | null;
}
