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
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  sku?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  brand?: string | null;

  @IsOptional()
  @IsEnum(ProductType)
  productType?: ProductType;

  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @IsOptional()
  @IsUUID()
  unitId?: string;

  @IsOptional()
  @IsString()
  @Matches(SALE_PRICE_PATTERN, {
    message:
      'salePrice debe ser un decimal no negativo, como string, con máximo 2 decimales',
  })
  salePrice?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  commercialDescription?: string | null;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string | null;

  @IsOptional()
  @IsBoolean()
  isInventoryTracked?: boolean;

  @IsOptional()
  @IsString()
  @Matches(STOCK_QUANTITY_PATTERN, {
    message:
      'stockMinimum debe ser un decimal no negativo, como string, con máximo 3 decimales',
  })
  stockMinimum?: string;
}
