import { ImportExpenseAllocationMethod } from '@prisma/client';

export interface ManualAllocationLineInput {
  importShipmentLineId: string;
  amount: string;
}

/**
 * Comando interno de ImportExpensesService.allocate() — no es un DTO
 * HTTP. `amountToAllocate` es SIEMPRE explícito: nunca se asume
 * `ImportExpense.amount` completo por defecto (CLAUDE.md B2 §3). Exactamente
 * una de `shipmentLineIds` (QUANTITY/WEIGHT/VOLUME) o `manualAllocations`
 * (MANUAL) debe proveerse, según `method`.
 */
export interface AllocateImportExpenseInput {
  importExpenseId: string;
  method: ImportExpenseAllocationMethod;
  amountToAllocate: string;
  shipmentLineIds?: string[];
  manualAllocations?: ManualAllocationLineInput[];
  idempotencyKey?: string;
  actorUserId: string;
  ipAddress: string | null;
}

/** Comando interno de ImportExpensesService.previewAllocation() — reutiliza EXACTAMENTE el mismo cálculo, sin persistir ni auditar. */
export interface PreviewImportExpenseAllocationInput {
  importExpenseId: string;
  method: ImportExpenseAllocationMethod;
  amountToAllocate: string;
  shipmentLineIds?: string[];
  manualAllocations?: ManualAllocationLineInput[];
}
