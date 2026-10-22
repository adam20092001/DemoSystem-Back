import { Prisma } from '@prisma/client';
import { PurchaseInvoiceLineFinancials } from '../../purchase-receipts/purchase-receipt-calculator';

/**
 * Comando interno de InventoryValuationEngine.recordOriginal() — no es un
 * DTO HTTP. `quantity` es la cantidad de ESTA recepción; `priorReceivedQuantity`
 * es la suma ya recibida (recepciones ACTIVE previas) de la MISMA
 * PurchaseInvoiceLine, para la asignación acumulada de costo (mismo
 * criterio que A5.2b).
 */
export interface RecordOriginalValuationCommand {
  productId: string;
  inventoryMovementId: string;
  purchaseReceiptLineId: string;
  purchaseInvoiceLineId: string;
  quantity: Prisma.Decimal;
  invoicedQuantity: Prisma.Decimal;
  priorReceivedQuantity: Prisma.Decimal;
  lineFinancials: PurchaseInvoiceLineFinancials;
  actorUserId: string;
  ipAddress: string | null;
}
