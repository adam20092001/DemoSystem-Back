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
 * stockCurrent y status nunca se aceptan aquí: todo producto nace ACTIVE
 * con stockCurrent="0.000". salePrice/stockMinimum exigen string (no number
 * de JavaScript) para no arriesgar precisión de punto flotante.
 */
export class CreateProductDto {
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  sku!: string;

  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  brand?: string;

  @IsEnum(ProductType)
  productType!: ProductType;

  @IsUUID()
  categoryId!: string;

  @IsUUID()
  unitId!: string;

  @IsString()
  @Matches(SALE_PRICE_PATTERN, {
    message:
      'salePrice debe ser un decimal no negativo, como string, con máximo 2 decimales',
  })
  salePrice!: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  commercialDescription?: string;

  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string;

  @IsBoolean()
  isInventoryTracked!: boolean;

  @IsOptional()
  @IsString()
  @Matches(STOCK_QUANTITY_PATTERN, {
    message:
      'stockMinimum debe ser un decimal no negativo, como string, con máximo 3 decimales',
  })
  stockMinimum?: string;
}
