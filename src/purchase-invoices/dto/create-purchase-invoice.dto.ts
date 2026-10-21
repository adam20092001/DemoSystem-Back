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

  @ApiPropertyOptional({ type: [CreatePurchaseInvoiceLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(0)
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseInvoiceLineDto)
  lines?: CreatePurchaseInvoiceLineDto[];
}
