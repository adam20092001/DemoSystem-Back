/** Comando interno de ImportOperationsService.create() — no es un DTO HTTP. */
export interface CreateImportOperationInput {
  /** R4: factura de compra principal (obligatoria). La referencia la genera el servidor. */
  purchaseInvoiceId: string;
  description?: string;
  originCountry: string;
  destinationCountry: string;
  externalReference?: string;
  notes?: string;
  actorUserId: string;
  ipAddress: string | null;
}
