import { ApiProperty } from '@nestjs/swagger';
import { ImportExpenseAllocationMethod } from '@prisma/client';

class ImportExpenseAllocationBatchActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

class ImportExpenseAllocationLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  importShipmentLineId!: string;

  @ApiProperty()
  amount!: string;
}

export class ImportExpenseAllocationBatchResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  importExpenseId!: string;

  @ApiProperty({ enum: ImportExpenseAllocationMethod })
  method!: ImportExpenseAllocationMethod;

  @ApiProperty()
  requestedAmount!: string;

  @ApiProperty({ type: ImportExpenseAllocationBatchActorDto })
  createdBy!: ImportExpenseAllocationBatchActorDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ type: [ImportExpenseAllocationLineResponseDto] })
  allocations!: ImportExpenseAllocationLineResponseDto[];
}

class ImportExpenseAllocationPreviewLineDto {
  @ApiProperty({ format: 'uuid' })
  importShipmentLineId!: string;

  @ApiProperty()
  amount!: string;
}

export class ImportExpenseAllocationPreviewResponseDto {
  @ApiProperty({ enum: ImportExpenseAllocationMethod })
  method!: ImportExpenseAllocationMethod;

  @ApiProperty()
  requestedAmount!: string;

  @ApiProperty({ type: [ImportExpenseAllocationPreviewLineDto] })
  lines!: ImportExpenseAllocationPreviewLineDto[];
}
