import { ApiPropertyOptional } from '@nestjs/swagger';
import { ManualJournalDraftStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import { IsEnum, IsInt, IsOptional, Max, Min } from 'class-validator';

export class ListManualJournalDraftsQueryDto {
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

  @ApiPropertyOptional({ enum: ManualJournalDraftStatus })
  @IsOptional()
  @IsEnum(ManualJournalDraftStatus)
  status?: ManualJournalDraftStatus;
}
