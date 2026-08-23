import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsUUID } from 'class-validator';
import { ReportDateRangeQueryDto } from './report-date-range-query.dto';

/** R2 — Ventas por producto. Filtra contra Sale.confirmedAt (ACTIVE únicamente) y la dimensión CURRENT de Product/Category. */
export class SalesByProductQueryDto extends ReportDateRangeQueryDto {
  @ApiPropertyOptional({
    format: 'uuid',
    description:
      'Filtra por Product.categoryId ACTUAL (no por la categoría histórica del snapshot de SaleItem).',
  })
  @IsOptional()
  @IsUUID()
  categoryId?: string;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  productId?: string;
}
