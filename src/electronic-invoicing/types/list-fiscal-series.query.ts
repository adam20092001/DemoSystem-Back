import { FiscalDocumentType } from '@prisma/client';

/** Query interna de descubrimiento de series (Bloque 11D §20/§21). Sin paginación. */
export interface ListFiscalSeriesQuery {
  documentType?: FiscalDocumentType;
  active?: boolean;
}
