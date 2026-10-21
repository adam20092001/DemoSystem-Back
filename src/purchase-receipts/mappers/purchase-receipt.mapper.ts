import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import {
  SafePurchaseReceipt,
  SafePurchaseReceiptLine,
} from '../types/safe-purchase-receipt';

export const PURCHASE_RECEIPT_LINE_SAFE_SELECT = {
  id: true,
  purchaseInvoiceLineId: true,
  quantity: true,
  reclassifiedAmount: true,
} satisfies Prisma.PurchaseReceiptLineSelect;

export const PURCHASE_RECEIPT_SAFE_SELECT = {
  id: true,
  purchaseInvoiceId: true,
  receivedDate: true,
  status: true,
  idempotencyKey: true,
  notes: true,
  createdByUserId: true,
  cancelledAt: true,
  cancelledByUserId: true,
  cancellationReason: true,
  reclassificationEntryId: true,
  createdAt: true,
  updatedAt: true,
  lines: {
    select: PURCHASE_RECEIPT_LINE_SAFE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.PurchaseReceiptSelect;

export type PurchaseReceiptLineSafeRow = Prisma.PurchaseReceiptLineGetPayload<{
  select: typeof PURCHASE_RECEIPT_LINE_SAFE_SELECT;
}>;

export type PurchaseReceiptSafeRow = Prisma.PurchaseReceiptGetPayload<{
  select: typeof PURCHASE_RECEIPT_SAFE_SELECT;
}>;

function toSafePurchaseReceiptLine(
  row: PurchaseReceiptLineSafeRow,
): SafePurchaseReceiptLine {
  return {
    id: row.id,
    purchaseInvoiceLineId: row.purchaseInvoiceLineId,
    quantity: row.quantity.toFixed(3),
    reclassifiedAmount: row.reclassifiedAmount?.toFixed(2) ?? null,
  };
}

export function toSafePurchaseReceipt(
  row: PurchaseReceiptSafeRow,
): SafePurchaseReceipt {
  return {
    id: row.id,
    purchaseInvoiceId: row.purchaseInvoiceId,
    receivedDate: fromPrismaDate(row.receivedDate),
    status: row.status,
    idempotencyKey: row.idempotencyKey,
    notes: row.notes,
    createdByUserId: row.createdByUserId,
    cancelledAt: row.cancelledAt,
    cancelledByUserId: row.cancelledByUserId,
    cancellationReason: row.cancellationReason,
    reclassificationEntryId: row.reclassificationEntryId,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lines: row.lines.map(toSafePurchaseReceiptLine),
  };
}
