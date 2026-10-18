import { FiscalDocumentType, RoleName } from '@prisma/client';

/**
 * Comando interno de ElectronicDocumentsService.issue() (Bloque 11C §5). No
 * es un DTO HTTP: sin decoradores de class-validator; lo construye
 * SaleElectronicDocumentsController.issue() a partir del actor autenticado.
 * La serie es SIEMPRE explícita — el servicio nunca selecciona
 * automáticamente la primera FiscalSeries activa de un tipo de documento.
 */
export interface IssueElectronicDocumentCommand {
  saleId: string;
  documentType: FiscalDocumentType;
  series: string;
  /** Identidad real del actor autenticado (nunca un sellerId enviado por el cliente). */
  actorUserId: string;
  /** P6-C2: rol ACTIVO del actor, usado por assertCanOperateSale() para decidir la propiedad de la venta. */
  actorRole: RoleName;
  ipAddress?: string | null;
}
