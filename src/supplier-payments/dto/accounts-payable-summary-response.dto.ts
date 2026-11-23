import { ApiProperty } from '@nestjs/swagger';

export class AccountsPayableSupplierSummaryResponseDto {
  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty()
  supplierLegalName!: string;

  @ApiProperty()
  supplierDocumentNumber!: string;

  @ApiProperty()
  invoiceCount!: number;

  @ApiProperty({ type: String })
  totalOriginal!: string;

  @ApiProperty({ type: String })
  totalPaid!: string;

  @ApiProperty({ type: String })
  totalPending!: string;
}

export class AccountsPayableSummaryTotalsResponseDto {
  @ApiProperty()
  invoiceCount!: number;

  @ApiProperty({ type: String })
  totalOriginal!: string;

  @ApiProperty({ type: String })
  totalPaid!: string;

  @ApiProperty({ type: String })
  totalPending!: string;
}

/** Resumen de cuentas por pagar agrupado por proveedor + total general (Fase A5.4). */
export class AccountsPayableCurrencySummaryResponseDto {
  @ApiProperty({ type: String, example: 'USD' })
  currencyCode!: string;

  @ApiProperty()
  invoiceCount!: number;

  @ApiProperty({ type: String })
  totalOriginal!: string;

  @ApiProperty({ type: String })
  totalPaid!: string;

  @ApiProperty({ type: String })
  totalPending!: string;

  @ApiProperty({ type: String, description: 'Saldo en libros (moneda de la empresa) de las facturas de esta moneda.' })
  baseTotalPending!: string;
}

export class AccountsPayableSummaryResponseDto {
  @ApiProperty({ type: String, nullable: true, example: 'PEN', description: 'Moneda de la EMPRESA: bySupplier y grandTotal están expresados en ella (valor contable).' })
  baseCurrencyCode!: string | null;

  @ApiProperty({ type: [AccountsPayableCurrencySummaryResponseDto], description: 'Deuda en la moneda original de cada documento (nunca suma monedas distintas).' })
  byCurrency!: AccountsPayableCurrencySummaryResponseDto[];

  @ApiProperty({ type: [AccountsPayableSupplierSummaryResponseDto] })
  bySupplier!: AccountsPayableSupplierSummaryResponseDto[];

  @ApiProperty({ type: AccountsPayableSummaryTotalsResponseDto })
  grandTotal!: AccountsPayableSummaryTotalsResponseDto;
}
