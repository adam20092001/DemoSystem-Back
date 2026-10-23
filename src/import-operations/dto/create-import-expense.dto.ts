import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  ImportExpenseCategory,
  ImportExpenseDocumentType,
} from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
} from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';

/** Decimal como texto, positivo, máximo 2 decimales (Decimal(14,2)). */
export const IMPORT_EXPENSE_MONEY_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * id, status y toda auditoría de finalización/cancelación nunca se
 * aceptan: son valores de sistema. category es descriptiva, NUNCA una
 * clasificación contable automática (CLAUDE.md B2 §1/§2).
 */
export class CreateImportExpenseDto {
  @ApiProperty({ enum: ImportExpenseCategory })
  @IsEnum(ImportExpenseCategory)
  category!: ImportExpenseCategory;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Opcional e independiente del proveedor de la mercadería: un gasto de importación puede pertenecer a un agente de carga/aduanas distinto.',
  })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Vínculo OPCIONAL a una línea de factura de compra CONFIRMED existente. Nunca modifica esa factura.',
  })
  @IsOptional()
  @IsUUID()
  purchaseInvoiceLineId?: string;

  @ApiPropertyOptional({ enum: ImportExpenseDocumentType })
  @IsOptional()
  @IsEnum(ImportExpenseDocumentType)
  documentType?: ImportExpenseDocumentType;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  documentReference?: string;

  @ApiProperty({ type: String, example: '2026-11-05' })
  @IsDateOnly()
  expenseDate!: string;

  @ApiProperty({
    maxLength: 3,
    example: 'USD',
    description:
      'Moneda del documento ORIGINAL — nunca convertida a la moneda de la empresa (CLAUDE.md B2 §4).',
  })
  @IsString()
  @MaxLength(3)
  currencyCode!: string;

  @ApiProperty({ type: String, example: '1250.00' })
  @IsString()
  @Matches(IMPORT_EXPENSE_MONEY_PATTERN, {
    message:
      'amount debe ser un decimal positivo, como texto, con máximo 2 decimales',
  })
  amount!: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}
