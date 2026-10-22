import { Prisma } from '@prisma/client';

/** Fila bloqueada (`FOR UPDATE`) de purchase_invoice_lines, para la asignación de embarques (Fase B1). */
export interface LockedPurchaseInvoiceLineRow {
  id: string;
  quantity: Prisma.Decimal;
  productId: string | null;
  invoiceStatus: string;
}
