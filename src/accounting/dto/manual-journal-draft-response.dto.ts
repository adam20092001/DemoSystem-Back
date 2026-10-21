import { ApiProperty } from '@nestjs/swagger';
import { ManualJournalDraftStatus } from '@prisma/client';

export class ManualJournalDraftLineResponseDto {
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

export class ManualJournalDraftResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ type: String, format: 'date', example: '2026-03-15' })
  accountingDate!: string;

  @ApiProperty()
  description!: string;

  @ApiProperty({ enum: ManualJournalDraftStatus })
  status!: ManualJournalDraftStatus;

  @ApiProperty({
    type: String,
    format: 'uuid',
    nullable: true,
    description:
      'id del AccountingEntry definitivo una vez contabilizado; null mientras status=DRAFT.',
  })
  postedEntryId!: string | null;

  @ApiProperty({ format: 'uuid' })
  createdByUserId!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;

  @ApiProperty({ type: [ManualJournalDraftLineResponseDto] })
  lines!: ManualJournalDraftLineResponseDto[];
}

export class PaginatedManualJournalDraftsResponseDto {
  @ApiProperty({ type: [ManualJournalDraftResponseDto] })
  data!: ManualJournalDraftResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
