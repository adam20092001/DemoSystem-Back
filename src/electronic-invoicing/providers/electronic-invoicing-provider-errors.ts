/**
 * Errores de frontera de proveedor (Bloque 11C, remediación final). Un
 * adaptador de proveedor real (futuro PSE/SUNAT directo) los lanza para
 * clasificar EXPLÍCITAMENTE qué tan seguro es reintentar un envío fallido.
 * `MockElectronicInvoicingProvider` nunca los lanza (siempre ACCEPTED); solo
 * un adaptador real o un doble de prueba los produce.
 *
 * Jerarquía deliberadamente plana (§4: "no complicated exception
 * hierarchies"): dos clases, sin herencia compartida, sin subtipos.
 */

/**
 * El adaptador SABE con certeza que el documento NO fue recibido ni
 * procesado remotamente (p. ej. el proveedor respondió explícitamente con
 * un rechazo de transporte antes de aceptar el payload, o confirmó por otro
 * medio que nunca llegó a procesarlo). Es seguro transicionar el documento
 * a SUBMISSION_FAILED y permitir un reintento futuro con el MISMO número
 * fiscal.
 *
 * Nunca debe lanzarse ante una ambigüedad real (timeout, conexión cortada
 * sin confirmación, error HTTP genérico): en esos casos corresponde
 * UnknownProviderSubmissionOutcomeError.
 */
export class RetryableProviderSubmissionError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'RetryableProviderSubmissionError';
  }
}

/**
 * El adaptador NO puede garantizar que el documento no fue recibido ni
 * procesado remotamente (p. ej. timeout antes de recibir respuesta, corte
 * de conexión a mitad de la solicitud). El documento debe permanecer
 * SUBMITTED, sin reintento automático, a la espera de una futura
 * reconciliación (getStatus) con un proveedor real.
 *
 * Política de cierre en falso (§5, decisión cerrada de este bloque):
 * cualquier excepción NO clasificada explícitamente como
 * RetryableProviderSubmissionError se trata con esta MISMA semántica
 * (resultado desconocido), aunque no sea una instancia literal de esta
 * clase — ver ElectronicDocumentsService.runSubmissionFlow().
 */
export class UnknownProviderSubmissionOutcomeError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = 'UnknownProviderSubmissionOutcomeError';
  }
}
