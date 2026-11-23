import { ApiProperty } from '@nestjs/swagger';
import {
  MovementCreatedByResponseDto,
  MovementLocationResponseDto,
  MovementProductSummaryResponseDto,
} from '../../dto/movement-response.dto';

export class StockTransferResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: MovementProductSummaryResponseDto })
  product!: MovementProductSummaryResponseDto;

  @ApiProperty({ type: MovementLocationResponseDto })
  sourceLocation!: MovementLocationResponseDto;

  @ApiProperty({ type: MovementLocationResponseDto })
  destinationLocation!: MovementLocationResponseDto;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '10.000',
  })
  quantity!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ type: String, nullable: true })
  idempotencyKey!: string | null;

  @ApiProperty({ type: MovementCreatedByResponseDto })
  createdBy!: MovementCreatedByResponseDto;

  @ApiProperty({
    format: 'uuid',
    description:
      'Movimiento EXIT del origen (visible en el kardex con transferId).',
  })
  exitMovementId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Movimiento ENTRY del destino (visible en el kardex con transferId).',
  })
  entryMovementId!: string;

  @ApiProperty()
  createdAt!: Date;
}

export class PaginatedStockTransfersResponseDto {
  @ApiProperty({ type: [StockTransferResponseDto] })
  data!: StockTransferResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
