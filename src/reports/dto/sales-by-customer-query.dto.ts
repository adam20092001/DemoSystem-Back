import { ApiPropertyOptional } from '@nestjs/swagger';
import { CustomerType } from '@prisma/client';
import { IsEnum, IsOptional, IsUUID } from 'class-validator';
import { ReportDateRangeQueryDto } from './report-date-range-query.dto';

/** R3 — Ventas por cliente. Siempre ACTIVE-only (sin parámetro status); Público general incluido como un grupo normal. */
export class SalesByCustomerQueryDto extends ReportDateRangeQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  customerId?: string;

  @ApiPropertyOptional({
    enum: CustomerType,
    description: 'Filtra por Customer.customerType ACTUAL.',
  })
  @IsOptional()
  @IsEnum(CustomerType)
  customerType?: CustomerType;
}
