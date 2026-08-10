import {
  CustomerDocumentType,
  CustomerType,
  InventoryMovementOrigin,
  InventoryMovementType,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';

/** Identidad mínima segura de un usuario: nunca role/passwordHash/campos de seguridad. */
export interface SafeSaleSeller {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

export type SafeSaleCancelledBy = SafeSaleSeller;

/** Referencia mínima a la cotización de origen; null en toda venta directa. */
export interface SafeSaleQuoteReference {
  id: string;
  number: string;
}

export interface SafeSaleItem {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
}

/**
 * Movimiento de inventario asociado a la venta, obtenido mediante una
 * segunda consulta filtrada por referenceType='Sale'/referenceId=sale.id
 * (la referencia es polimórfica, sin FK — no se puede `include` desde
 * Sale). Solo campos seguros: nunca reason/notes/createdBy/metadata de
 * auditoría.
 */
export interface SafeSaleInventoryMovement {
  id: string;
  productId: string;
  movementType: InventoryMovementType;
  origin: InventoryMovementOrigin;
  quantity: string;
  previousStock: string;
  newStock: string;
  createdAt: Date;
}

/** Forma de listado: sin ítems ni movimientos, con conteo (itemCount) vía _count. */
export interface SafeSaleListItem {
  id: string;
  number: string;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  deliveryStatus: SaleDeliveryStatus;
  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;
  sellerId: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  balanceDue: string;
  itemCount: number;
  confirmedAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

/** Forma de detalle: snapshot completo de cliente, vendedor seguro, ítems y movimientos de inventario. */
export interface SafeSale {
  id: string;
  number: string;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  deliveryStatus: SaleDeliveryStatus;

  customerId: string;
  customerIsGeneric: boolean;
  customerType: CustomerType | null;
  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;

  seller: SafeSaleSeller;
  quote: SafeSaleQuoteReference | null;

  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  balanceDue: string;

  items: SafeSaleItem[];
  inventoryMovements: SafeSaleInventoryMovement[];

  confirmedAt: Date;
  cancelledAt: Date | null;
  cancellationReason: string | null;
  cancelledBy: SafeSaleCancelledBy | null;

  createdAt: Date;
  updatedAt: Date;
}
