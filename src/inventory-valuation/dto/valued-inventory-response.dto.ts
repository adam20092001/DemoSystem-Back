import { ApiProperty } from '@nestjs/swagger';
import { InventoryValuationMethod } from '@prisma/client';

export class ValuedInventoryItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ enum: InventoryValuationMethod })
  method!: InventoryValuationMethod;

  @ApiProperty({
    type: String,
    description:
      'Referencia informativa (Product.stockCurrent) — nunca la misma fuente de verdad que valuedQuantity; pueden diferir.',
  })
  physicalStockCurrent!: string;

  @ApiProperty({
    type: String,
    description:
      'Suma de cantidad capitalizada por recepciones (ORIGINAL − REVERSAL). Fase A6.1 todavía NO resta nada al vender (COGS/consumo por venta es A6.2, no implementada): si el producto tuvo salidas por venta, esta cantidad puede ser MAYOR que lo físicamente disponible — nunca interpretar como "lo que queda en almacén".',
  })
  valuedQuantity!: string;

  @ApiProperty({ type: String })
  weightedAverageUnitCost!: string;

  @ApiProperty({
    type: String,
    description:
      'Valor acumulado capitalizado por recepciones, NUNCA el valor contable completo/vigente del stock: no neteado por ventas (A6.2, no implementada). Con ventas ya ocurridas, sobrestima el valor de lo que realmente queda en almacén — usar únicamente como insumo de trazabilidad de costo de compra, nunca como saldo financiero de inventario.',
  })
  totalValue!: string;
}

export class PaginatedValuedInventoryResponseDto {
  @ApiProperty({ type: [ValuedInventoryItemResponseDto] })
  data!: ValuedInventoryItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class PendingValuationItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  inventoryMovementId!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  purchaseReceiptId!: string | null;

  @ApiProperty({ type: String })
  quantity!: string;

  @ApiProperty()
  createdAt!: Date;
}

export class PaginatedPendingValuationResponseDto {
  @ApiProperty({ type: [PendingValuationItemResponseDto] })
  data!: PendingValuationItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
