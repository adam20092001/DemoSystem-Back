import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { ReportDateRangeQueryDto } from './report-date-range-query.dto';

/**
 * R4 — Ventas por vendedor. `from`/`to` acotan el cohorte de Sale
 * (Sale.confirmedAt) y, de forma independiente, el rango de Quote.issueDate
 * para convertedQuotes — nunca Payment.paidAt (ver ReportsService).
 */
export class SalesBySellerQueryDto extends ReportDateRangeQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  sellerId?: string;
}
