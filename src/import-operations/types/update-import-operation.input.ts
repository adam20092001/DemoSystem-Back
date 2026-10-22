/**
 * Comando interno de ImportOperationsService.update() — no es un DTO HTTP.
 * `status` nunca se edita aquí (usar complete()/cancel()). Solo permitido
 * mientras la operación no es terminal (DRAFT/IN_PROGRESS).
 */
export interface UpdateImportOperationInput {
  importOperationId: string;
  description?: string | null;
  originCountry?: string;
  destinationCountry?: string;
  externalReference?: string | null;
  notes?: string | null;
  actorUserId: string;
  ipAddress: string | null;
}
