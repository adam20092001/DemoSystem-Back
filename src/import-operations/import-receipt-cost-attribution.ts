import { Prisma } from '@prisma/client';
import { computeProportionalAllocation } from './import-expense-allocation-calculator';

const ZERO = new Prisma.Decimal(0);

export interface ReceivedWeight {
  key: string;
  weight: Prisma.Decimal;
}

export interface CostAttributionSplit {
  /** Monto atribuido a CADA `key` de `receivedWeights`, en el mismo orden recibido. */
  perKey: Map<string, Prisma.Decimal>;
  /**
   * Porción de `allocationAmount` correspondiente a la cantidad embarcada
   * todavía SIN vínculo de recepción ACTIVO — nunca atribuida a ninguna
   * `key`.
   */
  unattributedAmount: Prisma.Decimal;
}

/**
 * Núcleo de cálculo de atribución de costo de importación (Fase B3,
 * CLAUDE.md B3 §4), extraído para que B4 (reportes) NUNCA reimplemente ni
 * diverja del mismo cálculo que `ImportReceiptLinksService.
 * previewCostAttribution()`. El monto asignado (concepto B, ya calculado
 * por B2) es proporcional a toda la cantidad EMBARCADA (`plannedQuantity`),
 * nunca solo a lo ya vinculado: repartir únicamente entre los pesos
 * recibidos sobreatribuía el 100% del gasto a una recepción parcial (el
 * defecto corregido en B3). La porción correspondiente a lo todavía SIN
 * vincular se aísla con un objetivo virtual (nunca expuesto en `perKey`)
 * que, al ir último, absorbe el residual exacto de redondeo — cuando la
 * cantidad recibida ya iguala lo embarcado, su peso es 0 y el ÚLTIMO peso
 * real vuelve a absorber el residual exacto (idéntico al reparto original
 * de B2, `computeProportionalAllocation`, nunca una segunda
 * implementación).
 *
 * PURA: no persiste, no audita, no valida permisos — eso es
 * responsabilidad exclusiva de cada llamador.
 */
export function computeCostAttributionSplit(
  receivedWeights: ReceivedWeight[],
  plannedQuantity: Prisma.Decimal,
  allocationAmount: Prisma.Decimal,
): CostAttributionSplit {
  const receivedTotal = receivedWeights.reduce(
    (sum, w) => sum.plus(w.weight),
    ZERO,
  );
  const unreceivedQuantity = plannedQuantity.minus(receivedTotal);

  const targets = receivedWeights.map((w) => ({
    importShipmentLineId: w.key,
    weight: w.weight,
  }));
  const hasUnattributed = unreceivedQuantity.greaterThan(0);
  if (hasUnattributed) {
    targets.push({
      importShipmentLineId: '__unattributed__',
      weight: unreceivedQuantity,
    });
  }

  if (targets.length === 0) {
    return { perKey: new Map(), unattributedAmount: ZERO };
  }

  const results = computeProportionalAllocation(targets, allocationAmount);
  const perKey = new Map<string, Prisma.Decimal>();
  let unattributedAmount = ZERO;
  results.forEach((result, index) => {
    if (hasUnattributed && index === results.length - 1) {
      unattributedAmount = result.amount;
    } else {
      perKey.set(result.importShipmentLineId, result.amount);
    }
  });

  return { perKey, unattributedAmount };
}
