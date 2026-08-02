import { ApiProperty } from '@nestjs/swagger';

export class LowStockCategorySummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;
}

export class LowStockUnitSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  abbreviation!: string;
}

export class LowStockItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '2.500',
  })
  stockCurrent!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '5.000',
  })
  stockMinimum!: string;

  @ApiProperty({ type: LowStockCategorySummaryResponseDto })
  category!: LowStockCategorySummaryResponseDto;

  @ApiProperty({ type: LowStockUnitSummaryResponseDto })
  unit!: LowStockUnitSummaryResponseDto;
}

export class PaginatedLowStockResponseDto {
  @ApiProperty({ type: [LowStockItemResponseDto] })
  data!: LowStockItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
