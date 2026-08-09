import { QuoteStatus } from '@prisma/client';

export interface ListQuotesQuery {
  page?: number;
  limit?: number;
  /** Estado EFECTIVO solicitado; el servicio lo traduce al predicado real (ver §33). */
  status?: QuoteStatus;
  customerId?: string;
  sellerId?: string;
  /** YYYY-MM-DD. */
  issueDateFrom?: string;
  issueDateTo?: string;
  expirationDateFrom?: string;
  expirationDateTo?: string;
  search?: string;
}
