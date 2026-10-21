import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsNotEmpty,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';
import { ManualJournalLineDto } from './manual-journal-line.dto';

/** Mismo tope que una línea de SALE/PAYMENT real nunca necesita superar; defensivo contra un payload desproporcionado. */
const MAX_DRAFT_LINES = 50;

export class CreateManualJournalDraftDto {
  @ApiProperty({
    type: String,
    example: '2026-03-15',
    description: 'Fecha contable elegida por el ACCOUNTANT/ADMIN.',
  })
  @IsNotEmpty()
  @IsDateOnly()
  accountingDate!: string;

  @ApiProperty({ maxLength: 200, example: 'Ajuste manual de depreciación' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  description!: string;

  @ApiPropertyOptional({
    type: [ManualJournalLineDto],
    description:
      'Opcional: un borrador puede crearse sin líneas (o incompleto) y completarse después vía PATCH, mientras siga en estado DRAFT.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DRAFT_LINES)
  @ValidateNested({ each: true })
  @Type(() => ManualJournalLineDto)
  lines?: ManualJournalLineDto[];
}
