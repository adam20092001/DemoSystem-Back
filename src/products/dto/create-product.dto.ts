import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
  @ApiProperty({ maxLength: 40, example: 'SKU-0001' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  sku!: string;

  @ApiProperty({ maxLength: 150, example: 'Taladro percutor 750W' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ maxLength: 80 })
  @IsOptional()
  @IsString()
  @MaxLength(80)
  brand?: string;

  @ApiProperty({ enum: ProductType })
  @IsEnum(ProductType)
  productType!: ProductType;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  categoryId!: string;

  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  unitId!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal no negativo, máximo 2 decimales, como string.',
    example: '199.90',
  })
  @IsString()
  @Matches(SALE_PRICE_PATTERN, {
    message:
      'salePrice debe ser un decimal no negativo, como string, con máximo 2 decimales',
  })
  salePrice!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  commercialDescription?: string;

  @ApiPropertyOptional({
    maxLength: 1000,
    description: 'Oculto para el rol SELLER en las respuestas.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string;

  @ApiProperty({
    description: 'SERVICE exige false. Nunca controla stockCurrent.',
  })
  @IsBoolean()
  isInventoryTracked!: boolean;

  @ApiPropertyOptional({
    type: String,
    description:
      'Decimal no negativo, máximo 3 decimales, como string. Default "0". SERVICE exige "0".',
    example: '5.000',
  })
  @IsOptional()
  @IsString()
  @Matches(STOCK_QUANTITY_PATTERN, {
    message:
      'stockMinimum debe ser un decimal no negativo, como string, con máximo 3 decimales',
  })
  stockMinimum?: string;
}
