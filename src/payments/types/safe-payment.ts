import {
  PaymentCancellationSource,
  PaymentMethod,
  PaymentStatus,
} from '@prisma/client';

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
  method: PaymentMethod;
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
