import { PaymentCancellationSource, PaymentStatus } from '@prisma/client';

/** Identidad mínima segura de un usuario: nunca role/passwordHash/campos de seguridad. */
export interface SafePaymentUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/**
 * Contrato seguro de un pago. Nunca expone la relación Sale completa ni
 * campos de seguridad de User: solo la identidad mínima de quien registró/
 * anuló. reference/cancellationReason pueden ser texto libre operativo pero
 * nunca datos de tarjeta (PAN/CVV) ni credenciales bancarias — el dominio
 * jamás los solicita ni los almacena.
 */
export interface SafePayment {
  id: string;
  saleId: string;
  /**
   * Snapshot histórico Payment.paymentMethodCode (Ticket C, Bloque C3), NO
   * el code actual del PaymentMethod dinámico (que puede haber cambiado de
   * nombre o desactivarse desde entonces). Nombre de propiedad preservado
   * a propósito (contrato HTTP retro-compatible: el cliente ya conocía
   * `method` como el código del método usado).
   */
  method: string;
  /** Snapshot histórico Payment.paymentMethodName — campo aditivo (Ticket C, Bloque C3), nunca el name actual del método dinámico. */
  methodName: string;
  amount: string;
  reference: string | null;
  status: PaymentStatus;
  paidAt: Date;

  createdBy: SafePaymentUser;

  cancelledAt: Date | null;
  cancellationReason: string | null;
  cancellationSource: PaymentCancellationSource | null;
  cancelledBy: SafePaymentUser | null;

  createdAt: Date;
  updatedAt: Date;
}
