import { AccountType } from '@prisma/client';

/**
 * Naturaleza débito/crédito NORMAL de cada AccountType (Fase A1 — PCGE
 * §4: "Normal debit/credit nature where functionally justified"). Dato
 * PURAMENTE DERIVADO, nunca una columna nueva en `Account` — mismo
 * criterio exacto que `stockStatus` en NR-04
 * (src/inventory/stock-status.ts): se calcula a partir de un campo ya
 * persistido (`type`), nunca se guarda ni puede quedar desincronizado.
 * ASSET/EXPENSE/COST aumentan con el débito (igual que las líneas reales
 * ya posteadas por AccountingEngine: AR se debita al reconocer una
 * venta); LIABILITY/EQUITY/REVENUE aumentan con el crédito (igual que
 * SALES_REVENUE/VAT_PAYABLE, siempre acreditadas). CONTRA_REVENUE es la
 * única excepción deliberada: reduce el ingreso, así que su naturaleza
 * normal es DEBIT — coincide exactamente con cómo DISCOUNTS ya se debita
 * en accounting-calculator.ts (buildSaleRecognitionLines).
 */
export type NormalBalance = 'DEBIT' | 'CREDIT';

const DEBIT_NATURED_TYPES: ReadonlySet<AccountType> = new Set([
  AccountType.ASSET,
  AccountType.EXPENSE,
  AccountType.COST,
  AccountType.CONTRA_REVENUE,
]);

export function accountNormalBalance(type: AccountType): NormalBalance {
  return DEBIT_NATURED_TYPES.has(type) ? 'DEBIT' : 'CREDIT';
}

/**
 * Nivel jerárquico de una cuenta hija (Fase A1 — PCGE §4: "Hierarchical
 * levels"). SIEMPRE derivado en el servidor a partir del nivel real del
 * padre ya persistido, nunca aceptado del cliente — mismo criterio que
 * Sale/Quote number (correlativos) o Payment.paidAt: ningún campo que
 * describe un invariante interno se confía a un valor enviado por el
 * cliente. Una cuenta raíz (sin padre) siempre es nivel 1.
 */
export const ROOT_ACCOUNT_LEVEL = 1;

export function computeChildLevel(parentLevel: number): number {
  return parentLevel + 1;
}
