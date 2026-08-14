import { SalePaymentStatus, SaleStatus } from '@prisma/client';
import { SafePayment } from './safe-payment';

/**
 * Resumen mínimo de venta devuelto junto al pago mutado (D4 aprobado): nunca
 * la SafeSale completa (evita acoplar PaymentsService a la forma de detalle
 * de Sales para ahorrarle al cliente HTTP un segundo request).
 */
export interface SafeSalePaymentSummary {
  id: string;
  number: string;
  status: SaleStatus;
  total: string;
  paidAmount: string;
  balanceDue: string;
  paymentStatus: SalePaymentStatus;
}

/** Resultado devuelto por PaymentsService.register()/cancel(). */
export interface PaymentMutationResult {
  payment: SafePayment;
  sale: SafeSalePaymentSummary;
}
