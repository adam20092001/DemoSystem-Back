import { ApiPropertyOptional } from '@nestjs/swagger';
import { QuoteStatus } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ReportDateRangeQueryDto } from './report-date-range-query.dto';

/** R8 — Cotizaciones por estado. Tabular, todos los estados visibles; `from`/`to` filtran Quote.issueDate (@db.Date, límites inclusivos). */
export class QuotesByStatusQueryDto extends ReportDateRangeQueryDto {
  @ApiPropertyOptional({
    enum: QuoteStatus,
    description:
      'Estado PERSISTIDO de la cotización (sin traducción EXPIRED por fecha vencida, a diferencia de /quotes).',
  })
  @IsOptional()
  @IsEnum(QuoteStatus)
  status?: QuoteStatus;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sellerId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;
}
