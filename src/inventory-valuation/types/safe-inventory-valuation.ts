import {
  InventoryValuationEventType,
  InventoryValuationMethod,
} from '@prisma/client';

/** Forma segura de un evento de valorización (ORIGINAL o REVERSAL) — todos los Decimal como string de escala fija. */
export interface SafeInventoryValuation {
  id: string;
  productId: string;
  inventoryMovementId: string;
  purchaseReceiptLineId: string;
  eventType: InventoryValuationEventType;
  reversesValuationId: string | null;
  method: InventoryValuationMethod;
  quantity: string;
  purchasePriceAmount: string;
  nonCreditableTaxAmount: string;
  additionalCostsAmount: string;
  totalCost: string;
  unitCost: string;
  createdByUserId: string;
  createdAt: Date;
}
