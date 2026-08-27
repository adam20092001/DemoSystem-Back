import { Prisma } from '@prisma/client';
import { fromPrismaDate } from '../../common/date/business-date';
import { effectiveStatus } from '../quote-calculator';
import {
  SafeQuote,
  SafeQuoteItem,
  SafeQuoteListItem,
  SafeQuoteStockInfo,
} from '../types/safe-quote';

const SELLER_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

/**
 * stockCurrent/isInventoryTracked son ENTRADA del mapper para componer
 * stockInfo (§23): nunca se exponen directamente en la respuesta.
 */
const ITEM_PRODUCT_STOCK_SELECT = {
  stockCurrent: true,
  isInventoryTracked: true,
} satisfies Prisma.ProductSelect;

const QUOTE_ITEM_SELECT = {
  id: true,
  productId: true,
  productSku: true,
  productName: true,
  unitCode: true,
  unitName: true,
  unitAbbreviation: true,
  quantity: true,
  unitPrice: true,
  lineTotal: true,
  product: { select: ITEM_PRODUCT_STOCK_SELECT },
} satisfies Prisma.QuoteItemSelect;

/** Forma de listado: sin ítems, con conteo (itemCount) vía _count. */
export const QUOTE_LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  customerId: true,
  customerName: true,
  customerDocumentNumber: true,
  sellerId: true,
  issueDate: true,
  expirationDate: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  total: true,
  currencyCode: true,
  taxEnabled: true,
  taxRate: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
} satisfies Prisma.QuoteSelect;

/** Forma de detalle: snapshot completo + vendedor seguro + ítems con stockInfo. */
export const QUOTE_DETAIL_SELECT = {
  id: true,
  number: true,
  status: true,
  customerId: true,
  customerType: true,
  customerDocumentType: true,
  customerDocumentNumber: true,
  customerName: true,
  customerAddress: true,
  sellerId: true,
  seller: { select: SELLER_SUMMARY_SELECT },
  issueDate: true,
  expirationDate: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  total: true,
  currencyCode: true,
  taxEnabled: true,
  taxRate: true,
  notes: true,
  items: { select: QUOTE_ITEM_SELECT },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.QuoteSelect;

export type QuoteListRow = Prisma.QuoteGetPayload<{
  select: typeof QUOTE_LIST_SELECT;
}>;
export type QuoteDetailRow = Prisma.QuoteGetPayload<{
  select: typeof QUOTE_DETAIL_SELECT;
}>;
export type QuoteItemRow = Prisma.QuoteItemGetPayload<{
  select: typeof QUOTE_ITEM_SELECT;
}>;

export function toSafeQuoteListItem(
  row: QuoteListRow,
  businessDate: string,
): SafeQuoteListItem {
  return {
    id: row.id,
    number: row.number,
    status: effectiveStatus(row.status, row.expirationDate, businessDate),
    customerId: row.customerId,
    customerName: row.customerName,
    customerDocumentNumber: row.customerDocumentNumber,
    sellerId: row.sellerId,
    issueDate: fromPrismaDate(row.issueDate),
    expirationDate: fromPrismaDate(row.expirationDate),
    subtotal: row.subtotal.toFixed(2),
    discountAmount: row.discountAmount.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    total: row.total.toFixed(2),
    currencyCode: row.currencyCode,
    taxEnabled: row.taxEnabled,
    taxRate: row.taxRate.toFixed(2),
    itemCount: row._count.items,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toStockInfo(row: QuoteItemRow): SafeQuoteStockInfo | null {
  if (!row.product.isInventoryTracked) {
    return null;
  }
  return {
    currentStock: row.product.stockCurrent.toFixed(3),
    requestedQuantity: row.quantity.toFixed(3),
    sufficient: row.product.stockCurrent.greaterThanOrEqualTo(row.quantity),
  };
}

function toSafeQuoteItem(row: QuoteItemRow): SafeQuoteItem {
  return {
    id: row.id,
    productId: row.productId,
    productSku: row.productSku,
    productName: row.productName,
    unitCode: row.unitCode,
    unitName: row.unitName,
    unitAbbreviation: row.unitAbbreviation,
    quantity: row.quantity.toFixed(3),
    unitPrice: row.unitPrice.toFixed(2),
    lineTotal: row.lineTotal.toFixed(2),
    stockInfo: toStockInfo(row),
  };
}

export function toSafeQuote(
  row: QuoteDetailRow,
  businessDate: string,
): SafeQuote {
  return {
    id: row.id,
    number: row.number,
    status: effectiveStatus(row.status, row.expirationDate, businessDate),
    customerId: row.customerId,
    customerType: row.customerType,
    customerDocumentType: row.customerDocumentType,
    customerDocumentNumber: row.customerDocumentNumber,
    customerName: row.customerName,
    customerAddress: row.customerAddress,
    seller: row.seller,
    issueDate: fromPrismaDate(row.issueDate),
    expirationDate: fromPrismaDate(row.expirationDate),
    subtotal: row.subtotal.toFixed(2),
    discountAmount: row.discountAmount.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    total: row.total.toFixed(2),
    currencyCode: row.currencyCode,
    taxEnabled: row.taxEnabled,
    taxRate: row.taxRate.toFixed(2),
    notes: row.notes,
    items: row.items.map(toSafeQuoteItem),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
