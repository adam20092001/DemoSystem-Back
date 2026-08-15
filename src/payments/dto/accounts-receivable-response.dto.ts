import { ApiProperty } from '@nestjs/swagger';
import { SalePaymentStatus } from '@prisma/client';

/**
 * Fila segura de cuentas por cobrar: ventas ACTIVE con balanceDue>0. Nunca
 * el estado vigente de Customer, notas internas, referencia de Payment,
 * filas de Payment, inventario ni detalle de Quote — solo lo necesario para
 * la pantalla de cuentas por cobrar (reporte #10 del Documento Maestro).
 */
export class ReceivableItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  saleId!: string;

  @ApiProperty({ example: 'NV-000001' })
  saleNumber!: string;

  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, nullable: true })
  customerDocumentNumber!: string | null;

  @ApiProperty({ format: 'uuid' })
  sellerId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  confirmedAt!: Date;

  @ApiProperty({ type: String })
  total!: string;

  @ApiProperty({ type: String })
  paidAmount!: string;

  @ApiProperty({ type: String })
  balanceDue!: string;

  @ApiProperty({ enum: SalePaymentStatus })
  paymentStatus!: SalePaymentStatus;

  @ApiProperty({
    description:
      'Días de calendario transcurridos entre la fecha de negocio de confirmación (America/Lima) y hoy. Nunca negativo. No es una medida de mora contra una fecha de vencimiento: no existe dueDate en el MVP.',
    example: 12,
  })
  daysOutstanding!: number;
}

/** Respuesta paginada de cuentas por cobrar, deuda más antigua primero. */
export class PaginatedReceivablesResponseDto {
  @ApiProperty({ type: [ReceivableItemResponseDto] })
  data!: ReceivableItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
