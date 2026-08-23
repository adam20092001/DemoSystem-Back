import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

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

  @ApiPropertyOptional({
    description:
      'Fase 9 (R5): filtro explícito por marca (insensible a mayúsculas, coincidencia parcial).',
  })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({
    enum: ProductStatus,
    description:
      'Fase 9 (R5): cuando se omite, se preserva el comportamiento histórico (solo ACTIVE). Cuando se informa, reemplaza ese filtro por el estado solicitado; el resto de las reglas de stock bajo no cambian.',
  })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;
}
