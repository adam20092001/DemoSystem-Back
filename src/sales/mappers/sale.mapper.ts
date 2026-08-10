import { Prisma } from '@prisma/client';
import {
  SafeSale,
  SafeSaleInventoryMovement,
  SafeSaleItem,
  SafeSaleListItem,
} from '../types/safe-sale';

const SALE_SELLER_SUMMARY_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

const SALE_QUOTE_REFERENCE_SELECT = {
  id: true,
  number: true,
} satisfies Prisma.QuoteSelect;

const SALE_ITEM_SELECT = {
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
} satisfies Prisma.SaleItemSelect;

/** Forma de listado: sin ítems, con conteo (itemCount) vía _count. */
export const SALE_LIST_SELECT = {
  id: true,
  number: true,
  status: true,
  paymentStatus: true,
  deliveryStatus: true,
  customerId: true,
  customerName: true,
  customerDocumentNumber: true,
  sellerId: true,
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  total: true,
  paidAmount: true,
  balanceDue: true,
  confirmedAt: true,
  createdAt: true,
  updatedAt: true,
  _count: { select: { items: true } },
} satisfies Prisma.SaleSelect;

/** Forma de detalle: snapshot completo + vendedor/anulador seguros + referencia de cotización + ítems. */
export const SALE_DETAIL_SELECT = {
  id: true,
  number: true,
  status: true,
  paymentStatus: true,
  deliveryStatus: true,
  customerId: true,
  customerIsGeneric: true,
  customerType: true,
  customerDocumentType: true,
  customerDocumentNumber: true,
  customerName: true,
  customerAddress: true,
  seller: { select: SALE_SELLER_SUMMARY_SELECT },
  quote: { select: SALE_QUOTE_REFERENCE_SELECT },
  subtotal: true,
  discountAmount: true,
  taxAmount: true,
  total: true,
  paidAmount: true,
  balanceDue: true,
  items: { select: SALE_ITEM_SELECT },
  confirmedAt: true,
  cancelledAt: true,
  cancellationReason: true,
  cancelledBy: { select: SALE_SELLER_SUMMARY_SELECT },
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.SaleSelect;

/**
 * `Sale` no puede `include` sus InventoryMovement mediante Prisma: la
 * referencia es polimórfica (referenceType/referenceId como texto libre,
 * sin FK — misma técnica que AuditLog), no una relación declarada en el
 * esquema. Este select se usa en una SEGUNDA consulta independiente,
 * filtrada por referenceType='Sale' + referenceId=sale.id.
 */
export const SALE_INVENTORY_MOVEMENT_SELECT = {
  id: true,
  productId: true,
  movementType: true,
  origin: true,
  quantity: true,
  previousStock: true,
  newStock: true,
  createdAt: true,
} satisfies Prisma.InventoryMovementSelect;

export type SaleListRow = Prisma.SaleGetPayload<{
  select: typeof SALE_LIST_SELECT;
}>;
export type SaleDetailRow = Prisma.SaleGetPayload<{
  select: typeof SALE_DETAIL_SELECT;
}>;
export type SaleItemRow = Prisma.SaleItemGetPayload<{
  select: typeof SALE_ITEM_SELECT;
}>;
export type SaleInventoryMovementRow = Prisma.InventoryMovementGetPayload<{
  select: typeof SALE_INVENTORY_MOVEMENT_SELECT;
}>;

export function toSafeSaleListItem(row: SaleListRow): SafeSaleListItem {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    paymentStatus: row.paymentStatus,
    deliveryStatus: row.deliveryStatus,
    customerId: row.customerId,
    customerName: row.customerName,
    customerDocumentNumber: row.customerDocumentNumber,
    sellerId: row.sellerId,
    subtotal: row.subtotal.toFixed(2),
    discountAmount: row.discountAmount.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    total: row.total.toFixed(2),
    paidAmount: row.paidAmount.toFixed(2),
    balanceDue: row.balanceDue.toFixed(2),
    itemCount: row._count.items,
    confirmedAt: row.confirmedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

function toSafeSaleItem(row: SaleItemRow): SafeSaleItem {
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
  };
}

export function toSafeSaleInventoryMovement(
  row: SaleInventoryMovementRow,
): SafeSaleInventoryMovement {
  return {
    id: row.id,
    productId: row.productId,
    movementType: row.movementType,
    origin: row.origin,
    quantity: row.quantity.toFixed(3),
    previousStock: row.previousStock.toFixed(3),
    newStock: row.newStock.toFixed(3),
    createdAt: row.createdAt,
  };
}

/**
 * Mapper puro: no consulta la base. Recibe la fila de detalle YA
 * seleccionada y los movimientos de inventario YA consultados por
 * separado (§53 del plan aprobado), y los combina en el contrato seguro.
 */
export function toSafeSale(
  row: SaleDetailRow,
  movements: SaleInventoryMovementRow[],
): SafeSale {
  return {
    id: row.id,
    number: row.number,
    status: row.status,
    paymentStatus: row.paymentStatus,
    deliveryStatus: row.deliveryStatus,

    customerId: row.customerId,
    customerIsGeneric: row.customerIsGeneric,
    customerType: row.customerType,
    customerDocumentType: row.customerDocumentType,
    customerDocumentNumber: row.customerDocumentNumber,
    customerName: row.customerName,
    customerAddress: row.customerAddress,

    seller: row.seller,
    quote: row.quote,

    subtotal: row.subtotal.toFixed(2),
    discountAmount: row.discountAmount.toFixed(2),
    taxAmount: row.taxAmount.toFixed(2),
    total: row.total.toFixed(2),
    paidAmount: row.paidAmount.toFixed(2),
    balanceDue: row.balanceDue.toFixed(2),

    items: row.items.map(toSafeSaleItem),
    inventoryMovements: movements.map(toSafeSaleInventoryMovement),

    confirmedAt: row.confirmedAt,
    cancelledAt: row.cancelledAt,
    cancellationReason: row.cancellationReason,
    cancelledBy: row.cancelledBy,

    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
