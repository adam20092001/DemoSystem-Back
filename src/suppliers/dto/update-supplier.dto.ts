import { ApiPropertyOptional } from '@nestjs/swagger';
import { SupplierDocumentType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
} from 'class-validator';

/** Mismo criterio exacto que UpdateCustomerDto. No toca null: @IsOptional() sigue tratándolo como "limpiar email". */
function trimEmail({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * status es inmutable aquí (cambia solo por activate()/deactivate()).
 * documentType/documentNumber NUNCA aceptan null (a diferencia de
 * UpdateCustomerDto): un proveedor siempre exige documento — solo pueden
 * reemplazarse juntos por un valor nuevo, nunca limpiarse.
 */
export class UpdateSupplierDto {
  @ApiPropertyOptional({ enum: SupplierDocumentType })
  @IsOptional()
  @IsEnum(SupplierDocumentType)
  documentType?: SupplierDocumentType;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  documentNumber?: string;

  @ApiPropertyOptional({ maxLength: 2, description: 'ISO 3166-1 alpha-2.' })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  legalName?: string;

  @ApiPropertyOptional({ maxLength: 150, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  tradeName?: string | null;

  @ApiPropertyOptional({ maxLength: 120, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string | null;

  @ApiPropertyOptional({ maxLength: 30, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string | null;

  @ApiPropertyOptional({ maxLength: 150, nullable: true })
  @IsOptional()
  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(150)
  email?: string | null;

  @ApiPropertyOptional({ maxLength: 300, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string | null;

  @ApiPropertyOptional({ maxLength: 1000, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string | null;

  @ApiPropertyOptional({ maxLength: 3, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  defaultCurrencyCode?: string | null;
}
