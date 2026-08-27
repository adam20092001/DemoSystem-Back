import { CustomerDocumentType, FiscalDocumentType } from '@prisma/client';

/** Línea del payload enviado al proveedor: copia exacta de un ElectronicDocumentItem ya persistido. */
export interface ElectronicDocumentSubmissionItemPayload {
  lineNumber: number;
  productSku: string;
  description: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  /** Decimal con 3 decimales fijos, como string (mismo criterio que el resto del dominio). */
  quantity: string;
  /** Decimal con 2 decimales fijos, como string. */
  unitPrice: string;
  /** Decimal con 2 decimales fijos, como string. */
  lineTotal: string;
}

/**
 * Valor inmutable, neutral respecto al proveedor, construido EXCLUSIVAMENTE
 * a partir de los snapshots ya persistidos de ElectronicDocument +
 * ElectronicDocumentItem (Fase 11A #16/#19, Bloque 11C §21). Nunca incluye
 * el TransactionClient, CompanySettings, Customer, Sale ni Product en vivo,
 * ni contraseñas/secretos: cualquier dato que el proveedor necesite ya debe
 * estar copiado aquí en el momento de construir el payload.
 */
export interface ElectronicDocumentSubmissionPayload {
  documentId: string;
  documentType: FiscalDocumentType;
  series: string;
  number: number;
  currencyCode: string;

  issuerTaxId: string;
  issuerBusinessName: string;
  issuerAddress: string | null;

  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;

  /** Decimales con 2 decimales fijos, como string. */
  subtotal: string;
  discountAmount: string;
  taxableBase: string;
  taxAmount: string;
  total: string;

  items: readonly ElectronicDocumentSubmissionItemPayload[];
}

/**
 * Resultado neutral de una resolución FUNCIONAL del proveedor (aceptado o
 * rechazado por el propio proveedor). Un fallo TÉCNICO (red, timeout,
 * excepción) nunca se modela como este tipo: submit() lo propaga como una
 * excepción real (Bloque 11C §20/§28), nunca como un outcome más.
 */
export interface ProviderSubmissionResult {
  outcome: 'ACCEPTED' | 'REJECTED';
  /** Identificador externo asignado por el proveedor. null si el proveedor no lo informa. */
  externalId: string | null;
  /** Vocabulario crudo del proveedor, opaco para el dominio. Máx. 50 caracteres (columna provider_status). */
  providerStatus: string;
  /** Mensaje ya saneado para persistir/mostrar. Máx. 500 caracteres (columna provider_message). */
  providerMessage: string;
}

/**
 * Interfaz mínima de un proveedor de facturación electrónica (Bloque 11C
 * §20, decisión cerrada: sin getStatus() todavía — se agrega deliberadamente
 * cuando exista lógica real de reconciliación, no antes). MockElectronicInvoicingProvider
 * es la única implementación de este bloque; un futuro PSE/SUNAT directo
 * implementaría la misma interfaz sin tocar ElectronicDocumentsService.
 */
export interface ElectronicInvoicingProvider {
  /** Código estable persistido en ElectronicDocument.providerCode (p. ej. "MOCK"). */
  readonly code: string;

  /**
   * Envía el documento al proveedor. Se invoca SIEMPRE fuera de cualquier
   * transacción de base de datos (Bloque 11C §24). Debe RECHAZAR (throw)
   * ante cualquier fallo técnico — nunca debe devolver un
   * ProviderSubmissionResult para representar un error de comunicación.
   */
  submit(
    payload: ElectronicDocumentSubmissionPayload,
  ): Promise<ProviderSubmissionResult>;
}
