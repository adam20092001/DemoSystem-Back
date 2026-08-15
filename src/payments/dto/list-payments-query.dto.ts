import { ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod, PaymentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';

/** Sin search/sort/orderBy/direction/amount range/reference/customerId/sellerId: el orden es fijo (paidAt desc, id desc) en el servicio. */
export class ListPaymentsQueryDto {
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

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo. El servicio valida paidFrom <= paidTo.',
  })
  @IsOptional()
  @IsDateOnly()
  paidFrom?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description: 'Fecha de negocio America/Lima, límite superior inclusivo.',
  })
  @IsOptional()
  @IsDateOnly()
  paidTo?: string;
}
