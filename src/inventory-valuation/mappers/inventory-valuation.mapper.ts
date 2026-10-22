import { Prisma } from '@prisma/client';
import { SafeInventoryValuation } from '../types/safe-inventory-valuation';

export const INVENTORY_VALUATION_SAFE_SELECT = {
  id: true,
  productId: true,
  inventoryMovementId: true,
  purchaseReceiptLineId: true,
  eventType: true,
  reversesValuationId: true,
  method: true,
  quantity: true,
  purchasePriceAmount: true,
  nonCreditableTaxAmount: true,
  additionalCostsAmount: true,
  totalCost: true,
  unitCost: true,
  createdByUserId: true,
  createdAt: true,
} satisfies Prisma.InventoryValuationSelect;

export type InventoryValuationSafeRow = Prisma.InventoryValuationGetPayload<{
  select: typeof INVENTORY_VALUATION_SAFE_SELECT;
}>;

export function toSafeInventoryValuation(
  row: InventoryValuationSafeRow,
): SafeInventoryValuation {
  return {
    id: row.id,
    productId: row.productId,
    inventoryMovementId: row.inventoryMovementId,
    purchaseReceiptLineId: row.purchaseReceiptLineId,
    eventType: row.eventType,
    reversesValuationId: row.reversesValuationId,
    method: row.method,
    quantity: row.quantity.toFixed(3),
    purchasePriceAmount: row.purchasePriceAmount.toFixed(2),
    nonCreditableTaxAmount: row.nonCreditableTaxAmount.toFixed(2),
    additionalCostsAmount: row.additionalCostsAmount.toFixed(2),
    totalCost: row.totalCost.toFixed(2),
    unitCost: row.unitCost.toFixed(6),
    createdByUserId: row.createdByUserId,
    createdAt: row.createdAt,
  };
}
