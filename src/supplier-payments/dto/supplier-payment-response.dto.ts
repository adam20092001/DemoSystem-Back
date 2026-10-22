import { ApiProperty } from '@nestjs/swagger';
import { SupplierPaymentStatus } from '@prisma/client';

export class SupplierPaymentAllocationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceId!: string;

  @ApiProperty({ type: String })
  amount!: string;
}

/** Forma segura de un pago a proveedor: ACTIVE o CANCELLED (nunca se elimina físicamente). */
export class SupplierPaymentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty({ type: String, example: '2026-10-21' })
  paymentDate!: string;

  @ApiProperty({ type: String })
  amount!: string;

  @ApiProperty({ type: String, example: 'PEN' })
  currencyCode!: string;

  @ApiProperty({
    type: String,
    example: 'CASH',
    description:
      'Código del método de pago dinámico snapshoteado en el instante del cobro — nunca el code actual si el método cambió/se desactivó después.',
  })
  paymentMethodCode!: string;

  @ApiProperty({ type: String, example: 'Efectivo' })
  paymentMethodName!: string;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;

  @ApiProperty({ type: String, nullable: true })
  idempotencyKey!: string | null;

  @ApiProperty({ enum: SupplierPaymentStatus })
  status!: SupplierPaymentStatus;

  @ApiProperty({ format: 'uuid' })
  postedEntryId!: string;

  @ApiProperty({ format: 'uuid' })
  createdByUserId!: string;

  @ApiProperty({ type: Date, nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  cancelledByUserId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ type: [SupplierPaymentAllocationResponseDto] })
  allocations!: SupplierPaymentAllocationResponseDto[];
}

/** Respuesta paginada del listado global de pagos a proveedores. */
export class PaginatedSupplierPaymentsResponseDto {
  @ApiProperty({ type: [SupplierPaymentResponseDto] })
  data!: SupplierPaymentResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
