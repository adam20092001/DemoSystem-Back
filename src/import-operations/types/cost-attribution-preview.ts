/**
 * Por qué un monto NO puede aplicarse financieramente todavía (Fase B3,
 * CLAUDE.md B3 §3/§5) — nunca "aprobado", siempre uno de estos dos
 * motivos mientras no exista una política contable real ni una tasa de
 * cambio aprobada.
 */
export type PendingFinancialReason = 'PENDING_FX' | 'PENDING_ACCOUNTING_POLICY';

export interface CostAttributionPreviewLine {
  purchaseReceiptLineId: string;
  importReceiptLinkId: string;
  receivedQuantity: string;
  attributedAmount: string;
}

/**
 * Previsualización PURA (nunca persistida) de cómo se repartiría el monto
 * YA asignado por B2 (ImportExpenseAllocation, concepto B) entre las
 * recepciones físicas reales vinculadas (concepto de atribución, nunca
 * concepto C: "approved amount eligible for inventory capitalization").
 */
export interface CostAttributionPreview {
  importExpenseAllocationId: string;
  importShipmentLineId: string;
  currencyCode: string;
  allocatedAmount: string;
  lines: CostAttributionPreviewLine[];
  /**
   * Monto YA asignado (concepto B) que corresponde a la cantidad embarcada
   * todavía SIN vínculo de recepción ACTIVO — nunca atribuido a ninguna
   * línea. `allocatedAmount` siempre es exactamente `unattributedAmount`
   * más la suma de `lines[].attributedAmount` (residual exacto, nunca el
   * gasto completo cae sobre las primeras unidades recibidas).
   */
  unattributedAmount: string;
  financialStatus: PendingFinancialReason;
  financialStatusReason: string;
}
