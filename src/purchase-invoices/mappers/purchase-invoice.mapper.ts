import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import {
  SafePurchaseInvoice,
  SafePurchaseInvoiceLine,
} from '../types/safe-purchase-invoice';

export const PURCHASE_INVOICE_LINE_SAFE_SELECT = {
  id: true,
  productId: true,
  descriptionSnapshot: true,
  unitCodeSnapshot: true,
  unitNameSnapshot: true,
  acquisitionKind: true,
  purchasePurpose: true,
  quantity: true,
  unitCost: true,
  taxCategory: true,
  taxBasis: true,
  taxRateSnapshot: true,
  taxableBaseAmount: true,
  taxAmount: true,
  creditableTaxAmount: true,
  lineTotal: true,
  isReceiptEligible: true,
} satisfies Prisma.PurchaseInvoiceLineSelect;

export const PURCHASE_INVOICE_SAFE_SELECT = {
  id: true,
  supplierId: true,
  documentType: true,
  documentSeries: true,
  documentNumber: true,
  issueDate: true,
  registrationDate: true,
  accountingDate: true,
  dueDate: true,
  paymentTermsDays: true,
  currencyCode: true,
  subtotal: true,
  taxAmount: true,
  totalAmount: true,
  status: true,
  postedEntryId: true,
  createdByUserId: true,
  confirmedAt: true,
  cancelledAt: true,
  cancelledByUserId: true,
  cancellationReason: true,
  createdAt: true,
  updatedAt: true,
  lines: {
    select: PURCHASE_INVOICE_LINE_SAFE_SELECT,
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
  },
} satisfies Prisma.PurchaseInvoiceSelect;

export type PurchaseInvoiceLineSafeRow = Prisma.PurchaseInvoiceLineGetPayload<{
  select: typeof PURCHASE_INVOICE_LINE_SAFE_SELECT;
}>;

export type PurchaseInvoiceSafeRow = Prisma.PurchaseInvoiceGetPayload<{
  select: typeof PURCHASE_INVOICE_SAFE_SELECT;
}>;

function toSafePurchaseInvoiceLine(
  row: PurchaseInvoiceLineSafeRow,
): SafePurchaseInvoiceLine {
  return {
    id: row.id,
    productId: row.productId,
    descriptionSnapshot: row.descriptionSnapshot,
    unitCodeSnapshot: row.unitCodeSnapshot,
    unitNameSnapshot: row.unitNameSnapshot,
    acquisitionKind: row.acquisitionKind,
    purchasePurpose: row.purchasePurpose,
    quantity: row.quantity.toFixed(3),
    unitCost: row.unitCost.toFixed(2),
    taxCategory: row.taxCategory,
    taxBasis: row.taxBasis,
    taxRateSnapshot: row.taxRateSnapshot?.toFixed(2) ?? null,
    taxableBaseAmount: row.taxableBaseAmount.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    creditableTaxAmount: row.creditableTaxAmount.toFixed(2),
    lineTotal: row.lineTotal.toFixed(2),
    isReceiptEligible: row.isReceiptEligible,
  };
}

export function toSafePurchaseInvoice(
  row: PurchaseInvoiceSafeRow,
): SafePurchaseInvoice {
  return {
    id: row.id,
    supplierId: row.supplierId,
    documentType: row.documentType,
    documentSeries: row.documentSeries,
    documentNumber: row.documentNumber,
    issueDate: fromPrismaDate(row.issueDate),
    registrationDate: fromPrismaDate(row.registrationDate),
    accountingDate: fromPrismaDate(row.accountingDate),
    dueDate: row.dueDate !== null ? fromPrismaDate(row.dueDate) : null,
    paymentTermsDays: row.paymentTermsDays,
    currencyCode: row.currencyCode,
    subtotal: row.subtotal.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    totalAmount: row.totalAmount.toFixed(2),
    status: row.status,
    postedEntryId: row.postedEntryId,
    createdByUserId: row.createdByUserId,
    confirmedAt: row.confirmedAt,
    cancelledAt: row.cancelledAt,
    cancelledByUserId: row.cancelledByUserId,
    cancellationReason: row.cancellationReason,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    lines: row.lines.map(toSafePurchaseInvoiceLine),
  };
}
