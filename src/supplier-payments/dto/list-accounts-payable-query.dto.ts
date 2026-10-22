import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Max, Min } from 'class-validator';
import { AGING_BUCKET_ORDER } from '../accounts-payable-calculator';
import { AccountsPayableFilterQueryDto } from './accounts-payable-filter-query.dto';

/**
 * Sin search/orderBy/direction: el orden es fijo (issueDate asc, id asc —
 * deuda más antigua primero) en el servicio. `agingBucket` es exclusivo
 * de este listado (filtrar la antigüedad antes de calcularla no tiene
 * sentido en los reportes de resumen/aging, que justamente la calculan).
 */
export class ListAccountsPayableQueryDto extends AccountsPayableFilterQueryDto {
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

  @ApiPropertyOptional({ enum: AGING_BUCKET_ORDER })
  @IsOptional()
  @IsIn(AGING_BUCKET_ORDER)
  agingBucket?: (typeof AGING_BUCKET_ORDER)[number];
}
