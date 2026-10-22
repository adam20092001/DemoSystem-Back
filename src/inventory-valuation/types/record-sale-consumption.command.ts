import { Prisma } from '@prisma/client';

/**
 * Comando interno de InventoryValuationEngine.recordSaleConsumption()
 * (Fase A6.2) — no es un DTO HTTP. `quantity` es la cantidad física de ESTA
 * línea de venta (SaleItem.quantity), ya movida por StockMovementEngine en
 * la MISMA transacción. Nunca referencia una PurchaseReceiptLine: el origen
 * del consumo es exclusivamente el SaleItem.
 */
export interface RecordSaleConsumptionCommand {
  productId: string;
  inventoryMovementId: string;
  saleItemId: string;
  quantity: Prisma.Decimal;
  actorUserId: string;
  ipAddress: string | null;
}
