/** Comando interno de ImportOperationsService.create() — no es un DTO HTTP. */
export interface CreateImportOperationInput {
  reference: string;
  description?: string;
  originCountry: string;
  destinationCountry: string;
  externalReference?: string;
  notes?: string;
  actorUserId: string;
  ipAddress: string | null;
}
