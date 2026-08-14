import { BadRequestException } from '@nestjs/common';
import { PaymentMethod, Prisma } from '@prisma/client';
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
 * Métodos para los que el Documento Maestro (§16) exige referencia
 * obligatoria: "Referencia obligatoria para transferencia, depósito y
 * tarjeta." CASH/DIGITAL_WALLET/OTHER la admiten pero nunca la exigen.
 */
const METHODS_REQUIRING_REFERENCE: ReadonlySet<PaymentMethod> = new Set([
  PaymentMethod.BANK_TRANSFER,
  PaymentMethod.BANK_DEPOSIT,
  PaymentMethod.CARD,
]);

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
 * Revalida que un método que exige referencia (BANK_TRANSFER/BANK_DEPOSIT/
 * CARD) efectivamente tenga una ya normalizada. Segunda línea de defensa
 * reutilizada por PaymentEngine, independiente de normalizePaymentReference.
 */
export function assertReferenceRequiredForMethod(
  method: PaymentMethod,
  reference: string | null,
): void {
  if (METHODS_REQUIRING_REFERENCE.has(method) && reference === null) {
    throw new BadRequestException(
      'Este método de pago requiere una referencia',
    );
  }
}

/**
 * Normaliza la referencia de un pago: recorta espacios, cadena vacía tras
 * recortar -> null, valida longitud máxima y exige referencia no vacía para
 * BANK_TRANSFER/BANK_DEPOSIT/CARD (Documento Maestro §16). Opcional para
 * CASH/DIGITAL_WALLET/OTHER: nunca se inventa una exigencia adicional (p. ej.
 * un identificador de transacción de billetera digital) sin respaldo en el
 * documento maestro.
 */
export function normalizePaymentReference(
  method: PaymentMethod,
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
  assertReferenceRequiredForMethod(method, normalized);
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
