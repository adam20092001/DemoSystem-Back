import { ApiProperty } from '@nestjs/swagger';
import { QuoteStatus } from '@prisma/client';

export class DashboardPeriodResponseDto {
  @ApiProperty({ type: String, example: '2026-08-01' })
  from!: string;

  @ApiProperty({ type: String, example: '2026-08-23' })
  to!: string;
}

export class DashboardSalesSectionResponseDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: String, example: '12500.00' })
  total!: string;
}

export class DashboardCollectionsSectionResponseDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: String, example: '9800.00' })
  total!: string;
}

export class DashboardLowStockItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  productName!: string;

  @ApiProperty({ type: String, example: '2.000' })
  stockCurrent!: string;

  @ApiProperty({ type: String, example: '5.000' })
  stockMinimum!: string;

  @ApiProperty({ type: String, example: '3.000' })
  difference!: string;
}

export class DashboardLowStockSectionResponseDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: [DashboardLowStockItemResponseDto] })
  items!: DashboardLowStockItemResponseDto[];
}

export class DashboardQuoteStatusCountResponseDto {
  @ApiProperty({ enum: QuoteStatus })
  status!: QuoteStatus;

  @ApiProperty()
  count!: number;
}

export class DashboardQuotesSectionResponseDto {
  @ApiProperty()
  total!: number;

  @ApiProperty({ type: [DashboardQuoteStatusCountResponseDto] })
  byStatus!: DashboardQuoteStatusCountResponseDto[];
}

export class DashboardReceivableItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  saleId!: string;

  @ApiProperty()
  saleNumber!: string;

  @ApiProperty({ format: 'uuid' })
  customerId!: string;

  @ApiProperty()
  customerName!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  confirmedAt!: Date;

  @ApiProperty({ type: String, example: '500.00' })
  total!: string;

  @ApiProperty({ type: String, example: '200.00' })
  paidAmount!: string;

  @ApiProperty({ type: String, example: '300.00' })
  balanceDue!: string;

  @ApiProperty()
  daysOutstanding!: number;
}

export class DashboardReceivablesSectionResponseDto {
  @ApiProperty()
  count!: number;

  @ApiProperty({ type: String, example: '3400.00' })
  totalBalance!: string;

  @ApiProperty({ type: [DashboardReceivableItemResponseDto] })
  oldest!: DashboardReceivableItemResponseDto[];
}

/**
 * Respuesta compuesta única de GET /dashboard. Cada sección es `nullable`:
 * `null` cuando el rol solicitante no tiene visibilidad sobre ella (ver
 * matriz de roles en la descripción del endpoint) — ADMIN/MANAGEMENT ven
 * las 5, SELLER no ve lowStock, WAREHOUSE solo ve lowStock.
 */
export class DashboardResponseDto {
  @ApiProperty({ type: DashboardPeriodResponseDto })
  period!: DashboardPeriodResponseDto;

  @ApiProperty({ type: DashboardSalesSectionResponseDto, nullable: true })
  sales!: DashboardSalesSectionResponseDto | null;

  @ApiProperty({ type: DashboardCollectionsSectionResponseDto, nullable: true })
  collections!: DashboardCollectionsSectionResponseDto | null;

  @ApiProperty({ type: DashboardLowStockSectionResponseDto, nullable: true })
  lowStock!: DashboardLowStockSectionResponseDto | null;

  @ApiProperty({ type: DashboardQuotesSectionResponseDto, nullable: true })
  quotes!: DashboardQuotesSectionResponseDto | null;

  @ApiProperty({ type: DashboardReceivablesSectionResponseDto, nullable: true })
  receivables!: DashboardReceivablesSectionResponseDto | null;
}
