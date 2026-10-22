import { ApiProperty } from '@nestjs/swagger';
import { ImportShipmentStatus, ImportTransportMode } from '@prisma/client';

class ImportShipmentActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

class ImportShipmentLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ nullable: true, type: String })
  productId!: string | null;

  @ApiProperty()
  descriptionSnapshot!: string;

  @ApiProperty()
  plannedQuantity!: string;

  @ApiProperty({ nullable: true, type: String })
  unitCode!: string | null;

  @ApiProperty({ nullable: true, type: String })
  unitName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  weightValue!: string | null;

  @ApiProperty({ nullable: true, type: String })
  weightUnit!: string | null;

  @ApiProperty({ nullable: true, type: String })
  volumeValue!: string | null;

  @ApiProperty({ nullable: true, type: String })
  volumeUnit!: string | null;

  @ApiProperty({ nullable: true, type: String })
  purchaseInvoiceLineId!: string | null;
}

/**
 * Documenta exactamente los campos de SafeImportShipment. Es
 * documentación de contrato/Swagger, no una segunda fuente de mapeo:
 * IMPORT_SHIPMENT_SAFE_SELECT + toSafeImportShipment() siguen siendo la
 * única frontera real.
 */
export class ImportShipmentResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  importOperationId!: string;

  @ApiProperty({ enum: ImportTransportMode })
  transportMode!: ImportTransportMode;

  @ApiProperty({ nullable: true, type: String })
  carrierName!: string | null;

  @ApiProperty({ nullable: true, type: String })
  trackingReference!: string | null;

  @ApiProperty({ nullable: true, type: String })
  billOfLadingNumber!: string | null;

  @ApiProperty({ nullable: true, type: String })
  containerReference!: string | null;

  @ApiProperty({ nullable: true, type: String })
  originLocation!: string | null;

  @ApiProperty({ nullable: true, type: String })
  destinationLocation!: string | null;

  @ApiProperty({ nullable: true, type: String })
  estimatedDepartureDate!: string | null;

  @ApiProperty({ nullable: true, type: String })
  actualDepartureDate!: string | null;

  @ApiProperty({ nullable: true, type: String })
  estimatedArrivalDate!: string | null;

  @ApiProperty({ nullable: true, type: String })
  actualArrivalDate!: string | null;

  @ApiProperty({ enum: ImportShipmentStatus })
  status!: ImportShipmentStatus;

  @ApiProperty({ nullable: true, type: String })
  notes!: string | null;

  @ApiProperty({ type: ImportShipmentActorDto })
  createdBy!: ImportShipmentActorDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ nullable: true, type: ImportShipmentActorDto })
  cancelledBy!: ImportShipmentActorDto | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty({ type: [ImportShipmentLineResponseDto] })
  lines!: ImportShipmentLineResponseDto[];
}

export class PaginatedImportShipmentsResponseDto {
  @ApiProperty({ type: [ImportShipmentResponseDto] })
  data!: ImportShipmentResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
