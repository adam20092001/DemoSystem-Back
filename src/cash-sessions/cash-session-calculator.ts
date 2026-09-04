import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

/**
 * Forma textual estricta, mismo criterio que PAYMENT_AMOUNT_PATTERN
 * (payments/payment-calculator.ts): solo dígitos, sin signo, sin notación
 * científica, sin coma decimal, máximo 12 enteros y 2 decimales
 * (Decimal(14,2)). A diferencia del monto de un Payment, `openingAmount`
 * SÍ admite "0" (Ticket B, Bloque B1 §2: abrir caja sin fondo inicial es
 * una operación válida).
 */
const OPENING_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/** Máximo representable en Decimal(14,2): 12 enteros + 2 decimales. */
const MAX_OPENING_AMOUNT = new Prisma.Decimal('999999999999.99');

/**
 * Valida la forma/rango de un monto de apertura ya convertido a
 * Prisma.Decimal, sin confiar en que el llamador ya lo validó (mismo
 * criterio defensivo que assertValidPaymentAmountShape). Reutilizada por
 * parseOpeningAmount() y disponible como segunda línea de defensa para el
 * servicio.
 */
export function assertValidOpeningAmountShape(amount: Prisma.Decimal): void {
  if (!Prisma.Decimal.isDecimal(amount) || !amount.isFinite()) {
    throw new BadRequestException(
      'openingAmount debe ser un valor decimal válido',
    );
  }
  if (amount.isNegative()) {
    throw new BadRequestException('openingAmount no puede ser negativo');
  }
  if (amount.decimalPlaces() > 2) {
    throw new BadRequestException(
      'openingAmount admite como máximo 2 decimales',
    );
  }
  if (amount.greaterThan(MAX_OPENING_AMOUNT)) {
    throw new BadRequestException('openingAmount excede el máximo permitido');
  }
}

/**
 * Parsea y valida el monto de apertura de una CashSession. Nunca usa
 * Number()/parseFloat(): todo con Prisma.Decimal, mismo criterio que
 * parsePaymentAmount() (payments/payment-calculator.ts). Cero es válido
 * (caja abierta sin fondo inicial); negativo nunca lo es — el mismo
 * invariante que la CHECK de base de datos
 * `cash_sessions_opening_amount_non_negative` (Ticket B, Bloque B1), aquí
 * como primera línea de defensa en la capa de dominio.
 */
export function parseOpeningAmount(raw: string): Prisma.Decimal {
  if (typeof raw !== 'string' || !OPENING_AMOUNT_PATTERN.test(raw)) {
    throw new BadRequestException(
      'openingAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
    );
  }
  const amount = new Prisma.Decimal(raw);
  assertValidOpeningAmountShape(amount);
  return amount;
}
