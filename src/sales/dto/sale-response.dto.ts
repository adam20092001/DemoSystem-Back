import { ApiProperty } from '@nestjs/swagger';
import {
  CustomerDocumentType,
  CustomerType,
  InventoryMovementOrigin,
  InventoryMovementType,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';

/** Identidad mínima del vendedor: nunca role/passwordHash/campos de seguridad. */
export class SaleSellerResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

/** Misma forma segura que el vendedor; quien ejecutó la anulación. */
export class SaleCancelledByResponseDto extends SaleSellerResponseDto {}

/** Referencia mínima a la cotización de origen; null en toda venta directa. */
export class SaleQuoteReferenceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'COT-000001' })
  number!: string;
}

export class SaleItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  productSku!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty()
  unitCode!: string;

  @ApiProperty()
  unitName!: string;

  @ApiProperty()
  unitAbbreviation!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '2.500',
  })
  quantity!: string;

  @ApiProperty({
    type: String,
    description:
      'Decimal con 2 decimales fijos, como string. Snapshot de Product.salePrice vigente (venta directa) o del QuoteItem original, sin repreciar (venta desde cotización).',
    example: '199.90',
  })
  unitPrice!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 2 decimales fijos, como string.',
    example: '499.75',
  })
  lineTotal!: string;
}

/**
 * Movimiento de inventario asociado a la venta (referencia polimórfica,
 * sin FK). Solo campos seguros: nunca reason/notes/createdBy/metadata de
 * auditoría.
 */
export class SaleInventoryMovementResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ enum: InventoryMovementType })
  movementType!: InventoryMovementType;

  @ApiProperty({
    enum: InventoryMovementOrigin,
    description:
      'SALE en la salida original; SALE_CANCELLATION en la reversa por anulación.',
  })
  origin!: InventoryMovementOrigin;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
  })
  quantity!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
  })
  previousStock!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
  })
  newStock!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;
}

/** Forma de listado: sin ítems ni movimientos de inventario (ver SaleResponseDto para el detalle). */
export class SaleListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'NV-000001' })
  number!: string;

  @ApiProperty({ enum: SaleStatus })
  status!: SaleStatus;

  @ApiProperty({
    enum: SalePaymentStatus,
    description:
      'Resumen de pago preparado para la Fase 7. En la Fase 6, sin modelo Payment, solo UNPAID o PAID.',
  })
  paymentStatus!: SalePaymentStatus;

  @ApiProperty({ enum: SaleDeliveryStatus })
  deliveryStatus!: SaleDeliveryStatus;

  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, nullable: true })
  customerDocumentNumber!: string | null;

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ type: String })
  subtotal!: string;

  @ApiProperty({ type: String })
  discountAmount!: string;

  @ApiProperty({ type: String, description: 'Siempre "0.00" en la Fase 6.' })
  taxAmount!: string;

  @ApiProperty({ type: String })
  total!: string;

  @ApiProperty({
    type: String,
    description:
      'Siempre "0.00" en la Fase 6: sin registros de Payment todavía.',
  })
  paidAmount!: string;

  @ApiProperty({ type: String })
  balanceDue!: string;

  @ApiProperty()
  itemCount!: number;

  @ApiProperty({ type: String, format: 'date-time' })
  confirmedAt!: Date;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** Forma de detalle: snapshot completo de cliente, vendedor seguro, ítems y movimientos de inventario. */
export class SaleResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'NV-000001' })
  number!: string;

  @ApiProperty({ enum: SaleStatus })
  status!: SaleStatus;

  @ApiProperty({
    enum: SalePaymentStatus,
    description:
      'Resumen de pago preparado para la Fase 7. En la Fase 6, sin modelo Payment, solo UNPAID o PAID.',
  })
  paymentStatus!: SalePaymentStatus;

  @ApiProperty({ enum: SaleDeliveryStatus })
  deliveryStatus!: SaleDeliveryStatus;

  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty({
    description:
      'true únicamente para el cliente genérico "Público general". Una venta a Público general solo se confirma si balanceDue queda en 0.',
  })
  customerIsGeneric!: boolean;

  @ApiProperty({
    enum: CustomerType,
    nullable: true,
    description:
      'null únicamente cuando customerIsGeneric=true (a diferencia de Quote, que no admite genérico).',
  })
  customerType!: CustomerType | null;

  @ApiProperty({ enum: CustomerDocumentType, nullable: true })
  customerDocumentType!: CustomerDocumentType | null;

  @ApiProperty({ type: String, nullable: true })
  customerDocumentNumber!: string | null;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, nullable: true })
  customerAddress!: string | null;

  @ApiProperty({ type: SaleSellerResponseDto })
  seller!: SaleSellerResponseDto;

  @ApiProperty({
    type: SaleQuoteReferenceResponseDto,
    nullable: true,
    description: 'null en toda venta directa.',
  })
  quote!: SaleQuoteReferenceResponseDto | null;

  @ApiProperty({ type: String })
  subtotal!: string;

  @ApiProperty({ type: String })
  discountAmount!: string;

  @ApiProperty({ type: String, description: 'Siempre "0.00" en la Fase 6.' })
  taxAmount!: string;

  @ApiProperty({ type: String })
  total!: string;

  @ApiProperty({
    type: String,
    description:
      'Siempre "0.00" en la Fase 6: sin registros de Payment todavía.',
  })
  paidAmount!: string;

  @ApiProperty({ type: String })
  balanceDue!: string;

  @ApiProperty({ type: [SaleItemResponseDto] })
  items!: SaleItemResponseDto[];

  @ApiProperty({ type: [SaleInventoryMovementResponseDto] })
  inventoryMovements!: SaleInventoryMovementResponseDto[];

  @ApiProperty({ type: String, format: 'date-time' })
  confirmedAt!: Date;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 200 })
  cancellationReason!: string | null;

  @ApiProperty({ type: SaleCancelledByResponseDto, nullable: true })
  cancelledBy!: SaleCancelledByResponseDto | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PaginatedSalesResponseDto {
  @ApiProperty({ type: [SaleListItemResponseDto] })
  data!: SaleListItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
