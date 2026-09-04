import { BadRequestException } from '@nestjs/common';
import { Prisma, PaymentStatus } from '@prisma/client';

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

// ==========================================================================
// Ticket B, Bloque B3 — cierre/descuadre/aprobación/rechazo
// ==========================================================================

/** payments.amount es Decimal(14,2); mismo máximo que openingAmount. */
const MAX_COUNTED_CASH_AMOUNT = MAX_OPENING_AMOUNT;

/**
 * Valida la forma/rango del efectivo contado, ya convertido a
 * Prisma.Decimal. countedCashAmount representa efectivo físico contado —
 * nunca negativo (§19 del plan aprobado), mismo criterio que
 * openingAmount, nunca el signo de differenceAmount (que sí puede ser
 * negativo).
 */
export function assertValidCountedCashAmountShape(
  amount: Prisma.Decimal,
): void {
  if (!Prisma.Decimal.isDecimal(amount) || !amount.isFinite()) {
    throw new BadRequestException(
      'countedCashAmount debe ser un valor decimal válido',
    );
  }
  if (amount.isNegative()) {
    throw new BadRequestException('countedCashAmount no puede ser negativo');
  }
  if (amount.decimalPlaces() > 2) {
    throw new BadRequestException(
      'countedCashAmount admite como máximo 2 decimales',
    );
  }
  if (amount.greaterThan(MAX_COUNTED_CASH_AMOUNT)) {
    throw new BadRequestException(
      'countedCashAmount excede el máximo permitido',
    );
  }
}

/** Mismo patrón textual que parseOpeningAmount(); countedCashAmount es siempre obligatorio (nunca opcional) en un cierre. */
export function parseCountedCashAmount(raw: string): Prisma.Decimal {
  if (typeof raw !== 'string' || !OPENING_AMOUNT_PATTERN.test(raw)) {
    throw new BadRequestException(
      'countedCashAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
    );
  }
  const amount = new Prisma.Decimal(raw);
  assertValidCountedCashAmountShape(amount);
  return amount;
}

/** Alineado con cash_sessions.closing_observation / approval_comment VARCHAR(500). */
export const CASH_SESSION_OBSERVATION_MAX_LENGTH = 500;

/**
 * Normaliza un texto OPCIONAL de hasta 500 caracteres (closingObservation en
 * el caso zero-difference, approvalComment siempre): trim, cadena vacía tras
 * recortar -> null, mismo criterio que normalizePaymentReference(). Nunca
 * decide si el campo es obligatorio — eso es
 * assertClosingObservationRequiredForDifference(), evaluado después de
 * conocer differenceAmount.
 */
export function normalizeOptionalCashSessionText(
  raw: string | null | undefined,
): string | null {
  if (raw !== undefined && raw !== null && typeof raw !== 'string') {
    throw new BadRequestException('El texto debe ser una cadena válida');
  }
  const trimmed = typeof raw === 'string' ? raw.trim() : null;
  const normalized = trimmed === '' ? null : trimmed;
  if (
    normalized !== null &&
    normalized.length > CASH_SESSION_OBSERVATION_MAX_LENGTH
  ) {
    throw new BadRequestException(
      `El texto no puede superar los ${CASH_SESSION_OBSERVATION_MAX_LENGTH} caracteres`,
    );
  }
  return normalized;
}

/**
 * Motivo de rechazo: a diferencia de closingObservation/approvalComment,
 * SIEMPRE obligatorio y no vacío — mismo criterio que
 * normalizePaymentCancellationReason() (payments/payment-calculator.ts).
 */
export function normalizeRejectionReason(raw: string): string {
  if (typeof raw !== 'string') {
    throw new BadRequestException('El motivo de rechazo es obligatorio');
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) {
    throw new BadRequestException('El motivo de rechazo no puede estar vacío');
  }
  if (trimmed.length > CASH_SESSION_OBSERVATION_MAX_LENGTH) {
    throw new BadRequestException(
      `El motivo de rechazo no puede superar los ${CASH_SESSION_OBSERVATION_MAX_LENGTH} caracteres`,
    );
  }
  return trimmed;
}

/**
 * Exige closingObservation no vacía SOLO cuando hay descuadre — nunca antes
 * de conocer differenceAmount (§4 del plan aprobado: "Do not require
 * observation before the server knows the calculated difference"). Un
 * cierre exacto (difference=0) nunca pasa por aquí como obligatorio.
 */
