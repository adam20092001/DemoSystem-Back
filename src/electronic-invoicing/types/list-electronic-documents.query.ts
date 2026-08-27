import { ElectronicDocumentStatus, FiscalDocumentType } from '@prisma/client';

/**
 * Query interna de listado (Bloque 11D). `issuedFrom`/`issuedTo` son fechas
 * de negocio "YYYY-MM-DD" en America/Lima, traducidas a límites UTC contra
 * ElectronicDocument.issuedAt mediante startOfBusinessDayUtc()/
 * endOfBusinessDayExclusiveUtc(), mismo criterio que Sales/Quotes. Sin
 * `sort`/`orderBy`: el orden es fijo (issuedAt desc, id desc).
 */
export interface ListElectronicDocumentsQuery {
  page?: number;
  limit?: number;
  documentType?: FiscalDocumentType;
  status?: ElectronicDocumentStatus;
  series?: string;
  saleId?: string;
  customerDocumentNumber?: string;
  issuedFrom?: string;
  issuedTo?: string;
}
