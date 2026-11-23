import { ApiProperty } from '@nestjs/swagger';
import {
  PurchaseAcquisitionKind,
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
  PurchaseLineTaxBasis,
  PurchaseLineTaxCategory,
  PurchasePurpose,
} from '@prisma/client';

/**
 * Documenta exactamente los campos de SafePurchaseInvoiceLine. Es
 * documentación de contrato/Swagger, no una segunda fuente de mapeo:
 * PURCHASE_INVOICE_SAFE_SELECT + toSafePurchaseInvoice() siguen siendo la
 * única frontera real contra fuga de datos.
 */
export class PurchaseInvoiceLineResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  productId!: string | null;

  @ApiProperty()
  descriptionSnapshot!: string;

  @ApiProperty({ nullable: true, type: String })
  unitCodeSnapshot!: string | null;

  @ApiProperty({ nullable: true, type: String })
  unitNameSnapshot!: string | null;

  @ApiProperty({ enum: PurchaseAcquisitionKind })
  acquisitionKind!: PurchaseAcquisitionKind;

  @ApiProperty({ enum: PurchasePurpose })
  purchasePurpose!: PurchasePurpose;

  @ApiProperty({ type: String })
  quantity!: string;

  @ApiProperty({
    type: String,
    description: 'Costo unitario en la MONEDA DEL DOCUMENTO (6 decimales).',
  })
  unitCost!: string;

  @ApiProperty({
    type: String,
    description: 'Costo unitario en la moneda de la EMPRESA (informativo).',
  })
  baseUnitCost!: string;

  @ApiProperty({ enum: PurchaseLineTaxCategory })
  taxCategory!: PurchaseLineTaxCategory;

  @ApiProperty({ enum: PurchaseLineTaxBasis, nullable: true })
  taxBasis!: PurchaseLineTaxBasis | null;

  @ApiProperty({ type: String, nullable: true })
  taxRateSnapshot!: string | null;

  @ApiProperty({ type: String })
  taxableBaseAmount!: string;

  @ApiProperty({ type: String })
  taxAmount!: string;

  @ApiProperty({
    type: String,
    description:
      'Nunca inferido de taxCategory: cuánto del impuesto de esta línea se reconoce como crédito fiscal.',
  })
  creditableTaxAmount!: string;

  @ApiProperty({ type: String })
  lineTotal!: string;

  @ApiProperty({ type: String, description: 'taxableBaseAmount en la moneda de la EMPRESA.' })
  baseTaxableBaseAmount!: string;

  @ApiProperty({ type: String, description: 'taxAmount en la moneda de la EMPRESA.' })
  baseTaxAmount!: string;

  @ApiProperty({ type: String, description: 'creditableTaxAmount en la moneda de la EMPRESA.' })
  baseCreditableTaxAmount!: string;

  @ApiProperty({ type: String, description: 'lineTotal en la moneda de la EMPRESA.' })
  baseLineTotal!: string;

  @ApiProperty({
    nullable: true,
    type: Boolean,
    description:
      'null mientras DRAFT (todavía no se congela nada); se calcula EXACTAMENTE UNA VEZ al confirmar, a partir de Product.isInventoryTracked vigente en ese instante — nunca se vuelve a leer después.',
  })
  isReceiptEligible!: boolean | null;
}

export class PurchaseInvoiceResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty({ enum: PurchaseInvoiceDocumentType })
  documentType!: PurchaseInvoiceDocumentType;

  @ApiProperty({ nullable: true, type: String })
  documentSeries!: string | null;

  @ApiProperty()
  documentNumber!: string;

  @ApiProperty({ type: String })
  issueDate!: string;

  @ApiProperty({ type: String })
  registrationDate!: string;

  @ApiProperty({
    type: String,
    description:
      'Fecha contable EXPLÍCITA (nunca derivada de un instante, mismo criterio que los asientos manuales de A4).',
  })
  accountingDate!: string;

  @ApiProperty({ type: String, nullable: true })
  dueDate!: string | null;

  @ApiProperty({ nullable: true, type: Number })
  paymentTermsDays!: number | null;

  @ApiProperty({
    example: 'USD',
    description:
      'Moneda del DOCUMENTO: subtotal, taxAmount, totalAmount y los importes de las líneas (sin prefijo base) están en esta moneda.',
  })
  currencyCode!: string;

  @ApiProperty({
    example: 'PEN',
    description: 'Moneda de la EMPRESA (contable): en ella se contabiliza, valoriza y concilia.',
  })
  baseCurrencyCode!: string;

  @ApiProperty({
    type: String,
    example: '3.70000000',
    description:
      'Unidades de moneda de la empresa por 1 unidad de moneda del documento (1 si coinciden). Congelada al confirmar.',
  })
  exchangeRate!: string;

  @ApiProperty({ type: String, example: '2026-11-23' })
  exchangeRateDate!: string;

  @ApiProperty({ type: String, description: 'En la moneda del DOCUMENTO.' })
  subtotal!: string;

  @ApiProperty({ type: String, description: 'En la moneda del DOCUMENTO.' })
  taxAmount!: string;

  @ApiProperty({ type: String, description: 'En la moneda del DOCUMENTO.' })
  totalAmount!: string;

  @ApiProperty({ type: String, description: 'En la moneda de la EMPRESA.' })
  baseSubtotal!: string;

  @ApiProperty({ type: String, description: 'En la moneda de la EMPRESA.' })
  baseTaxAmount!: string;

  @ApiProperty({ type: String, description: 'En la moneda de la EMPRESA.' })
  baseTotalAmount!: string;

  @ApiProperty({ enum: PurchaseInvoiceStatus })
  status!: PurchaseInvoiceStatus;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  postedEntryId!: string | null;

  @ApiProperty({ format: 'uuid' })
  createdByUserId!: string;

  @ApiProperty({ nullable: true, type: Date })
  confirmedAt!: Date | null;

  @ApiProperty({ nullable: true, type: Date })
  cancelledAt!: Date | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  cancelledByUserId!: string | null;

  @ApiProperty({ nullable: true, type: String })
  cancellationReason!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;

  @ApiProperty({ type: [PurchaseInvoiceLineResponseDto] })
  lines!: PurchaseInvoiceLineResponseDto[];
}

export class PaginatedPurchaseInvoicesResponseDto {
  @ApiProperty({ type: [PurchaseInvoiceResponseDto] })
  data!: PurchaseInvoiceResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
