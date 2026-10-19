import { LineDiscountType } from '@prisma/client';

export interface CreateQuoteItemInput {
  productId: string;
  /** Decimal como texto, nunca number de JavaScript. */
  quantity: string;
  /** NR-03: ambos presentes o ambos ausentes (ver parseLineDiscount()). */
  discountType?: LineDiscountType;
  discountValue?: string;
}

/**
 * sellerId nunca aparece aquí (D12): se deriva exclusivamente de
 * actorUserId dentro del servicio. number/status/issueDate/subtotal/
 * taxAmount/total/snapshots tampoco: son valores de sistema calculados por
 * QuotesService, nunca controlados por el llamador.
 */
export interface CreateQuoteInput {
  customerId: string;
  /**
   * YYYY-MM-DD. Ausente (Fase 10, Bloque B): QuotesService la calcula como
   * issueDate + CompanySettings.quoteValidityDays.
   */
  expirationDate?: string;
  discountAmount?: string;
  notes?: string;
  items: CreateQuoteItemInput[];
  actorUserId: string;
  ipAddress?: string | null;
}
