import {
  ImportExpenseCategory,
  ImportExpenseDocumentType,
} from '@prisma/client';

/**
 * Comando interno de ImportExpensesService.update() — no es un DTO HTTP.
 * `status` nunca se edita aquí (usar finalize()/cancel()). Solo permitido
 * mientras el gasto está DRAFT. `amount`/`currencyCode` adicionalmente se
 * bloquean si YA existe al menos un lote de asignación (CLAUDE.md B2 §3):
 * cambiar el monto base invalidaría asignaciones ya calculadas. Mismo
 * criterio que UpdateImportOperationInput: ningún campo opcional admite
 * "limpiarse" a null, solo reemplazarse por un valor nuevo.
 */
export interface UpdateImportExpenseInput {
  importExpenseId: string;
  category?: ImportExpenseCategory;
  description?: string;
  supplierId?: string;
  purchaseInvoiceLineId?: string;
  documentType?: ImportExpenseDocumentType;
  documentReference?: string;
  expenseDate?: string;
  currencyCode?: string;
  amount?: string;
  remarks?: string;
  actorUserId: string;
  ipAddress: string | null;
}
