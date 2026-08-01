import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsInt, IsOptional, IsString, IsUUID, Max, Min } from 'class-validator';

/**
 * Query de GET /inventory/low-stock. El orden es siempre name ASC, sku ASC,
 * id ASC: no se acepta orderBy desde el cliente.
 */
export class ListLowStockQueryDto {
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
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    description: 'Búsqueda por sku o name (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
