import { ApiPropertyOptional } from '@nestjs/swagger';
import { PurchaseInvoiceDocumentType } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsArray,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { CreatePurchaseInvoiceLineDto } from './purchase-invoice-line.dto';
import { IsDateOnly } from './is-date-only.decorator';

/**
 * Solo aplicable mientras status=DRAFT (el servicio lo exige, no este
 * DTO). `lines`, si se provee, reemplaza el arreglo completo — nunca un
 * parche línea a línea (mismo criterio que ManualJournalDraft, A4.2).
 * supplierId/status/currencyCode/montos de cabecera son inmutables.
 */
export class UpdatePurchaseInvoiceDto {
  @ApiPropertyOptional({ enum: PurchaseInvoiceDocumentType })
  @IsOptional()
  @IsEnum(PurchaseInvoiceDocumentType)
  documentType?: PurchaseInvoiceDocumentType;

  @ApiPropertyOptional({ maxLength: 20, nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(20)
  documentSeries?: string | null;

  @ApiPropertyOptional({ maxLength: 32 })
  @IsOptional()
  @IsString()
  @MaxLength(32)
  documentNumber?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsDateOnly()
  issueDate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsDateOnly()
  registrationDate?: string;

  @ApiPropertyOptional({ type: String })
  @IsOptional()
  @IsDateOnly()
  accountingDate?: string;

  @ApiPropertyOptional({ type: String, nullable: true })
  @IsOptional()
  @IsDateOnly()
  dueDate?: string | null;

  @ApiPropertyOptional({ minimum: 0, maximum: 365, nullable: true })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(365)
  paymentTermsDays?: number | null;

  @ApiPropertyOptional({
    example: 'USD',
    description:
      'Moneda del documento (ISO 4217). Cambiarla exige recalcular la tasa.',
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
      'Unidades de moneda de la EMPRESA por 1 unidad de moneda del documento (hasta 8 decimales).',
  })
  @IsOptional()
  @IsString()
  @Matches(/^\d{1,10}(\.\d{1,8})?$/, {
    message:
      'exchangeRate debe ser un decimal positivo, como texto, con máximo 8 decimales',
  })
  exchangeRate?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-23' })
  @IsOptional()
  @IsDateOnly()
  exchangeRateDate?: string;

  @ApiPropertyOptional({ type: [CreatePurchaseInvoiceLineDto] })
  @IsOptional()
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CreatePurchaseInvoiceLineDto)
  lines?: CreatePurchaseInvoiceLineDto[];
}
