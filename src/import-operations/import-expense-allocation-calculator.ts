import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);

export interface AllocationWeightTarget {
  importShipmentLineId: string;
  weight: Prisma.Decimal;
}

export interface AllocationResultLine {
  importShipmentLineId: string;
  amount: Prisma.Decimal;
}

/**
 * Reparto proporcional determinista de `totalAmount` entre `targets`
 * (Fase B2) según su `weight` relativo (cantidad planificada, peso o
 * volumen, según el método QUANTITY/WEIGHT/VOLUME elegido por el
 * llamador) — HALF_UP a 2 decimales, con el RESIDUAL exacto absorbido por
 * el ÚLTIMO target del arreglo (mismo criterio de asignación determinista
 * ya usado en A5.2b/A6.1 para evitar drift de redondeo): la suma de los
 * montos resultantes es SIEMPRE exactamente `totalAmount`, nunca más
 * (CLAUDE.md B2 §3: "Never allocate more than the specified amount").
 *
 * PURA: no valida nada de negocio (el llamador ya debe haber verificado
 * `totalAmount > 0`, cada `weight >= 0`, y que la suma de los `weight` sea
 * > 0 — ver `assertValidDistributionBase`). El ORDEN de `targets` decide
 * qué línea absorbe el residual: el llamador debe pasarlo siempre en un
 * orden determinista (p. ej. ascendente por id) para que dos cálculos con
 * los mismos datos produzcan siempre el mismo resultado.
 */
export function computeProportionalAllocation(
  targets: AllocationWeightTarget[],
  totalAmount: Prisma.Decimal,
): AllocationResultLine[] {
  const totalWeight = targets.reduce((sum, t) => sum.plus(t.weight), ZERO);
  const results: AllocationResultLine[] = [];
  let allocatedSoFar = ZERO;

  targets.forEach((target, index) => {
    const isLast = index === targets.length - 1;
    const amount = isLast
      ? totalAmount.minus(allocatedSoFar)
      : totalAmount
          .mul(target.weight)
          .dividedBy(totalWeight)
          .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    allocatedSoFar = allocatedSoFar.plus(amount);
    results.push({
      importShipmentLineId: target.importShipmentLineId,
      amount,
    });
  });

  return results;
}

/** La base de distribución (suma de weight) debe ser estrictamente positiva — nunca cero ni negativa (CLAUDE.md B2 §3). */
export function assertValidDistributionBase(totalWeight: Prisma.Decimal): void {
  if (totalWeight.lessThanOrEqualTo(0)) {
    throw new BadRequestException(
      'La base de distribución (cantidad, peso o volumen) debe ser mayor que cero',
    );
  }
}
