import {
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
} from '@prisma/client';
import {
  INVENTORY_MOVEMENT_SAFE_SELECT,
  InventoryMovementSafeRow,
  STOCK_TRANSFER_REFERENCE_TYPE,
  toSafeInventoryMovement,
} from './inventory-movement.mapper';

function row(
  overrides: Partial<InventoryMovementSafeRow> = {},
): InventoryMovementSafeRow {
  return {
    id: 'm1',
    product: { id: 'p1', sku: 'SKU-1', name: 'Producto uno' },
    movementType: InventoryMovementType.EXIT,
    origin: InventoryMovementOrigin.TRANSFER,
    quantity: new Prisma.Decimal('2'),
    previousStock: new Prisma.Decimal('10'),
    newStock: new Prisma.Decimal('8'),
    reason: 'Transferencia',
    notes: null,
    createdBy: { id: 'u1', username: 'jdoe', firstName: 'J', lastName: 'D' },
    location: null,
    referenceType: null,
    referenceId: null,
    createdAt: new Date('2026-11-23T00:00:00.000Z'),
    ...overrides,
  };
}

describe('toSafeInventoryMovement — transferId (R2-C)', () => {
  it('un movimiento de una transferencia expone su id como transferId', () => {
    const result = toSafeInventoryMovement(
      row({
        referenceType: STOCK_TRANSFER_REFERENCE_TYPE,
        referenceId: 'transfer-1',
      }),
    );
    expect(result.transferId).toBe('transfer-1');
  });

  it('los demás movimientos (venta, recepción, manual) tienen transferId null', () => {
    expect(toSafeInventoryMovement(row()).transferId).toBeNull();
    expect(
      toSafeInventoryMovement(
        row({ referenceType: 'Sale', referenceId: 'sale-1' }),
      ).transferId,
    ).toBeNull();
  });

  it('nunca expone referenceType ni referenceId', () => {
    const result = toSafeInventoryMovement(
      row({
        referenceType: STOCK_TRANSFER_REFERENCE_TYPE,
        referenceId: 'transfer-1',
      }),
    ) as unknown as Record<string, unknown>;
    expect('referenceType' in result).toBe(false);
    expect('referenceId' in result).toBe(false);
  });

  it('el select solo agrega la referencia para derivar el id', () => {
    expect(INVENTORY_MOVEMENT_SAFE_SELECT.referenceType).toBe(true);
    expect(INVENTORY_MOVEMENT_SAFE_SELECT.referenceId).toBe(true);
  });
});
