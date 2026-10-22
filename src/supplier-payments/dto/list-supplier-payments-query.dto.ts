import { ApiPropertyOptional } from '@nestjs/swagger';
import { SupplierPaymentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/** Sin search/sort/orderBy/direction/amount range/reference: el orden es fijo (paymentDate desc, id desc) en el servicio. */
export class ListSupplierPaymentsQueryDto {
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
  supplierId?: string;

  @ApiPropertyOptional({ enum: SupplierPaymentStatus })
  @IsOptional()
  @IsEnum(SupplierPaymentStatus)
  status?: SupplierPaymentStatus;
}
