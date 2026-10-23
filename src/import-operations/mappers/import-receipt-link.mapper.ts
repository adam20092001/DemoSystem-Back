import { Prisma } from '@prisma/client';
import { SafeImportReceiptLink } from '../types/safe-import-receipt-link';

const ACTOR_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

export const IMPORT_RECEIPT_LINK_SAFE_SELECT = {
  id: true,
  importShipmentLineId: true,
  purchaseReceiptLineId: true,
  linkedQuantity: true,
  status: true,
  createdBy: { select: ACTOR_SUMMARY_SELECT },
  createdAt: true,
  cancelledAt: true,
  cancelledBy: { select: ACTOR_SUMMARY_SELECT },
  cancellationReason: true,
} satisfies Prisma.ImportReceiptLinkSelect;

export type ImportReceiptLinkSafeRow = Prisma.ImportReceiptLinkGetPayload<{
  select: typeof IMPORT_RECEIPT_LINK_SAFE_SELECT;
}>;

export function toSafeImportReceiptLink(
  row: ImportReceiptLinkSafeRow,
): SafeImportReceiptLink {
  return {
    id: row.id,
    importShipmentLineId: row.importShipmentLineId,
    purchaseReceiptLineId: row.purchaseReceiptLineId,
    linkedQuantity: row.linkedQuantity.toFixed(3),
    status: row.status,
    createdBy: row.createdBy,
    createdAt: row.createdAt,
    cancelledAt: row.cancelledAt,
    cancelledBy: row.cancelledBy,
    cancellationReason: row.cancellationReason,
  };
}
