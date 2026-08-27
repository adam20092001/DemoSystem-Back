import { ApiPropertyOptional } from '@nestjs/swagger';
import { ElectronicDocumentStatus, FiscalDocumentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  MaxLength,
  Min,
  ValidationArguments,
  ValidationOptions,
  registerDecorator,
} from 'class-validator';
import { isValidDateOnly } from '../../common/date/business-date';

/**
 * Mismo criterio que ListSalesQueryDto: definida localmente en vez de
 * importada de otro dominio (única lógica compartida real, el cálculo de
 * calendario, ya vive en business-date.ts).
 */
function IsDateOnly(validationOptions?: ValidationOptions) {
  return function (object: object, propertyName: string): void {
    registerDecorator({
      name: 'isDateOnly',
      target: object.constructor,
      propertyName,
      options: validationOptions,
      validator: {
        validate(value: unknown): boolean {
          return typeof value === 'string' && isValidDateOnly(value);
        },
        defaultMessage(args: ValidationArguments): string {
          return `${args.property} debe ser una fecha real en formato YYYY-MM-DD`;
        },
      },
    });
  };
}

/**
 * Sin orderBy/sort: el orden es fijo (issuedAt desc, id desc), igual
 * criterio que ListSalesQueryDto/AuditQueryDto. Sin filtros de diagnóstico
 * crudo de proveedor (Bloque 11D §11, decisión cerrada).
 */
export class ListElectronicDocumentsQueryDto {
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

  @ApiPropertyOptional({ enum: FiscalDocumentType })
  @IsOptional()
  @IsEnum(FiscalDocumentType)
  documentType?: FiscalDocumentType;

  @ApiPropertyOptional({ enum: ElectronicDocumentStatus })
  @IsOptional()
  @IsEnum(ElectronicDocumentStatus)
  status?: ElectronicDocumentStatus;

  @ApiPropertyOptional({
    example: 'F001',
    description: 'Coincidencia exacta de serie (sin normalización).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(4)
  series?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  saleId?: string;

  @ApiPropertyOptional({
    maxLength: 32,
    description: 'Coincidencia exacta del número de documento del cliente.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  customerDocumentNumber?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-01',
    description:
      'Fecha de negocio America/Lima, límite inferior inclusivo sobre issuedAt.',
  })
  @IsOptional()
  @IsDateOnly()
  issuedFrom?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-03-31',
    description:
      'Fecha de negocio America/Lima, límite superior inclusivo sobre issuedAt.',
  })
  @IsOptional()
  @IsDateOnly()
  issuedTo?: string;
}
