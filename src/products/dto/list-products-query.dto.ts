import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductStatus, ProductType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';
import { toStrictBoolean } from '../../common/validators/to-strict-boolean.transform';

export class ListProductsQueryDto {
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

  @ApiPropertyOptional({
    description: 'Búsqueda por sku, name o brand (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({ enum: ProductType })
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @ApiPropertyOptional({
    enum: ProductStatus,
    description: 'SELLER siempre ve solo ACTIVE, sin importar este valor.',
  })
  @IsOptional()
  @IsEnum(ProductStatus)
  status?: ProductStatus;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Acepta true/false (boolean o string). Cualquier otro valor falla la validación.',
  })
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  isInventoryTracked?: boolean;

  @ApiPropertyOptional({
    description:
      'Filtro explícito por marca (insensible a mayúsculas, coincidencia parcial, igual criterio que "search"). Distinto del parámetro "search" general: puede combinarse con él.',
  })
  @IsOptional()
  @IsString()
  brand?: string;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Fase 9 (R6): cuando es true, filtra en base de datos a productos inventariables con stockCurrent <= stockMinimum. Acepta true/false (boolean o string); cualquier otro valor falla la validación. Incompatible con isInventoryTracked=false.',
  })
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  lowStockOnly?: boolean;
}
