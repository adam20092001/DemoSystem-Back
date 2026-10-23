import { ApiPropertyOptional } from '@nestjs/swagger';
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
import { IMPORT_EXPENSE_MONEY_PATTERN } from './create-import-expense.dto';

/**
 * status es inmutable aquí (usar finalize()/cancel()). Solo aplicable
 * mientras el gasto está DRAFT. amount/currencyCode adicionalmente se
 * bloquean si ya existe algún lote de asignación.
 */
export class UpdateImportExpenseDto {
  @ApiPropertyOptional({ enum: ImportExpenseCategory })
  @IsOptional()
  @IsEnum(ImportExpenseCategory)
  category?: ImportExpenseCategory;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
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

  @ApiPropertyOptional({ type: String, example: '2026-11-05' })
  @IsOptional()
  @IsDateOnly()
  expenseDate?: string;

  @ApiPropertyOptional({ maxLength: 3, example: 'USD' })
  @IsOptional()
  @IsString()
  @MaxLength(3)
  currencyCode?: string;

  @ApiPropertyOptional({ type: String, example: '1250.00' })
  @IsOptional()
  @IsString()
  @Matches(IMPORT_EXPENSE_MONEY_PATTERN, {
    message:
      'amount debe ser un decimal positivo, como texto, con máximo 2 decimales',
  })
  amount?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  remarks?: string;
}
