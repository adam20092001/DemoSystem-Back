import { ApiProperty } from '@nestjs/swagger';
import {
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
} from '@prisma/client';

export class ReceivableInvoiceSupplierResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String })
  legalName!: string;

  @ApiProperty({ type: String, nullable: true })
  tradeName!: string | null;
}

/**
 * Vista de almacén (R1): NINGÚN campo financiero. Ver ReceivableInvoice* en
 * types/receivable-invoice.ts.
 */
export class ReceivableInvoiceListItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ enum: PurchaseInvoiceDocumentType })
  documentType!: PurchaseInvoiceDocumentType;

  @ApiProperty({ type: String, nullable: true })
  documentSeries!: string | null;

  @ApiProperty({ type: String })
  documentNumber!: string;

  @ApiProperty({ type: String, example: '2026-11-20' })
  issueDate!: string;

  @ApiProperty({ type: ReceivableInvoiceSupplierResponseDto })
  supplier!: ReceivableInvoiceSupplierResponseDto;

  @ApiProperty({
    type: Number,
    description:
      'Líneas elegibles con cantidad pendiente > 0 (descontando solo recepciones ACTIVE).',
  })
  pendingLinesCount!: number;
}

export class PaginatedReceivableInvoicesResponseDto {
  @ApiProperty({ type: [ReceivableInvoiceListItemResponseDto] })
  data!: ReceivableInvoiceListItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class ReceivableInvoiceLineResponseDto {
  @ApiProperty({
    format: 'uuid',
    description:
      'Id de la línea de factura: es el `purchaseInvoiceLineId` a enviar en POST /purchase-invoices/:id/receipts.',
  })
  purchaseInvoiceLineId!: string;

  @ApiProperty({ format: 'uuid' })
  productId!: string;

  @ApiProperty({ type: String })
  productSku!: string;

  @ApiProperty({ type: String })
  productName!: string;

  @ApiProperty({ type: String, nullable: true })
  unitCode!: string | null;

  @ApiProperty({ type: String, nullable: true })
  unitName!: string | null;

  @ApiProperty({ type: String, example: '10.000' })
  invoicedQuantity!: string;

  @ApiProperty({ type: String, example: '4.000' })
  receivedQuantity!: string;

  @ApiProperty({ type: String, example: '6.000' })
  pendingQuantity!: string;

  @ApiProperty({ enum: ['PENDING', 'PARTIAL', 'COMPLETE'] })
  status!: 'PENDING' | 'PARTIAL' | 'COMPLETE';
}

export class ReceivableInvoiceDetailResponseDto extends ReceivableInvoiceListItemResponseDto {
  @ApiProperty({ enum: PurchaseInvoiceStatus, example: 'CONFIRMED' })
  status!: PurchaseInvoiceStatus;

  @ApiProperty({ type: [ReceivableInvoiceLineResponseDto] })
  lines!: ReceivableInvoiceLineResponseDto[];
}
