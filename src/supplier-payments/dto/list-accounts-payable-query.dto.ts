import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsUUID, Max, Min } from 'class-validator';

/**
 * Sin status/paymentStatus/search/orderBy/direction/aging bucket/dueDate: la
 * definición de cuenta por pagar es fija (PurchaseInvoice.status=CONFIRMED)
 * y el orden es fijo (issueDate asc, id asc — deuda más antigua primero) en
 * el servicio.
 */
export class ListAccountsPayableQueryDto {
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
}
