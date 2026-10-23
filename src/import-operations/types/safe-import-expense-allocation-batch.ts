import { ImportExpenseAllocationMethod } from '@prisma/client';

export interface SafeImportExpenseAllocationLine {
  id: string;
  importShipmentLineId: string;
  amount: string;
}

/** Respuesta segura de UN lote de asignación de gasto de importación (Fase B2), con sus líneas. */
export interface SafeImportExpenseAllocationBatch {
  id: string;
  importExpenseId: string;
  method: ImportExpenseAllocationMethod;
  requestedAmount: string;
  createdBy: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
  };
  createdAt: Date;
  allocations: SafeImportExpenseAllocationLine[];
}
