import { ApiProperty } from '@nestjs/swagger';
import { ImportReceiptLinkStatus } from '@prisma/client';

class ImportReceiptLinkActorDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

export class ImportReceiptLinkResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  importShipmentLineId!: string;

  @ApiProperty({ format: 'uuid' })
  purchaseReceiptLineId!: string;

  @ApiProperty()
  linkedQuantity!: string;

  @ApiProperty({ enum: ImportReceiptLinkStatus })
  status!: ImportReceiptLinkStatus;

  @ApiProperty({ type: ImportReceiptLinkActorDto })
  createdBy!: ImportReceiptLinkActorDto;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty({ nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ nullable: true, type: ImportReceiptLinkActorDto })
  cancelledBy!: ImportReceiptLinkActorDto | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;
}

export class ShipmentLineReceptionSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  importShipmentLineId!: string;

  @ApiProperty()
  shippedQuantity!: string;

  @ApiProperty()
  linkedReceivedQuantity!: string;

  @ApiProperty()
  remainingQuantity!: string;

  @ApiProperty({ enum: ['PENDING', 'PARTIALLY_RECEIVED', 'FULLY_RECEIVED'] })
  receptionStatus!: string;

  @ApiProperty({ type: [ImportReceiptLinkResponseDto] })
  links!: ImportReceiptLinkResponseDto[];
}

class CostAttributionPreviewLineDto {
  @ApiProperty({ format: 'uuid' })
  purchaseReceiptLineId!: string;

  @ApiProperty({ format: 'uuid' })
  importReceiptLinkId!: string;

  @ApiProperty()
  receivedQuantity!: string;

  @ApiProperty()
  attributedAmount!: string;
}

export class CostAttributionPreviewResponseDto {
  @ApiProperty({ format: 'uuid' })
  importExpenseAllocationId!: string;

  @ApiProperty({ format: 'uuid' })
  importShipmentLineId!: string;

  @ApiProperty({ example: 'USD' })
  currencyCode!: string;

  @ApiProperty()
  allocatedAmount!: string;

  @ApiProperty({ type: [CostAttributionPreviewLineDto] })
  lines!: CostAttributionPreviewLineDto[];

  @ApiProperty({
    description:
      'Porción de allocatedAmount correspondiente a la cantidad embarcada todavía SIN vínculo de recepción ACTIVO.',
  })
  unattributedAmount!: string;

  @ApiProperty({ enum: ['PENDING_FX', 'PENDING_ACCOUNTING_POLICY'] })
  financialStatus!: string;

  @ApiProperty()
  financialStatusReason!: string;
}
