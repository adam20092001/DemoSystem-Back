import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PAYMENT_METHOD_CODE_PATTERN } from '../payment-methods/constants/payment-method.constants';
import {
  PAYMENT_CANCELLATION_REASON_MAX_LENGTH,
  PAYMENT_REFERENCE_MAX_LENGTH,
} from './constants/payment.constants';

/**
 * Forma textual estricta: solo dígitos, sin signo, sin notación científica,
 * sin coma decimal, máximo 12 enteros y 2 decimales (Decimal(14,2)). Mismo
 * criterio que QUANTITY_PATTERN/DISCOUNT_PATTERN (quote-calculator.ts).
 */
const PAYMENT_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** Máximo representable en Decimal(14,2): 12 enteros + 2 decimales. */
const MAX_PAYMENT_AMOUNT = new Prisma.Decimal('999999999999.99');

/**
 * Valida la forma/rango de un monto ya convertido a Prisma.Decimal, sin
 * confiar en que el llamador ya lo validó (mismo criterio defensivo que
 * StockMovementEngine.validateQuantityShape). Reutilizada por
 * parsePaymentAmount() y por PaymentEngine como segunda línea de defensa.
 */
export function assertValidPaymentAmountShape(amount: Prisma.Decimal): void {
  if (!Prisma.Decimal.isDecimal(amount) || !amount.isFinite()) {
    throw new BadRequestException('El monto debe ser un valor decimal válido');
  }
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestException('El monto debe ser mayor que cero');
  }
  if (amount.decimalPlaces() > 2) {
    throw new BadRequestException('El monto admite como máximo 2 decimales');
  }
  if (amount.greaterThan(MAX_PAYMENT_AMOUNT)) {
    throw new BadRequestException('El monto excede el máximo permitido');
  }
}

/**
 * Parsea y valida el monto de un pago. Nunca usa Number()/parseFloat(): todo
 * con Prisma.Decimal. No valida el saldo vigente de la venta (eso es una
 * verificación de estado en vivo, responsabilidad de PaymentsService/
 * SalesService, no de este parser puro).
 */
export function parsePaymentAmount(raw: string): Prisma.Decimal {
  if (typeof raw !== 'string' || !PAYMENT_AMOUNT_PATTERN.test(raw)) {
    throw new BadRequestException(
      'El monto debe ser un decimal positivo, como texto, con máximo 2 decimales',
    );
  }
  const amount = new Prisma.Decimal(raw);
  assertValidPaymentAmountShape(amount);
  return amount;
}

/**
 * Normaliza el CÓDIGO de método de pago recibido por HTTP: trim + mayúsculas
 * (Ticket C, Bloque C3 — misma política aprobada que
 * PaymentMethodsModule/PaymentMethodsService, reutilizando el MISMO literal
 * de formato — nunca un segundo regex divergente). Solo valida FORMA
 * (2-30 caracteres, letra inicial, luego A-Z/0-9/guion bajo); nunca resuelve
 * existencia/actividad aquí — eso ocurre en PaymentEngine.register(), dentro
 * de la transacción, contra la fila real de PaymentMethod.
 */
export function normalizePaymentMethodCode(raw: string): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException(
      'method es obligatorio y debe ser un código de texto',
    );
  }
  const normalized = raw.trim().toUpperCase();
  if (!PAYMENT_METHOD_CODE_PATTERN.test(normalized)) {
    throw new BadRequestException(
      'method debe ser un código de método de pago válido (2-30 caracteres, inicia con A-Z, luego solo A-Z/0-9/guion bajo)',
    );
  }
  return normalized;
}

/**
 * Revalida que un PaymentMethod dinámico resuelto con requiresReference=true
 * efectivamente tenga una referencia ya normalizada. Segunda línea de
 * defensa dentro de PaymentEngine — a diferencia del Bloque B (enum fijo con
 * membresía de un Set), desde el Bloque C3 la exigencia depende ÚNICAMENTE
 * de la fila dinámica resuelta dentro de la misma transacción: nunca se
 * puede evaluar antes de resolver el método (ver normalizePaymentReference()
 * más abajo, que ya NO decide esto).
 */
export function assertReferenceRequiredForMethod(
  requiresReference: boolean,
  reference: string | null,
): void {
  if (requiresReference && reference === null) {
    throw new BadRequestException(
      'Este método de pago requiere una referencia',
    );
  }
}

/**
 * Normaliza el TEXTO de una referencia de pago: recorta espacios, cadena
 * vacía tras recortar -> null, valida longitud máxima. Ya NO decide si es
 * obligatoria (Ticket C, Bloque C3): esa regla depende del PaymentMethod
 * dinámico resuelto, que este parser temprano (llamado por
 * PaymentsService/SalesService antes de abrir la transacción de
 * PaymentEngine) todavía no conoce — ver assertReferenceRequiredForMethod(),
 * invocada por separado una vez resuelto el método dentro de la transacción.
 */
export function normalizePaymentReference(
  reference?: string | null,
): string | null {
  if (
    reference !== undefined &&
    reference !== null &&
    typeof reference !== 'string'
  ) {
    throw new BadRequestException('La referencia debe ser un texto válido');
  }
  const trimmed = typeof reference === 'string' ? reference.trim() : null;
  const normalized = trimmed === '' ? null : trimmed;
  if (normalized !== null && normalized.length > PAYMENT_REFERENCE_MAX_LENGTH) {
    throw new BadRequestException(
      `La referencia no puede superar los ${PAYMENT_REFERENCE_MAX_LENGTH} caracteres`,
    );
  }
  return normalized;
}

/**
 * Normaliza el motivo de una anulación MANUAL de pago (nunca usado para
 * SALE_CANCELLATION, cuyo motivo siempre es null — D2 aprobado). Mismo
 * criterio de trim/no-vacío/longitud máxima que
 * SalesService.normalizeCancellationReason.
 */
export function normalizePaymentCancellationReason(reason: string): string {
  if (typeof reason !== 'string') {
    throw new BadRequestException('El motivo de anulación es obligatorio');
  }
  const trimmed = reason.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException(
      'El motivo de anulación no puede estar vacío',
    );
  }
  if (trimmed.length > PAYMENT_CANCELLATION_REASON_MAX_LENGTH) {
    throw new BadRequestException(
      `El motivo de anulación no puede superar los ${PAYMENT_CANCELLATION_REASON_MAX_LENGTH} caracteres`,
    );
  }
  return trimmed;
}
