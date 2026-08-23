import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ReportDateRangeQueryDto } from './report-date-range-query.dto';

/** R9 — Pagos por método. Tabular (una fila por Payment), todos los estados visibles por defecto; `from`/`to` filtran Payment.paidAt. */
export class PaymentsByMethodQueryDto extends ReportDateRangeQueryDto {
  @ApiPropertyOptional({ enum: PaymentMethod })
  @IsOptional()
  @IsEnum(PaymentMethod)
  method?: PaymentMethod;

  @ApiPropertyOptional({ enum: PaymentStatus })
  @IsOptional()
  @IsEnum(PaymentStatus)
  status?: PaymentStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  createdByUserId?: string;
}
