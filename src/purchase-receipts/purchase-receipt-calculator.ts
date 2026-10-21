import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);
const HALF_CENT = new Prisma.Decimal('0.005');
const ONE_CENT = new Prisma.Decimal('0.01');
const MAX_QUANTITY = new Prisma.Decimal('99999999999.999');

/**
 * ROUND_HALF_UP((numerator/divisor), 2) EXACTO — misma técnica y mismo
 * motivo que quote-calculator.ts/purchase-invoice-calculator.ts (doble
 * redondeo cerca del límite de medio céntimo); copia propia, nunca
 * importada (cada calculador de este dominio es dueño de sus propias
 * funciones puras).
 */
function roundHalfUpQuotient(
  numerator: Prisma.Decimal,
  divisor: Prisma.Decimal,
): Prisma.Decimal {
  let candidate = numerator
    .dividedBy(divisor)
    .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
  if (candidate.minus(HALF_CENT).mul(divisor).greaterThan(numerator)) {
    candidate = candidate.minus(ONE_CENT);
  } else if (
    candidate.plus(HALF_CENT).mul(divisor).lessThanOrEqualTo(numerator)
  ) {
    candidate = candidate.plus(ONE_CENT);
  }
  return candidate;
}

export function assertValidReceiptQuantity(value: Prisma.Decimal): void {
  if (
    !Prisma.Decimal.isDecimal(value) ||
    !value.isFinite() ||
    value.lessThanOrEqualTo(0) ||
    value.decimalPlaces() > 3
  ) {
    throw new BadRequestException(
      'quantity debe ser un decimal positivo con máximo 3 decimales',
    );
  }
  if (value.greaterThan(MAX_QUANTITY)) {
    throw new BadRequestException('quantity excede el máximo permitido');
  }
}

export interface PurchaseInvoiceLineFinancials {
  taxableBaseAmount: Prisma.Decimal;
  taxAmount: Prisma.Decimal;
  creditableTaxAmount: Prisma.Decimal;
}

/**
 * Monto ORIGINALMENTE debitado en la cuenta destino para UNA línea de
 * factura, derivado de columnas ya persistidas e inmutables — nunca una
 * columna nueva: la misma fórmula exacta que agrega
 * buildPurchaseRecognitionLines() (A5.2a) al construir el asiento de
 * reconocimiento, aplicada aquí a UNA sola línea en vez de al total
 * agregado por PurchasePurpose.
 */
export function computeLineDestinationAmount(
  line: PurchaseInvoiceLineFinancials,
): Prisma.Decimal {
  const nonCreditable = line.taxAmount.minus(line.creditableTaxAmount);
  return line.taxableBaseAmount.plus(nonCreditable);
}

/**
 * Monto proporcional a reclasificar por ESTA recepción (Fase A5.2b):
 * destinationAmount × (receivedQuantity / invoicedQuantity), HALF_UP a 2
 * decimales. Documentado límite de diseño: sumar el monto de varias
 * recepciones PARCIALES de la misma línea puede diferir del
 * destinationAmount total en, como máximo, un céntimo por línea (nunca
 * compuesto, nunca creciente) — una convención de redondeo por recepción,
 * no "remainder-on-completion"; pendiente de validación de un contador si
 * esta capacidad llega a activarse con mapeos reales (ver CLAUDE.md §11).
 */
export function computeProportionalReclassificationAmount(
  destinationAmount: Prisma.Decimal,
  receivedQuantity: Prisma.Decimal,
  invoicedQuantity: Prisma.Decimal,
): Prisma.Decimal {
  if (invoicedQuantity.lessThanOrEqualTo(0)) {
    throw new BadRequestException(
      'invoicedQuantity debe ser mayor que cero para prorratear',
    );
  }
  if (destinationAmount.lessThanOrEqualTo(0)) {
    return ZERO;
  }
  const numerator = destinationAmount.mul(receivedQuantity);
  return roundHalfUpQuotient(numerator, invoicedQuantity);
}
