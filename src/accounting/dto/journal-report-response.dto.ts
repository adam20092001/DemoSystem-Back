import { ApiProperty } from '@nestjs/swagger';
import { AccountingEventType, AccountingSourceType } from '@prisma/client';

export class JournalLineRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  accountId!: string;

  @ApiProperty({ example: 'AR' })
  accountCode!: string;

  @ApiProperty({ example: 'Cuentas por cobrar' })
  accountName!: string;

  @ApiProperty({ type: String })
  debitAmount!: string;

  @ApiProperty({ type: String })
  creditAmount!: string;
}

export class JournalEntryRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-03-15' })
  accountingDate!: string;

  @ApiProperty({ format: 'uuid' })
  periodId!: string;

  @ApiProperty({ example: 2026 })
  periodYear!: number;

  @ApiProperty({ example: 3 })
  periodMonth!: number;

  @ApiProperty({ example: 7 })
  journalNumber!: number;

  @ApiProperty()
  description!: string;

  @ApiProperty({ enum: AccountingSourceType })
  sourceType!: AccountingSourceType;

  @ApiProperty({ format: 'uuid' })
  sourceId!: string;

  @ApiProperty({ enum: AccountingEventType })
  eventType!: AccountingEventType;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  reversesEntryId!: string | null;

  @ApiProperty({ type: String, format: 'date-time' })
  postedAt!: Date;

  @ApiProperty({ type: [JournalLineRowDto] })
  lines!: JournalLineRowDto[];

  @ApiProperty({ type: String })
  totalDebit!: string;

  @ApiProperty({ type: String })
  totalCredit!: string;
}

export class JournalReportResponseDto {
  @ApiProperty({ type: [JournalEntryRowDto] })
  data!: JournalEntryRowDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;

  @ApiProperty({ type: String, format: 'date' })
  accountingDateFrom!: string;

  @ApiProperty({ type: String, format: 'date' })
  accountingDateTo!: string;

  @ApiProperty({ type: String, format: 'uuid', nullable: true })
  periodId!: string | null;
}
