import { ApiProperty } from '@nestjs/swagger';
import { AGING_BUCKET_ORDER } from '../accounts-payable-calculator';

export class AgingBucketAmountResponseDto {
  @ApiProperty({ enum: AGING_BUCKET_ORDER })
  bucket!: (typeof AGING_BUCKET_ORDER)[number];

  @ApiProperty()
  invoiceCount!: number;

  @ApiProperty({ type: String })
  amount!: string;

  @ApiProperty({
    type: String,
    description:
      'Porcentaje de este bucket sobre el saldo pendiente total del mismo nivel (proveedor o general).',
  })
  percentage!: string;
}

export class AgingBySupplierResponseDto {
  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty()
  supplierLegalName!: string;

  @ApiProperty()
  supplierDocumentNumber!: string;

  @ApiProperty({ type: String })
  totalPending!: string;

  @ApiProperty({ type: [AgingBucketAmountResponseDto] })
  buckets!: AgingBucketAmountResponseDto[];
}

/**
 * Antigüedad de deuda (Fase A5.4) sobre el saldo VIGENTE a `asOfDate` —
 * nunca un saldo histórico reconstruido a una fecha de corte pasada (ver
 * `limitations`).
 */
export class AgingTotalsResponseDto {
  @ApiProperty({ type: String })
  totalPending!: string;

  @ApiProperty({ type: [AgingBucketAmountResponseDto] })
  buckets!: AgingBucketAmountResponseDto[];
}

export class AgingCurrencyTotalResponseDto {
  @ApiProperty({ type: String, example: 'USD' })
  currencyCode!: string;

  @ApiProperty()
  invoiceCount!: number;

  @ApiProperty({
    type: String,
    description: 'Saldo pendiente en la moneda del documento.',
  })
  totalPending!: string;

  @ApiProperty({
    type: String,
    description: 'Saldo pendiente en libros (moneda de la empresa).',
  })
  baseTotalPending!: string;
}

export class AgingReportResponseDto {
  @ApiProperty({ type: String, example: '2026-10-22' })
  asOfDate!: string;

  @ApiProperty({
    type: String,
    nullable: true,
    example: 'PEN',
    description:
      'Moneda de la EMPRESA: totals y bySupplier están expresados en ella.',
  })
  baseCurrencyCode!: string | null;

  @ApiProperty({ type: [AgingCurrencyTotalResponseDto] })
  byCurrency!: AgingCurrencyTotalResponseDto[];

  @ApiProperty({ type: AgingTotalsResponseDto })
  totals!: AgingTotalsResponseDto;

  @ApiProperty({ type: [AgingBySupplierResponseDto] })
  bySupplier!: AgingBySupplierResponseDto[];

  @ApiProperty({ type: [String] })
  limitations!: string[];
}
