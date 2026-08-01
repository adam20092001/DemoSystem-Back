import { ApiPropertyOptional } from '@nestjs/swagger';
import { ProductType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { SALE_PRICE_PATTERN, STOCK_QUANTITY_PATTERN } from './decimal-patterns';

/**
 * stockCurrent y status nunca se aceptan aquí. brand, commercialDescription
 * e internalNotes admiten null explícito para limpiarlos; @IsOptional()
 * de class-validator omite el resto de validadores cuando el valor es null.
 */
export class UpdateProductDto {
  @ApiPropertyOptional({ maxLength: 40 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  sku?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({ maxLength: 80, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  brand?: string | null;

  @ApiPropertyOptional({
    enum: ProductType,
    description:
      'Al convertir a SERVICE, isInventoryTracked debe enviarse en false y stockMinimum en "0" (efectivo, combinando con lo ya almacenado).',
  })
  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  unitId?: string;

  @ApiPropertyOptional({
    type: String,
    description:
      'Decimal no negativo, máximo 2 decimales, como string. Un cambio real de valor genera auditoría PRODUCT_PRICE_CHANGED.',
    example: '210.00',
  })
  @IsOptional()
  @IsString()
  @Matches(SALE_PRICE_PATTERN, {
    message:
      'salePrice debe ser un decimal no negativo, como string, con máximo 2 decimales',
  })
  salePrice?: string;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  commercialDescription?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string | null;

  @ApiPropertyOptional()
  @IsOptional()
  @IsBoolean()
  isInventoryTracked?: boolean;

  @ApiPropertyOptional({
    type: String,
    description: 'Decimal no negativo, máximo 3 decimales, como string.',
    example: '2.500',
  })
  @IsOptional()
  @IsString()
  @Matches(STOCK_QUANTITY_PATTERN, {
    message:
      'stockMinimum debe ser un decimal no negativo, como string, con máximo 3 decimales',
  })
  stockMinimum?: string;
}
