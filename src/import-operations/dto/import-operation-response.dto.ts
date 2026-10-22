import { ApiProperty } from '@nestjs/swagger';
import { ImportOperationStatus } from '@prisma/client';

class ImportOperationActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

/**
 * Documenta exactamente los campos de SafeImportOperation. Es
 * documentación de contrato/Swagger, no una segunda fuente de mapeo:
 * IMPORT_OPERATION_SAFE_SELECT + toSafeImportOperation() siguen siendo la
 * única frontera real.
 */
export class ImportOperationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  reference!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ example: 'CN' })
  originCountry!: string;

  @ApiProperty({ example: 'PE' })
  destinationCountry!: string;

  @ApiProperty({ enum: ImportOperationStatus })
  status!: ImportOperationStatus;

  @ApiProperty({ nullable: true, type: String })
  externalReference!: string | null;

  @ApiProperty({ nullable: true, type: String })
  notes!: string | null;

  @ApiProperty({ type: ImportOperationActorDto })
  createdBy!: ImportOperationActorDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ nullable: true, type: Date })
  completedAt!: Date | null;

  @ApiProperty({ nullable: true, type: ImportOperationActorDto })
  completedBy!: ImportOperationActorDto | null;

  @ApiProperty({ nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ nullable: true, type: ImportOperationActorDto })
  cancelledBy!: ImportOperationActorDto | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty()
  shipmentCount!: number;
}

export class PaginatedImportOperationsResponseDto {
  @ApiProperty({ type: [ImportOperationResponseDto] })
  data!: ImportOperationResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
