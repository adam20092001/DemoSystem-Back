import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * Sin status/paymentStatus/method/minBalance/search/orderBy/direction/
 * aging bucket/dueDate: la definición de cuenta por cobrar es fija
 * (Sale.status=ACTIVE AND balanceDue>0) y el orden es fijo (confirmedAt
 * asc, id asc — deuda más antigua primero) en el servicio.
 */
export class ListReceivablesQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sellerId?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo de Sale.confirmedAt. El servicio valida confirmedFrom <= confirmedTo.',
  })
  @IsOptional()
  @IsDateOnly()
  confirmedFrom?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description: 'Fecha de negocio America/Lima, límite superior inclusivo.',
  })
  @IsOptional()
  @IsDateOnly()
  confirmedTo?: string;
}
