import { Prisma, RoleName } from '@prisma/client';
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
  location: {
    select: {
      id: true,
      code: true,
      name: true,
      warehouse: { select: { id: true, code: true } },
    },
  },
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

/**
 * R1: roles que ven los campos financieros de una recepción
 * (`reclassifiedAmount` por línea y `reclassificationEntryId` del
 * encabezado). Lista BLANCA: cualquier rol fuera de ella (WAREHOUSE y
 * cualquier rol futuro) recibe la recepción SIN esas claves — fail-closed,
 * nunca "todos salvo WAREHOUSE".
 */
const RECEIPT_FINANCIAL_VIEW_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.ACCOUNTANT,
  RoleName.PURCHASING,
]);

export function canSeeReceiptFinancials(role: RoleName): boolean {
  return RECEIPT_FINANCIAL_VIEW_ROLES.has(role);
}

function toSafePurchaseReceiptLine(
  row: PurchaseReceiptLineSafeRow,
  includeFinancials: boolean,
): SafePurchaseReceiptLine {
  const line: SafePurchaseReceiptLine = {
    id: row.id,
    purchaseInvoiceLineId: row.purchaseInvoiceLineId,
    quantity: row.quantity.toFixed(3),
    location: row.location,
  };
  if (includeFinancials) {
    line.reclassifiedAmount = row.reclassifiedAmount?.toFixed(2) ?? null;
  }
  return line;
}

/**
 * Convierte la fila a su forma pública SEGÚN EL ROL del solicitante. El
 * filtrado ocurre aquí (backend), no en el cliente: para WAREHOUSE las
 * claves financieras no existen en el objeto devuelto.
 */
export function toSafePurchaseReceipt(
  row: PurchaseReceiptSafeRow,
  requesterRole: RoleName,
): SafePurchaseReceipt {
  const includeFinancials = canSeeReceiptFinancials(requesterRole);
  const receipt: SafePurchaseReceipt = {
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
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lines: row.lines.map((line) =>
      toSafePurchaseReceiptLine(line, includeFinancials),
    ),
  };
  if (includeFinancials) {
    receipt.reclassificationEntryId = row.reclassificationEntryId;
  }
  return receipt;
}
