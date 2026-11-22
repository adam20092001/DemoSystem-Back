import { ApiProperty } from '@nestjs/swagger';
import { MovementLocationResponseDto } from './movement-response.dto';

export class StockByLocationRowResponseDto {
  @ApiProperty({ type: MovementLocationResponseDto })
  location!: MovementLocationResponseDto;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string. Siempre > 0.',
    example: '4.000',
  })
  quantity!: string;
}

export class ProductStockByLocationResponseDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({
    type: String,
    description:
      'Consolidado (Product.stockCurrent), 3 decimales fijos. Igual a la suma de locations[].quantity.',
    example: '10.000',
  })
  stockCurrent!: string;

  @ApiProperty()
  unitAbbreviation!: string;

  @ApiProperty()
  allowDecimal!: boolean;

  @ApiProperty({
    type: [StockByLocationRowResponseDto],
    description:
      'Solo ubicaciones con existencias (> 0), ordenadas por código de almacén y de ubicación. Las ubicaciones sin existencias se omiten.',
  })
  locations!: StockByLocationRowResponseDto[];
}
