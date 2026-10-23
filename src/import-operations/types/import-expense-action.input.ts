/** Comando interno de ImportExpensesService.finalize() — no es un DTO HTTP. */
export interface FinalizeImportExpenseInput {
  importExpenseId: string;
  actorUserId: string;
  ipAddress: string | null;
}

/** Comando interno de ImportExpensesService.cancel() — no es un DTO HTTP. */
export interface CancelImportExpenseInput {
  importExpenseId: string;
  reason: string;
  actorUserId: string;
  ipAddress: string | null;
}
