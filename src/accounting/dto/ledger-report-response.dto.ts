import { ApiProperty } from '@nestjs/swagger';
import {
  AccountingEventType,
  AccountStatus,
  AccountType,
} from '@prisma/client';

export class LedgerMovementRowDto {
  @ApiProperty({ format: 'uuid' })
  entryId!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-03-15' })
  accountingDate!: string;

  @ApiProperty({ format: 'uuid' })
  periodId!: string;

  @ApiProperty({ example: 7 })
  journalNumber!: number;

  @ApiProperty()
  description!: string;

  @ApiProperty({ enum: AccountingEventType })
  eventType!: AccountingEventType;

  @ApiProperty()
  sourceType!: string;

  @ApiProperty({ format: 'uuid' })
  sourceId!: string;

  @ApiProperty({ type: String })
  debitAmount!: string;

  @ApiProperty({ type: String })
  creditAmount!: string;

  @ApiProperty({
    type: String,
    description:
      'Saldo acumulado en la dirección NATURAL de la cuenta (normalBalance).',
  })
  runningBalance!: string;
}

export class LedgerReportResponseDto {
  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ example: 'AR' })
  accountCode!: string;

  @ApiProperty({ example: 'Cuentas por cobrar' })
  accountName!: string;

  @ApiProperty({ enum: AccountType })
  accountType!: AccountType;

  @ApiProperty({ enum: AccountStatus })
  accountStatus!: AccountStatus;

  @ApiProperty({ enum: ['DEBIT', 'CREDIT'] })
  normalBalance!: 'DEBIT' | 'CREDIT';

  @ApiProperty({ type: String, format: 'date' })
  accountingDateFrom!: string;

  @ApiProperty({ type: String, format: 'date' })
  accountingDateTo!: string;

  @ApiProperty({ type: String })
  openingBalance!: string;

  @ApiProperty({ type: String })
  closingBalance!: string;

  @ApiProperty({ type: [LedgerMovementRowDto] })
  data!: LedgerMovementRowDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
