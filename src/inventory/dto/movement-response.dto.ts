import { ApiProperty } from '@nestjs/swagger';
import { InventoryMovementOrigin, InventoryMovementType } from '@prisma/client';

/** Nunca passwordHash/roleId/failedLoginAttempts/referenceType/referenceId. */
export class MovementProductSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  sku!: string;

  @ApiProperty()
  name!: string;
}

export class MovementCreatedByResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

export class MovementResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: MovementProductSummaryResponseDto })
  product!: MovementProductSummaryResponseDto;

  @ApiProperty({ enum: InventoryMovementType })
  movementType!: InventoryMovementType;

  @ApiProperty({ enum: InventoryMovementOrigin })
  origin!: InventoryMovementOrigin;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '2.500',
  })
  quantity!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '1.000',
  })
  previousStock!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 3 decimales fijos, como string.',
    example: '0.000',
  })
  newStock!: string;

  @ApiProperty()
  reason!: string;

  @ApiProperty({ nullable: true, type: String })
  notes!: string | null;

  @ApiProperty({ type: MovementCreatedByResponseDto })
  createdBy!: MovementCreatedByResponseDto;

  @ApiProperty()
  createdAt!: Date;
}

export class PaginatedMovementsResponseDto {
  @ApiProperty({ type: [MovementResponseDto] })
  data!: MovementResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
