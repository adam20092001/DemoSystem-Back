import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  computeLineDestinationAmount,
  computeProportionalReclassificationAmount,
  PurchaseInvoiceLineFinancials,
} from '../purchase-receipts/purchase-receipt-calculator';

const ZERO = new Prisma.Decimal(0);
const UNIT_COST_DECIMALS = 6;

export interface ValuationCostComponents {
  purchasePriceAmount: Prisma.Decimal;
  nonCreditableTaxAmount: Prisma.Decimal;
  additionalCostsAmount: Prisma.Decimal;
  totalCost: Prisma.Decimal;
  unitCost: Prisma.Decimal;
}

/**
 * Calcula el costo CAPITALIZABLE de ESTA recepción (Fase A6.1), reutilizando
 * exactamente la misma técnica de asignación ACUMULADA ya revisada y
 * corregida en A5.2b (`purchase-receipt-calculator.ts`) para evitar drift
 * de redondeo entre recepciones parciales: el monto elegible total de la
 * línea (`computeLineDestinationAmount` — precio de compra neto de
 * impuesto + impuesto NO acreditable, NUNCA el total bruto de la factura)
 * se reparte por cantidad acumulada, y esta recepción captura el RESIDUAL
 * frente a lo ya capitalizado por recepciones ACTIVE previas de la MISMA
 * línea — nunca una fórmula proporcional aislada por recepción. Cuando
 * esta recepción COMPLETA la línea, el objetivo se fija en el monto
 * elegible EXACTO (nunca recalculado), igual criterio que A5.2b.
 *
 * `additionalCostsAmount` siempre 0 en A6.1 (flete/seguros/aduanas: punto
 * de extensión explícito, nunca implementado — Importaciones sigue fuera
 * de alcance). El desglose precio/impuesto no acreditable de ESTE residual
 * se obtiene aplicando la MISMA proporción (taxableBase : nonCreditableTax)
 * de la línea completa — un reparto de dos términos, con el segundo
 * siempre como residual exacto del primero, así que la suma de ambos
 * nunca difiere del total capitalizado de esta recepción ni en un
 * céntimo.
 */
export function computeReceiptValuationCost(
  lineFinancials: PurchaseInvoiceLineFinancials,
  invoicedQuantity: Prisma.Decimal,
  priorReceivedQuantity: Prisma.Decimal,
  thisReceiptQuantity: Prisma.Decimal,
  alreadyCapitalizedAmount: Prisma.Decimal,
): ValuationCostComponents {
  const eligibleAmount = computeLineDestinationAmount(lineFinancials);
  const cumulativeReceivedQuantity =
    priorReceivedQuantity.plus(thisReceiptQuantity);
  const isCompleting =
    cumulativeReceivedQuantity.greaterThanOrEqualTo(invoicedQuantity);
  const targetCumulativeAmount = isCompleting
    ? eligibleAmount
    : computeProportionalReclassificationAmount(
        eligibleAmount,
        cumulativeReceivedQuantity,
        invoicedQuantity,
      );
  const residual = targetCumulativeAmount.minus(alreadyCapitalizedAmount);
  // Defensa en profundidad: con aritmética Decimal exacta y el ajuste
  // exacto en la recepción que completa (mismo invariante ya verificado
  // en A5.2b), `residual` nunca debería ser negativo.
  const totalCost = residual.greaterThan(0) ? residual : ZERO;

  let purchasePriceAmount: Prisma.Decimal;
  let nonCreditableTaxAmount: Prisma.Decimal;
  if (totalCost.equals(0) || eligibleAmount.lessThanOrEqualTo(0)) {
    purchasePriceAmount = ZERO;
    nonCreditableTaxAmount = ZERO;
  } else {
    const priceRatio =
      lineFinancials.taxableBaseAmount.dividedBy(eligibleAmount);
    purchasePriceAmount = totalCost
      .mul(priceRatio)
      .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    // Residual exacto, nunca un segundo redondeo independiente: garantiza
    // purchasePriceAmount + nonCreditableTaxAmount === totalCost siempre.
    nonCreditableTaxAmount = totalCost.minus(purchasePriceAmount);
  }

  const additionalCostsAmount = ZERO;
  const unitCost = thisReceiptQuantity.greaterThan(0)
    ? totalCost
        .dividedBy(thisReceiptQuantity)
        .toDecimalPlaces(UNIT_COST_DECIMALS, Prisma.Decimal.ROUND_HALF_UP)
    : ZERO;

  return {
    purchasePriceAmount,
    nonCreditableTaxAmount,
    additionalCostsAmount,
    totalCost,
    unitCost,
  };
}

/**
 * Promedio ponderado móvil (Fase A6.1) derivado SIEMPRE en tiempo de
 * lectura a partir del historial inmutable (suma de ORIGINAL − suma de
 * REVERSAL) — nunca un saldo acumulado persistido, nunca quantity×unitCost
 * re-derivado (evita pérdida/creación de valor por redondeo acumulado:
 * siempre se suma `totalCost` ya persistido). `valuedQuantity<=0` ->
 * weightedAverageUnitCost='0.000000' (nunca una división por cero).
 */
export function computeWeightedAverage(
  valuedQuantity: Prisma.Decimal,
  totalValue: Prisma.Decimal,
): Prisma.Decimal {
  if (valuedQuantity.lessThanOrEqualTo(0)) {
    return ZERO;
  }
  return totalValue
    .dividedBy(valuedQuantity)
    .toDecimalPlaces(UNIT_COST_DECIMALS, Prisma.Decimal.ROUND_HALF_UP);
}

export function assertValidValuationQuantity(value: Prisma.Decimal): void {
  if (!Prisma.Decimal.isDecimal(value) || !value.isFinite()) {
    throw new InternalServerErrorException(
      'La cantidad a valorizar debe ser un decimal válido',
    );
  }
  if (value.lessThanOrEqualTo(0)) {
    throw new InternalServerErrorException(
      'La cantidad a valorizar debe ser mayor que cero',
    );
  }
}
