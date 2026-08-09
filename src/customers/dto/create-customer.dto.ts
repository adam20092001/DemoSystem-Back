import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerType,
} from '@prisma/client';
import { Transform } from 'class-transformer';
import {
  IsEmail,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Recorta espacios perimetrales antes de que @IsEmail() evalúe el valor
 * crudo: sin esto, un email válido con espacios ("  x@x.com  ") sería
 * rechazado aquí y nunca llegaría a CustomersService, que es quien aplica
 * trim+lowercase como normalización de dominio (esta función solo recorta;
 * el paso a minúsculas sigue siendo responsabilidad exclusiva del servicio).
 */
function trimEmail({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

/**
 * Solo cubre la creación de clientes normales. id, code, isGeneric, status,
 * createdAt y updatedAt nunca se aceptan: son valores de sistema fijados por
 * CustomersService, nunca controlados por el llamador. El par de documento
 * (mitad incompleta, normalización trim/upper) se valida en el servicio, no
 * aquí, para no duplicar la lógica de dominio en dos capas.
 */
export class CreateCustomerDto {
  @ApiProperty({ enum: CustomerType })
  @IsEnum(CustomerType)
  customerType!: CustomerType;

  @ApiProperty({ enum: CustomerStage })
  @IsEnum(CustomerStage)
  customerStage!: CustomerStage;

  @ApiProperty({ maxLength: 150, example: 'Juan Pérez' })
  @IsString()
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiPropertyOptional({ enum: CustomerDocumentType })
  @IsOptional()
  @IsEnum(CustomerDocumentType)
  documentType?: CustomerDocumentType;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  documentNumber?: string;

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

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @Transform(trimEmail)
  @IsEmail()
  @MaxLength(150)
  email?: string;

  @ApiPropertyOptional({ maxLength: 30 })
  @IsOptional()
  @IsString()
  @MaxLength(30)
  phone?: string;

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
}
