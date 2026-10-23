import {
  ImportExpenseCategory,
  ImportExpenseStatus,
  Prisma,
} from '@prisma/client';
import {
  attributeAllocation,
  buildExpensesByCurrency,
  ExpenseRow,
} from './import-expense-aggregation.helpers';
import { ShipmentLineRow } from './import-reconciliation.helpers';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function makeLine(id: string, plannedQuantity: string): ShipmentLineRow {
  return {
    id,
    importShipmentId: 'shipment-1',
    shipmentStatus: 'ARRIVED',
    importOperationId: 'operation-1',
    productId: null,
    descriptionSnapshot: 'Carga',
    unitCode: 'kg',
    purchaseInvoiceLineId: null,
    plannedQuantity: d(plannedQuantity),
  };
}

function makeExpense(overrides: Partial<ExpenseRow> = {}): ExpenseRow {
  return {
    id: 'expense-1',
    importOperationId: 'operation-1',
    category: ImportExpenseCategory.FREIGHT,
    documentReference: null,
    supplierId: null,
    currencyCode: 'PEN',
    amount: d('100.00'),
    status: ImportExpenseStatus.DRAFT,
    allocations: [],
    ...overrides,
  };
}

describe('attributeAllocation', () => {
  it('reutiliza el cálculo corregido de B3: 30 de 100 recibidas atribuye solo 30.00', () => {
    const result = attributeAllocation(
      { importShipmentLineId: 'line-1', amount: d('100.00') },
      new Map([['line-1', d('100.000')]]),
      new Map([['line-1', d('30.000')]]),
    );
    expect(result.toFixed(2)).toBe('30.00');
  });

  it('línea sin plannedQuantity conocida: 0 (nunca divide por cero)', () => {
    const result = attributeAllocation(
      { importShipmentLineId: 'line-x', amount: d('100.00') },
      new Map(),
      new Map(),
    );
    expect(result.toFixed(2)).toBe('0.00');
  });
});

describe('buildExpensesByCurrency', () => {
  it('nunca mezcla montos de monedas distintas en un mismo total', () => {
    const lines = [makeLine('line-1', '10.000')];
    const expenses: ExpenseRow[] = [
      makeExpense({ id: 'e-usd', currencyCode: 'USD', amount: d('100.00') }),
      makeExpense({ id: 'e-pen', currencyCode: 'PEN', amount: d('50.00') }),
    ];
    const result = buildExpensesByCurrency(
      { expenses, lines, activeLinkedTotalByLine: new Map() },
      'PEN',
    );
    expect(result).toHaveLength(2);
    const usd = result.find((r) => r.currencyCode === 'USD');
    const pen = result.find((r) => r.currencyCode === 'PEN');
    expect(usd?.totalAmount).toBe('100.00');
    expect(pen?.totalAmount).toBe('50.00');
    expect(usd?.financialStatus).toBe('PENDING_FX');
    expect(pen?.financialStatus).toBe('PENDING_ACCOUNTING_POLICY');
  });

  it('un gasto CANCELLED nunca aporta a totalAmount, solo a cancelledCount', () => {
    const result = buildExpensesByCurrency(
      {
        expenses: [
          makeExpense({
            status: ImportExpenseStatus.CANCELLED,
            amount: d('999.00'),
          }),
        ],
        lines: [],
        activeLinkedTotalByLine: new Map(),
      },
      'PEN',
    );
    expect(result[0].expenseCount).toBe(0);
    expect(result[0].cancelledCount).toBe(1);
    expect(result[0].totalAmount).toBe('0.00');
  });

  it('cada gasto se cuenta exactamente una vez, sin duplicar por sus múltiples asignaciones', () => {
    const lines = [makeLine('line-1', '10.000'), makeLine('line-2', '20.000')];
    const result = buildExpensesByCurrency(
      {
        expenses: [
          makeExpense({
            allocations: [
              { importShipmentLineId: 'line-1', amount: d('40.00') },
              { importShipmentLineId: 'line-2', amount: d('60.00') },
            ],
          }),
        ],
        lines,
        activeLinkedTotalByLine: new Map(),
      },
      'PEN',
    );
    expect(result).toHaveLength(1);
    expect(result[0].expenseCount).toBe(1);
    expect(result[0].allocatedAmount).toBe('100.00');
  });

  it('atribuido nunca excede lo asignado; sin atribuir absorbe la cantidad todavía no recibida', () => {
    const lines = [makeLine('line-1', '100.000')];
    const result = buildExpensesByCurrency(
      {
        expenses: [
          makeExpense({
            amount: d('100.00'),
            allocations: [
              { importShipmentLineId: 'line-1', amount: d('100.00') },
            ],
          }),
        ],
        lines,
        activeLinkedTotalByLine: new Map([['line-1', d('30.000')]]),
      },
      'PEN',
    );
    expect(result[0].allocatedAmount).toBe('100.00');
    expect(result[0].attributedAmount).toBe('30.00');
    expect(result[0].unattributedAmount).toBe('70.00');
  });
});
