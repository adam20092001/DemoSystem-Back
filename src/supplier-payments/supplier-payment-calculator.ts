import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PAYMENT_METHOD_CODE_PATTERN } from '../payment-methods/constants/payment-method.constants';
import { SUPPLIER_PAYMENT_REFERENCE_MAX_LENGTH } from './constants/supplier-payment.constants';

const ZERO = new Prisma.Decimal(0);

/** Mismo literal canónico que normalizePaymentMethodCode (payments/payment-calculator.ts) — nunca un segundo regex divergente. */
export function normalizeSupplierPaymentMethodCode(raw: string): string {
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

/** Copia del dominio (mismo criterio que assertReferenceRequiredForMethod, payments/payment-calculator.ts). */
export function assertReferenceRequiredForSupplierPaymentMethod(
  requiresReference: boolean,
  reference: string | null,
): void {
  if (requiresReference && reference === null) {
    throw new BadRequestException(
      'Este método de pago requiere una referencia',
    );
  }
}

export function normalizeSupplierPaymentReference(
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
  if (
    normalized !== null &&
    normalized.length > SUPPLIER_PAYMENT_REFERENCE_MAX_LENGTH
  ) {
    throw new BadRequestException(
      `La referencia no puede superar los ${SUPPLIER_PAYMENT_REFERENCE_MAX_LENGTH} caracteres`,
    );
  }
  return normalized;
}

/** Forma textual estricta, mismo criterio exacto que PAYMENT_AMOUNT_PATTERN (payment-calculator.ts) — copia propia del dominio. */
const SUPPLIER_PAYMENT_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;
const MAX_SUPPLIER_PAYMENT_AMOUNT = new Prisma.Decimal('999999999999.99');

export function parseSupplierPaymentAmount(raw: string): Prisma.Decimal {
  if (typeof raw !== 'string' || !SUPPLIER_PAYMENT_AMOUNT_PATTERN.test(raw)) {
    throw new BadRequestException(
      'El monto debe ser un decimal positivo, como texto, con máximo 2 decimales',
    );
  }
  const amount = new Prisma.Decimal(raw);
  assertValidSupplierPaymentAmountShape(amount);
  return amount;
}

export function assertValidSupplierPaymentAmountShape(
  amount: Prisma.Decimal,
): void {
  if (!Prisma.Decimal.isDecimal(amount) || !amount.isFinite()) {
    throw new BadRequestException('El monto debe ser un valor decimal válido');
  }
  if (amount.lessThanOrEqualTo(0)) {
    throw new BadRequestException('El monto debe ser mayor que cero');
  }
  if (amount.decimalPlaces() > 2) {
    throw new BadRequestException('El monto admite como máximo 2 decimales');
  }
  if (amount.greaterThan(MAX_SUPPLIER_PAYMENT_AMOUNT)) {
    throw new BadRequestException('El monto excede el máximo permitido');
  }
}

/**
 * Estado derivado de una cuenta por pagar — nunca persistido (mismo
 * criterio exacto que StockStatus/PurchaseInvoiceLineReceiptStatus):
 * paidAmount <= 0 -> UNPAID; paidAmount >= totalAmount -> PAID; en
 * cualquier otro caso -> PARTIALLY_PAID.
 */
export type AccountsPayableStatus = 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

export function computeAccountsPayableStatus(
  paidAmount: Prisma.Decimal,
  totalAmount: Prisma.Decimal,
): AccountsPayableStatus {
  if (paidAmount.lessThanOrEqualTo(0)) {
    return 'UNPAID';
  }
  if (paidAmount.greaterThanOrEqualTo(totalAmount)) {
    return 'PAID';
  }
  return 'PARTIALLY_PAID';
}

export interface LiabilityAllocationPlanItem {
  accountId: string;
  amount: Prisma.Decimal;
}

/**
 * Agrupa por cuenta de pasivo HISTÓRICA (nunca por systemKey vigente):
 * SupplierPaymentsService ya determinó, factura por factura, cuál cuenta
 * acreditó realmente su asiento PURCHASE original. Varias facturas pagadas
 * en el MISMO pago pueden compartir la misma cuenta (si ninguna reasignó
 * ACCOUNTS_PAYABLE entre confirmarlas) — se suman en una sola línea de
 * débito; si el mapeo cambió entre facturas, resultan líneas separadas por
 * cuenta, nunca mezcladas ni promediadas.
 */
export function groupLiabilityAmountsByAccount(
  items: ReadonlyArray<LiabilityAllocationPlanItem>,
): LiabilityAllocationPlanItem[] {
  const totals = new Map<string, Prisma.Decimal>();
  for (const item of items) {
    totals.set(
      item.accountId,
      (totals.get(item.accountId) ?? ZERO).plus(item.amount),
    );
  }
  return Array.from(totals.entries()).map(([accountId, amount]) => ({
    accountId,
    amount,
  }));
}
