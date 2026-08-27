import { FiscalDocumentType } from '@prisma/client';

/**
 * Comando interno de ElectronicDocumentsService.issue() (Bloque 11C §5). No
 * es un DTO HTTP: sin decoradores de class-validator, no se construye en
 * ningún controller (no existe controller en este bloque). La serie es
 * SIEMPRE explícita — el servicio nunca selecciona automáticamente la
 * primera FiscalSeries activa de un tipo de documento.
 */
export interface IssueElectronicDocumentCommand {
  saleId: string;
  documentType: FiscalDocumentType;
  series: string;
  /** null admitido por simetría con AuditService.record(), aunque en la práctica siempre habrá un actor autenticado. */
  actorUserId: string | null;
  ipAddress?: string | null;
}
