import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import {
  IsInt,
  IsNotEmpty,
  IsUUID,
  IsOptional,
  Max,
  Min,
} from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';

export class LedgerReportQueryDto {
  @ApiProperty({ format: 'uuid' })
  @IsNotEmpty()
  @IsUUID()
  accountId!: string;

  @ApiProperty({
    type: String,
    example: '2026-03-01',
    description: 'Fecha contable (America/Lima), límite inferior inclusivo.',
  })
  @IsNotEmpty()
  @IsDateOnly()
  accountingDateFrom!: string;

  @ApiProperty({
    type: String,
    example: '2026-03-31',
    description: 'Fecha contable (America/Lima), límite superior inclusivo.',
  })
  @IsNotEmpty()
  @IsDateOnly()
  accountingDateTo!: string;

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
}