export function assertClosingObservationRequiredForDifference(
  differenceAmount: Prisma.Decimal,
  closingObservation: string | null,
): void {
  if (
    !differenceAmount.isZero() &&
    (closingObservation === null || closingObservation.trim().length === 0)
  ) {
    throw new BadRequestException(
      'closingObservation es obligatoria y no puede estar en blanco cuando el cierre presenta un descuadre',
    );
  }
}

/**
 * differenceAmount = countedCashAmount - expectedCashAmount (§5 del plan
 * aprobado). NUNCA punto flotante: NUMERIC(14,2)/Prisma.Decimal es exacto,
 * mismo criterio que el CHECK `cash_sessions_difference_arithmetic`
 * (Bloque B1) al que este cálculo debe coincidir exactamente byte a byte.
 */
export function calculateDifference(
  countedCashAmount: Prisma.Decimal,
  expectedCashAmount: Prisma.Decimal,
): Prisma.Decimal {
  return countedCashAmount.minus(expectedCashAmount);
}

/** Snapshot mínimo de Payment necesario para el cálculo — nunca el modelo Prisma completo. */
export interface CashSessionPaymentSnapshot {
  amount: Prisma.Decimal;
  status: PaymentStatus;
  paymentMethodId: string;
  paymentMethodCode: string;
  paymentMethodName: string;
  paymentMethodAffectsCashDrawer: boolean;
}

/** Una fila del desglose por método, construida enteramente desde snapshots de Payment. */
export interface CashSessionMethodBreakdownRow {
  paymentMethodId: string;
  paymentMethodCode: string;
  paymentMethodName: string;
  totalAmount: Prisma.Decimal;
}

export interface CashSessionTotals {
  /** Suma de TODOS los Payment ACTIVE vinculados, sin importar el método. */
  collectionsTotal: Prisma.Decimal;
  /** Suma de los Payment ACTIVE vinculados cuyo snapshot paymentMethodAffectsCashDrawer=true. */
  cashCollectionsTotal: Prisma.Decimal;
  /** openingAmount + cashCollectionsTotal (§5/§6 del plan aprobado). */
  expectedCashAmount: Prisma.Decimal;
  /** Una fila por método efectivamente representado por >=1 Payment ACTIVE — nunca filas en cero. */
  breakdown: CashSessionMethodBreakdownRow[];
}

/**
 * Calcula expectedCashAmount/collectionsTotal/cashCollectionsTotal/desglose
 * por método a partir de openingAmount + los Payment vinculados a una
 * CashSession (§5/§6/§7 del plan aprobado).
 *
 * CRÍTICO: usa exclusivamente el SNAPSHOT de cobro de cada Payment
 * (paymentMethodCode/paymentMethodName/paymentMethodAffectsCashDrawer,
 * Ticket C Bloque C3) — nunca el PaymentMethod dinámico actual, que pudo
 * cambiar de nombre o de affectsCashDrawer después del cobro. Filtra
 * status=ACTIVE INTERNAMENTE (nunca confía en que el llamador ya excluyó
 * CANCELLED — mismo criterio defensivo que assertValidPaymentAmountShape):
 * el llamador puede pasar la lista completa de Payments de la sesión, de
 * cualquier estado, sin recalcular nada por su cuenta.
 */
export function calculateCashSessionTotals(
  openingAmount: Prisma.Decimal,
  payments: readonly CashSessionPaymentSnapshot[],
): CashSessionTotals {
  const activePayments = payments.filter(
    (payment) => payment.status === PaymentStatus.ACTIVE,
  );

  let collectionsTotal = new Prisma.Decimal(0);
  let cashCollectionsTotal = new Prisma.Decimal(0);
  const breakdownByMethodId = new Map<string, CashSessionMethodBreakdownRow>();

  for (const payment of activePayments) {
    collectionsTotal = collectionsTotal.plus(payment.amount);
    if (payment.paymentMethodAffectsCashDrawer) {
      cashCollectionsTotal = cashCollectionsTotal.plus(payment.amount);
    }

    const existingRow = breakdownByMethodId.get(payment.paymentMethodId);
    if (existingRow === undefined) {
      breakdownByMethodId.set(payment.paymentMethodId, {
        paymentMethodId: payment.paymentMethodId,
        paymentMethodCode: payment.paymentMethodCode,
        paymentMethodName: payment.paymentMethodName,
        totalAmount: payment.amount,
      });
    } else {
      existingRow.totalAmount = existingRow.totalAmount.plus(payment.amount);
    }
  }

  return {
    collectionsTotal,
    cashCollectionsTotal,
    expectedCashAmount: openingAmount.plus(cashCollectionsTotal),
    breakdown: Array.from(breakdownByMethodId.values()),
  };
}
