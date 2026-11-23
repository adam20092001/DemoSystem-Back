import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseInvoiceDocumentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  Max,
  MaxLength,
  Min,
  MinLength,
  ValidateNested,
} from 'class-validator';
import { CreatePurchaseInvoiceLineDto } from './purchase-invoice-line.dto';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * id, status, subtotal/taxAmount/totalAmount, currencyCode y toda
 * auditoría de confirmación/anulación nunca se aceptan: son valores de
 * sistema fijados por PurchaseInvoicesService (currencyCode siempre
 * CompanySettings.currencyCode vigente, mismo criterio que Sale, A0.2).
 * Puede crearse sin líneas o con líneas incompletas — toda validación
 * tributaria/de cuadre estricta se exige recién al confirmar.
 */
export class CreatePurchaseInvoiceDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  supplierId!: string;

  @ApiProperty({ enum: PurchaseInvoiceDocumentType })
  @IsEnum(PurchaseInvoiceDocumentType)
  documentType!: PurchaseInvoiceDocumentType;

  @ApiPropertyOptional({
    maxLength: 20,
    description:
      'Serie del documento del proveedor. Opcional: muchos documentos extranjeros no tienen serie separada.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  documentSeries?: string;

  @ApiProperty({ maxLength: 32, example: '00001234' })
  @IsString()
  @MinLength(1)
  @MaxLength(32)
  documentNumber!: string;

  @ApiProperty({ type: String, example: '2026-10-15' })
  @IsDateOnly()
  issueDate!: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-10-18',
    description: 'Por defecto, la fecha de negocio actual si se omite.',
  })
  @IsOptional()
  @IsDateOnly()
  registrationDate?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-10-18',
    description:
      'Por defecto, la fecha de negocio actual si se omite. Editable mientras DRAFT; el periodo contable correspondiente debe existir y estar OPEN al confirmar (o ser el mes en curso).',
  })
  @IsOptional()
  @IsDateOnly()
  accountingDate?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-15' })
  @IsOptional()
  @IsDateOnly()
  dueDate?: string;

  @ApiPropertyOptional({ minimum: 0, maximum: 365 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number;

  @ApiPropertyOptional({
    example: 'USD',
    description:
      'Moneda del documento (ISO 4217, 3 letras). Por defecto la moneda de la empresa. Los importes de la solicitud (costo unitario, crédito fiscal) están en esta moneda.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^[A-Za-z]{3}$/, {
    message: 'currencyCode debe ser un código de moneda de 3 letras (ISO 4217)',
  })
  currencyCode?: string;

  @ApiPropertyOptional({
    type: String,
    example: '3.70',
    description:
      'Unidades de moneda de la EMPRESA por 1 unidad de moneda del documento. Obligatorio si la moneda difiere de la de la empresa; con la misma moneda es 1. Hasta 8 decimales, positivo. Se congela al confirmar.',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,10}(\.\d{1,8})?$/, {
    message:
      'exchangeRate debe ser un decimal positivo, como texto, con máximo 8 decimales',
  })
  exchangeRate?: string;

  @ApiPropertyOptional({
    type: String,
    example: '2026-11-23',
    description:
      'Fecha del tipo de cambio (YYYY-MM-DD). Por defecto, la fecha de emisión.',
  })
  @IsOptional()
  @IsDateOnly()
  exchangeRateDate?: string;

  @ApiPropertyOptional({ type: [CreatePurchaseInvoiceLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseInvoiceLineDto)
  lines?: CreatePurchaseInvoiceLineDto[];
}
