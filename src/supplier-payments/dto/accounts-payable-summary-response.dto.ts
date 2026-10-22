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
export class AccountsPayableSummaryResponseDto {
  @ApiProperty({ type: [AccountsPayableSupplierSummaryResponseDto] })
  bySupplier!: AccountsPayableSupplierSummaryResponseDto[];

  @ApiProperty({ type: AccountsPayableSummaryTotalsResponseDto })
  grandTotal!: AccountsPayableSummaryTotalsResponseDto;
}
