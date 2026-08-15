import { SalePaymentStatus } from '@prisma/client';

/**
 * Fila segura de cuentas por cobrar (Sale.status=ACTIVE AND balanceDue>0).
 * Nunca el estado vigente de Customer, notas internas, referencia de
 * Payment, filas de Payment, inventario ni detalle de Quote.
 */
export interface ReceivableItem {
  saleId: string;
  saleNumber: string;

  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;

  sellerId: string;

  confirmedAt: Date;

  total: string;
  paidAmount: string;
  balanceDue: string;
  paymentStatus: SalePaymentStatus;

  daysOutstanding: number;
}
