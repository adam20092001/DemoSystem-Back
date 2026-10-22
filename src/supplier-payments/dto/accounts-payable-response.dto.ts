import { ApiProperty } from '@nestjs/swagger';
import { PurchaseInvoiceDocumentType } from '@prisma/client';
import { AGING_BUCKET_ORDER } from '../accounts-payable-calculator';

/**
 * Fila segura de cuentas por pagar: una PurchaseInvoice CONFIRMED.
 * paidAmount/balanceDue/status/agingBucket/daysOverdue se calculan
 * SIEMPRE en tiempo de lectura (A5.3/A5.4) — nunca una columna duplicada.
 */
export class AccountsPayableItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  purchaseInvoiceId!: string;

  @ApiProperty({ format: 'uuid' })
  supplierId!: string;

  @ApiProperty()
  supplierLegalName!: string;

  @ApiProperty()
  supplierDocumentNumber!: string;

  @ApiProperty({ enum: PurchaseInvoiceDocumentType })
  documentType!: PurchaseInvoiceDocumentType;

  @ApiProperty({ type: String, nullable: true })
  documentSeries!: string | null;

  @ApiProperty()
  documentNumber!: string;

  @ApiProperty({ type: String, example: '2026-10-15' })
  issueDate!: string;

  @ApiProperty({ type: String, nullable: true, example: '2026-11-15' })
  dueDate!: string | null;

  @ApiProperty({ type: String, example: 'PEN' })
  currencyCode!: string;

  @ApiProperty({ type: String })
  originalAmount!: string;

  @ApiProperty({ type: String })
  paidAmount!: string;

  @ApiProperty({ type: String })
  balanceDue!: string;

  @ApiProperty({ enum: ['UNPAID', 'PARTIALLY_PAID', 'PAID'] })
  status!: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';

  @ApiProperty({ enum: AGING_BUCKET_ORDER })
  agingBucket!: (typeof AGING_BUCKET_ORDER)[number];

  @ApiProperty({ type: Number, nullable: true })
  daysOverdue!: number | null;
}

export class AccountsPayablePaymentHistoryItemResponseDto {
  @ApiProperty({ format: 'uuid' })
  supplierPaymentId!: string;

  @ApiProperty({ enum: ['ACTIVE', 'CANCELLED'] })
  status!: 'ACTIVE' | 'CANCELLED';

  @ApiProperty({ type: String, example: '2026-10-21' })
  paymentDate!: string;

  @ApiProperty({ type: String })
  amountApplied!: string;

  @ApiProperty({ type: String, example: 'CASH' })
  paymentMethodCode!: string;

  @ApiProperty({ type: String, nullable: true })
  reference!: string | null;
}

export class AccountsPayableDetailResponseDto extends AccountsPayableItemResponseDto {
  @ApiProperty({ type: [AccountsPayablePaymentHistoryItemResponseDto] })
  payments!: AccountsPayablePaymentHistoryItemResponseDto[];
}

/** Respuesta paginada de cuentas por pagar, deuda más antigua primero. */
export class PaginatedAccountsPayableResponseDto {
  @ApiProperty({ type: [AccountsPayableItemResponseDto] })
  data!: AccountsPayableItemResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
