/** Comando interno de ImportOperationsService.complete() — no es un DTO HTTP. */
export interface CompleteImportOperationInput {
  importOperationId: string;
  actorUserId: string;
  ipAddress: string | null;
}

/** Comando interno de ImportOperationsService.cancel() — no es un DTO HTTP. */
export interface CancelImportOperationInput {
  importOperationId: string;
  reason: string;
  actorUserId: string;
  ipAddress: string | null;
}
