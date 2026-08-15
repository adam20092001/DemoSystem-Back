import { ApiProperty } from '@nestjs/swagger';
import {
  PaymentCancellationSource,
  PaymentMethod,
  PaymentStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';

/** Identidad mínima segura de un usuario: nunca role/passwordHash/campos de seguridad. */
export class PaymentUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

/** Forma segura de un pago: ACTIVE o CANCELLED (nunca se elimina físicamente). */
export class PaymentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  saleId!: string;

  @ApiProperty({ enum: PaymentMethod })
  method!: PaymentMethod;

  @ApiProperty({
    type: String,
    description: 'Decimal con 2 decimales fijos, como string.',
    example: '40.00',
  })
  amount!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Obligatoria en el dominio para BANK_TRANSFER/BANK_DEPOSIT/CARD; opcional para el resto.',
  })
  reference!: string | null;

  @ApiProperty({ enum: PaymentStatus })
  status!: PaymentStatus;

  @ApiProperty({
    type: String,
    format: 'date-time',
    description: 'Instante real de registro del pago, fijado por el backend.',
  })
  paidAt!: Date;

  @ApiProperty({ type: PaymentUserResponseDto })
  createdBy!: PaymentUserResponseDto;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  cancelledAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 200,
    description:
      'Obligatorio y no vacío cuando cancellationSource=MANUAL; siempre null cuando cancellationSource=SALE_CANCELLATION (no duplica el motivo de anulación de la venta).',
  })
  cancellationReason!: string | null;

  @ApiProperty({
    enum: PaymentCancellationSource,
    nullable: true,
    description:
      'MANUAL: anulación individual por un administrador. SALE_CANCELLATION: anulación automática en cascada al anular la venta que lo contiene.',
  })
  cancellationSource!: PaymentCancellationSource | null;

  @ApiProperty({ type: PaymentUserResponseDto, nullable: true })
  cancelledBy!: PaymentUserResponseDto | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** Respuesta paginada del listado global de pagos. */
export class PaginatedPaymentsResponseDto {
  @ApiProperty({ type: [PaymentResponseDto] })
  data!: PaymentResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

/**
 * Resumen mínimo de venta devuelto junto al pago mutado. Nunca la
 * SaleResponseDto completa (D4 aprobado): evita acoplar la respuesta de
 * Pagos a la forma de detalle de Ventas para ahorrarle al cliente HTTP un
 * segundo request tras registrar/anular un pago.
 */
export class SalePaymentSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'NV-000001' })
  number!: string;

  @ApiProperty({ enum: SaleStatus })
  status!: SaleStatus;

  @ApiProperty({ type: String })
  total!: string;

  @ApiProperty({
    type: String,
    description:
      'Para una venta ACTIVE, suma de los pagos ACTIVE (recalculada tras cada registro/anulación).',
  })
  paidAmount!: string;

  @ApiProperty({ type: String })
  balanceDue!: string;

  @ApiProperty({ enum: SalePaymentStatus })
  paymentStatus!: SalePaymentStatus;
}

/** Respuesta de registrar/anular un pago: el pago mutado + el resumen de pago de la venta ya recalculado. */
export class PaymentMutationResponseDto {
  @ApiProperty({ type: PaymentResponseDto })
  payment!: PaymentResponseDto;

  @ApiProperty({ type: SalePaymentSummaryResponseDto })
  sale!: SalePaymentSummaryResponseDto;
}
