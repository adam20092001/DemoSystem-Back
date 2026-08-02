import { ApiProperty } from '@nestjs/swagger';

export class ProductStockResponseDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '1.000',
  })
  stockCurrent!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '0.000',
  })
  stockMinimum!: string;

  @ApiProperty()
  unitAbbreviation!: string;

  @ApiProperty()
  allowDecimal!: boolean;
}
