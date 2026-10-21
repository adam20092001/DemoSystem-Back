import { ApiProperty } from '@nestjs/swagger';
import { PurchaseReceiptStatus } from '@prisma/client';

/**
 * Documenta exactamente los campos de SafePurchaseReceiptLine. Nunca
 * incluye costo/monto de factura (CLAUDE.md A5.2b §6) — solo cantidad
 * física y, si aplica, el monto de reclasificación contable (nunca un
 * costo de producto).
 */
export class PurchaseReceiptLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceLineId!: string;

  @ApiProperty({ type: String })
  quantity!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Monto exactamente reclasificado contablemente para esta línea; null cuando no disparó reclasificación (el caso predeterminado y seguro mientras no exista una decisión del contador).',
  })
  reclassifiedAmount!: string | null;
}

export class PurchaseReceiptResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceId!: string;

  @ApiProperty({ type: String })
  receivedDate!: string;

  @ApiProperty({ enum: PurchaseReceiptStatus })
  status!: PurchaseReceiptStatus;

  @ApiProperty({ type: String, nullable: true })
  idempotencyKey!: string | null;

  @ApiProperty({ type: String, nullable: true })
  notes!: string | null;

  @ApiProperty({ format: 'uuid' })
  createdByUserId!: string;

  @ApiProperty({ nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  cancelledByUserId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  reclassificationEntryId!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ type: [PurchaseReceiptLineResponseDto] })
  lines!: PurchaseReceiptLineResponseDto[];
}

export class PurchaseInvoiceLineReceiptSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceLineId!: string;

  @ApiProperty({ type: String })
  invoicedQuantity!: string;

  @ApiProperty({ type: String })
  receivedQuantity!: string;

  @ApiProperty({ type: String })
  pendingQuantity!: string;

  @ApiProperty({ enum: ['PENDING', 'PARTIAL', 'COMPLETE'] })
  status!: 'PENDING' | 'PARTIAL' | 'COMPLETE';
}

export class PurchaseInvoiceReceiptsSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceId!: string;

  @ApiProperty({ type: [PurchaseReceiptResponseDto] })
  receipts!: PurchaseReceiptResponseDto[];

  @ApiProperty({ type: [PurchaseInvoiceLineReceiptSummaryResponseDto] })
  lines!: PurchaseInvoiceLineReceiptSummaryResponseDto[];
}
