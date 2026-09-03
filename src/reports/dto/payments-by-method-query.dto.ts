import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentStatus } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
} from 'class-validator';
import { ReportDateRangeQueryDto } from './report-date-range-query.dto';

/**
 * R9 — Pagos por método. Tabular (una fila por Payment), todos los estados
 * visibles por defecto; `from`/`to` filtran Payment.paidAt. `method`
 * (Ticket C, Bloque C3) es un código de método de pago dinámico, filtrado
 * contra el snapshot histórico Payment.paymentMethodCode — nunca un join
 * en vivo contra el PaymentMethod actual.
 */
export class PaymentsByMethodQueryDto extends ReportDateRangeQueryDto {
  @ApiPropertyOptional({
    type: String,
    example: 'CASH',
    description:
      'Código de método de pago dinámico. Filtra por el snapshot histórico (Payment.paymentMethodCode).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  method?: string;

  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  createdByUserId?: string;
}
