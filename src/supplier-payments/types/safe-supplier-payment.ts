import { SupplierPaymentStatus } from '@prisma/client';

export interface SafeSupplierPaymentAllocation {
  id: string;
  purchaseInvoiceId: string;
  /** En la moneda del PAGO (= moneda de la factura). */
  amount: string;
  /** Valor en libros cancelado, en la moneda de la EMPRESA (a la tasa histórica de la factura). */
  carryingBaseAmount: string;
  /** Importe pagado, en la moneda de la EMPRESA (a la tasa del pago). */
  settledBaseAmount: string;
  /** Pagado − valor en libros, moneda de la empresa: >0 pérdida cambiaria, <0 ganancia. */
  fxDifferenceAmount: string;
}

/** Respuesta segura de SupplierPayment. */
export interface SafeSupplierPayment {
  id: string;
  supplierId: string;
  paymentDate: string;
  /** En la moneda del PAGO. */
  amount: string;
  currencyCode: string;
  /** Moneda de la EMPRESA (contable). */
  baseCurrencyCode: string;
  /** Moneda de la empresa por 1 unidad de moneda del pago (1 si coinciden). */
  exchangeRate: string;
  exchangeRateDate: string;
  /** Equivalente del pago en la moneda de la EMPRESA. */
  baseAmount: string;
  /** Suma de las diferencias de cambio realizadas de sus asignaciones (>0 pérdida, <0 ganancia). */
  fxDifferenceAmount: string;
  paymentMethodId: string;
  paymentMethodCode: string;
  paymentMethodName: string;
  reference: string | null;
  idempotencyKey: string | null;
  status: SupplierPaymentStatus;
  postedEntryId: string;
  createdByUserId: string;
  cancelledAt: Date | null;
  cancelledByUserId: string | null;
  cancellationReason: string | null;
  createdAt: Date;
  updatedAt: Date;
  allocations: SafeSupplierPaymentAllocation[];
}
