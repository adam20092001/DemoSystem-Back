import { Prisma, RoleName } from '@prisma/client';
import {
  PURCHASE_RECEIPT_LINE_SAFE_SELECT,
  PurchaseReceiptSafeRow,
  toSafePurchaseReceipt,
} from './purchase-receipt.mapper';

const LOCATION = {
  id: '10000000-0000-4000-8000-00000000000a',
  code: 'ESTANTE-A',
  name: 'Estante A',
  warehouse: { id: '20000000-0000-4000-8000-000000000001', code: 'MAIN' },
};

function row(location: typeof LOCATION | null): PurchaseReceiptSafeRow {
  return {
    id: 'r1',
    purchaseInvoiceId: 'i1',
    receivedDate: new Date('2026-03-20T00:00:00.000Z'),
    status: 'ACTIVE',
    idempotencyKey: null,
    notes: null,
    createdByUserId: 'u1',
    cancelledAt: null,
    cancelledByUserId: null,
    cancellationReason: null,
    reclassificationEntryId: 'e1',
    createdAt: new Date(),
    updatedAt: new Date(),
    lines: [
      {
        id: 'l1',
        purchaseInvoiceLineId: 'il1',
        quantity: new Prisma.Decimal('4'),
        reclassifiedAmount: new Prisma.Decimal('10'),
        location,
      },
    ],
  };
}

describe('toSafePurchaseReceipt (R2-B2: location)', () => {
  it('expone la ubicación de la línea (id, code, name, warehouse{id,code})', () => {
    const result = toSafePurchaseReceipt(row(LOCATION), RoleName.ADMIN);
    expect(result.lines[0].location).toEqual(LOCATION);
  });

  it('una línea histórica sin ubicación devuelve location null', () => {
    const result = toSafePurchaseReceipt(row(null), RoleName.ADMIN);
    expect(result.lines[0].location).toBeNull();
  });

  it('WAREHOUSE ve la ubicación pero ninguna clave financiera', () => {
    const result = toSafePurchaseReceipt(row(LOCATION), RoleName.WAREHOUSE);
    expect(result.lines[0].location).toEqual(LOCATION);
    expect('reclassifiedAmount' in result.lines[0]).toBe(false);
    expect('reclassificationEntryId' in result).toBe(false);
  });

  it('el select de ubicación no incluye estado ni importes', () => {
    expect(PURCHASE_RECEIPT_LINE_SAFE_SELECT.location).toEqual({
      select: {
        id: true,
        code: true,
        name: true,
        warehouse: { select: { id: true, code: true } },
      },
    });
  });
});
