import { ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
  IsArray,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';
import { ManualJournalLineDto } from './manual-journal-line.dto';

const MAX_DRAFT_LINES = 50;

/**
 * Todo opcional: PATCH parcial. `lines`, cuando se envía, REEMPLAZA el
 * arreglo completo de líneas del borrador (A4.2) — nunca un parche línea
 * a línea. Solo aplicable mientras el borrador esté en estado DRAFT
 * (ManualJournalEntriesService.updateDraft() lo exige bajo lock de fila).
 */
export class UpdateManualJournalDraftDto {
  @ApiPropertyOptional({ type: String, example: '2026-03-20' })
  @IsOptional()
  @IsDateOnly()
  accountingDate?: string;

  @ApiPropertyOptional({ maxLength: 200 })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  description?: string;

  @ApiPropertyOptional({ type: [ManualJournalLineDto] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(MAX_DRAFT_LINES)
  @ValidateNested({ each: true })
  @Type(() => ManualJournalLineDto)
  lines?: ManualJournalLineDto[];
}
