import { ImportExpenseStatus, Prisma } from '@prisma/client';
import { computeCostAttributionSplit } from './import-receipt-cost-attribution';
import { ShipmentLineRow } from './import-reconciliation.helpers';
import {
  ExpenseCurrencyAggregate,
  PendingFinancialStatus,
} from './types/import-reports.types';

const ZERO = new Prisma.Decimal(0);

export interface ExpenseAllocationRow {
  importShipmentLineId: string;
  amount: Prisma.Decimal;
}

export interface ExpenseRow {
  id: string;
  importOperationId: string;
  category: string;
  documentReference: string | null;
  supplierId: string | null;
  currencyCode: string;
  amount: Prisma.Decimal;
  status: ImportExpenseStatus;
  allocations: ExpenseAllocationRow[];
}

/**
 * Atribución (B3) de UNA asignación concreta: reutiliza
 * `computeCostAttributionSplit` con un ÚNICO peso ("lo ya recibido para
 * esta línea de embarque") contra `plannedQuantity` de esa misma línea —
 * nunca una segunda fórmula de reparto (CLAUDE.md B4 §3: "Reuse the
 * corrected B3 attribution logic").
 */
export function attributeAllocation(
  allocation: ExpenseAllocationRow,
  plannedQuantityByLine: Map<string, Prisma.Decimal>,
  activeLinkedTotalByLine: Map<string, Prisma.Decimal>,
): Prisma.Decimal {
  const planned =
    plannedQuantityByLine.get(allocation.importShipmentLineId) ?? ZERO;
  const received =
    activeLinkedTotalByLine.get(allocation.importShipmentLineId) ?? ZERO;
  if (planned.isZero()) {
    return ZERO;
  }
  const split = computeCostAttributionSplit(
    [{ key: 'received', weight: received }],
    planned,
    allocation.amount,
  );
  return split.perKey.get('received') ?? ZERO;
}

/**
 * Agregación PURA por moneda (Fase B4, CLAUDE.md B4 §3): NUNCA suma
 * montos de monedas distintas en un solo total — cada entrada del
 * resultado es exclusiva de UNA `currencyCode`. Cada gasto se recorre
 * exactamente una vez (nunca a través de un JOIN que lo duplicara por
 * cada línea de embarque o recepción vinculada), así que no hay riesgo de
 * contar el mismo gasto varias veces. Un gasto CANCELLED nunca aporta a
 * `totalAmount`/`allocatedAmount` (B2 ya garantiza que un gasto CANCELLED
 * nunca tiene asignaciones).
 */
export function buildExpensesByCurrency(
  context: {
    expenses: ExpenseRow[];
    lines: ShipmentLineRow[];
    activeLinkedTotalByLine: Map<string, Prisma.Decimal>;
  },
  companyCurrencyCode: string,
): ExpenseCurrencyAggregate[] {
  const plannedQuantityByLine = new Map(
    context.lines.map((l) => [l.id, l.plannedQuantity]),
  );
  const byCurrency = new Map<
    string,
    {
      expenseCount: number;
      cancelledCount: number;
      totalAmount: Prisma.Decimal;
      allocatedAmount: Prisma.Decimal;
      attributedAmount: Prisma.Decimal;
    }
  >();
  for (const expense of context.expenses) {
    const bucket = byCurrency.get(expense.currencyCode) ?? {
      expenseCount: 0,
      cancelledCount: 0,
      totalAmount: ZERO,
      allocatedAmount: ZERO,
      attributedAmount: ZERO,
    };
    if (expense.status === ImportExpenseStatus.CANCELLED) {
      bucket.cancelledCount += 1;
    } else {
      bucket.expenseCount += 1;
      bucket.totalAmount = bucket.totalAmount.plus(expense.amount);
    }
    for (const allocation of expense.allocations) {
      bucket.allocatedAmount = bucket.allocatedAmount.plus(allocation.amount);
      bucket.attributedAmount = bucket.attributedAmount.plus(
        attributeAllocation(
          allocation,
          plannedQuantityByLine,
          context.activeLinkedTotalByLine,
        ),
      );
    }
    byCurrency.set(expense.currencyCode, bucket);
  }

  return [...byCurrency.entries()].map(([currencyCode, b]) => {
    const unallocated = b.totalAmount.minus(b.allocatedAmount);
    const unattributed = b.allocatedAmount.minus(b.attributedAmount);
    const financialStatus: PendingFinancialStatus =
      currencyCode !== companyCurrencyCode
        ? 'PENDING_FX'
        : 'PENDING_ACCOUNTING_POLICY';
    return {
      currencyCode,
      expenseCount: b.expenseCount,
      cancelledCount: b.cancelledCount,
      totalAmount: b.totalAmount.toFixed(2),
      allocatedAmount: b.allocatedAmount.toFixed(2),
      unallocatedAmount: (unallocated.lessThan(0) ? ZERO : unallocated).toFixed(
        2,
      ),
      attributedAmount: b.attributedAmount.toFixed(2),
      unattributedAmount: (unattributed.lessThan(0)
        ? ZERO
        : unattributed
      ).toFixed(2),
      financialStatus,
    };
  });
}
