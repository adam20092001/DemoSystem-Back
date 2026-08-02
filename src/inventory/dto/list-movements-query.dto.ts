import { ApiPropertyOptional } from '@nestjs/swagger';
import { InventoryMovementOrigin, InventoryMovementType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsISO8601,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * Query de GET /inventory/movements y GET /inventory/products/:productId/movements.
 * El orden es siempre createdAt DESC, id DESC: no se acepta orderBy ni
 * dirección de orden desde el cliente. En el endpoint por producto, el
 * controller ignora/valida productId contra el parámetro de ruta: no lo
 * duplica en un segundo DTO.
 */
export class ListMovementsQueryDto {
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
  productId?: string;

  @ApiPropertyOptional({ enum: InventoryMovementType })
  @IsOptional()
  @IsEnum(InventoryMovementType)
  movementType?: InventoryMovementType;

  @ApiPropertyOptional({ enum: InventoryMovementOrigin })
  @IsOptional()
  @IsEnum(InventoryMovementOrigin)
  origin?: InventoryMovementOrigin;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  createdByUserId?: string;

  @ApiPropertyOptional({ description: 'Fecha ISO 8601, límite inclusivo.' })
  @IsOptional()
  @IsISO8601()
  dateFrom?: string;

  @ApiPropertyOptional({ description: 'Fecha ISO 8601, límite inclusivo.' })
  @IsOptional()
  @IsISO8601()
  dateTo?: string;

  @ApiPropertyOptional({
    description:
      'Búsqueda por sku o name del producto (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  search?: string;
}
