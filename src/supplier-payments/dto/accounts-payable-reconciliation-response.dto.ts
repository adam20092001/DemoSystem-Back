import { ApiProperty } from '@nestjs/swagger';

const INVOICE_DISCREPANCY_CODES = [
  'MISSING_ORIGINAL_ENTRY',
  'INVALID_CREDIT_LINE_COUNT',
  'CREDIT_AMOUNT_MISMATCH',
] as const;

const ACCOUNT_DISCREPANCY_CODES = ['ACCOUNT_BALANCE_MISMATCH'] as const;

export class ApInvoiceReconciliationRowResponseDto {
  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceId!: string;

  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty({ type: String })
  originalAmount!: string;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  postedEntryId!: string | null;

  @ApiProperty({ format: 'uuid', nullable: true, type: String })
  historicalLiabilityAccountId!: string | null;

  @ApiProperty({ type: String, nullable: true })
  creditedAmount!: string | null;

  @ApiProperty({ type: String })
  operationalPaidAmount!: string;

  @ApiProperty({ type: String })
  operationalPendingBalance!: string;

  @ApiProperty({ enum: INVOICE_DISCREPANCY_CODES, isArray: true })
  discrepancies!: (typeof INVOICE_DISCREPANCY_CODES)[number][];
}

export class ApAccountReconciliationRowResponseDto {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty()
  accountCode!: string;

  @ApiProperty()
  accountName!: string;

  @ApiProperty({ type: String })
  operationalPaidAmount!: string;

  @ApiProperty({ type: String })
  accountingNetDebitAmount!: string;

  @ApiProperty({ type: String })
  difference!: string;

  @ApiProperty({ enum: ACCOUNT_DISCREPANCY_CODES, isArray: true })
  discrepancies!: (typeof ACCOUNT_DISCREPANCY_CODES)[number][];
}

/** Conciliación de SOLO LECTURA de cuentas por pagar (Fase A5.4): nunca crea asientos correctivos ni modifica saldos. */
export class ApReconciliationReportResponseDto {
  @ApiProperty({ type: String, format: 'date-time' })
  generatedAt!: string;

  @ApiProperty({ type: [ApInvoiceReconciliationRowResponseDto] })
  invoices!: ApInvoiceReconciliationRowResponseDto[];

  @ApiProperty({ type: [ApAccountReconciliationRowResponseDto] })
  accounts!: ApAccountReconciliationRowResponseDto[];

  @ApiProperty()
  overallConsistent!: boolean;

  @ApiProperty({ type: [String] })
  limitations!: string[];
}
