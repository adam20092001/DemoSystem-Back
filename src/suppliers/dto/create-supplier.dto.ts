import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { SupplierDocumentType } from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/** Mismo criterio exacto que CreateCustomerDto: solo recorta, el paso a minúsculas sigue siendo del servicio. */
function trimEmail({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * id, status, createdAt y updatedAt nunca se aceptan: son valores de
 * sistema fijados por SuppliersService. La normalización (trim/upper de
 * documentNumber, formato RUC/DNI, default de countryCode) se valida en el
 * servicio, no aquí, para no duplicar la lógica de dominio en dos capas
 * (mismo criterio que CreateCustomerDto).
 */
export class CreateSupplierDto {
  @ApiProperty({ enum: SupplierDocumentType })
  @IsEnum(SupplierDocumentType)
  documentType!: SupplierDocumentType;

  @ApiProperty({ maxLength: 32, example: '20123456789' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  documentNumber!: string;

  @ApiPropertyOptional({
    maxLength: 2,
    default: 'PE',
    description: 'ISO 3166-1 alpha-2. Por defecto "PE" si se omite.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @ApiProperty({ maxLength: 150, example: 'Importaciones Acme S.A.C.' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  legalName!: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  tradeName?: string;

  @ApiPropertyOptional({ maxLength: 120 })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  contactName?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(150)
  email?: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  address?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  internalNotes?: string;

  @ApiPropertyOptional({
    maxLength: 3,
    example: 'PEN',
    description:
      'Puramente informativo (ver blueprint de Fase A5, §3/§11): ningún cálculo ni posteo contable lo usa todavía.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  defaultCurrencyCode?: string;
}
