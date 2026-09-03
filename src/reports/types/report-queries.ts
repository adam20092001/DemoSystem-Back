import { CustomerType, PaymentStatus, QuoteStatus } from '@prisma/client';

/**
 * Datos ya transformados y listos para ReportsService. Sin decoradores, sin
 * dependencias HTTP (mismo criterio que el resto del repositorio: el
 * controller nunca pasa el DTO crudo, siempre esta forma interna).
 *
 * `from`/`to` son fechas de negocio America/Lima (YYYY-MM-DD), un lado
 * opcional independiente del otro. R2/R3/R4 las aplican contra
 * Sale.confirmedAt (instante real) vía startOfBusinessDayUtc/
 * endOfBusinessDayExclusiveUtc; R8 las aplica contra Quote.issueDate
 * (columna @db.Date) vía toPrismaDate con gte/lte inclusive, siguiendo el
 * mismo criterio ya establecido en QuotesService. R9 las aplica contra
 * Payment.paidAt (instante real), igual que R2/R3/R4.
 */
export interface SalesByProductQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  categoryId?: string;
  productId?: string;
}

export interface SalesByCustomerQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  customerId?: string;
  customerType?: CustomerType;
}

export interface SalesBySellerQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  sellerId?: string;
}

export interface QuotesByStatusQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  status?: QuoteStatus;
  sellerId?: string;
  customerId?: string;
}

/** `method` (Ticket C, Bloque C3): código dinámico, filtrado contra el snapshot Payment.paymentMethodCode. */
export interface PaymentsByMethodQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  method?: string;
  status?: PaymentStatus;
  createdByUserId?: string;
}
