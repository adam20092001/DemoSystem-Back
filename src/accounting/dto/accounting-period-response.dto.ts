import { ApiProperty } from '@nestjs/swagger';
import { AccountingPeriodStatus } from '@prisma/client';

/** Identidad mínima segura del usuario que cerró/reabrió el periodo. */
export class AccountingPeriodUserResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  username!: string;

  @ApiProperty()
  firstName!: string;

  @ApiProperty()
  lastName!: string;
}

export class AccountingPeriodResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 2026 })
  year!: number;

  @ApiProperty({ example: 10, minimum: 1, maximum: 12 })
  month!: number;

  @ApiProperty({ enum: AccountingPeriodStatus })
  status!: AccountingPeriodStatus;

  @ApiProperty({
    description:
      'Último número de asiento ya asignado dentro de este periodo (Fase A2.3); el próximo asiento recibirá lastJournalNumber + 1.',
  })
  lastJournalNumber!: number;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: Date | null;

  @ApiProperty({ type: AccountingPeriodUserResponseDto, nullable: true })
  closedBy!: AccountingPeriodUserResponseDto | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  reopenedAt!: Date | null;

  @ApiProperty({ type: AccountingPeriodUserResponseDto, nullable: true })
  reopenedBy!: AccountingPeriodUserResponseDto | null;

  @ApiProperty({ type: String, format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ type: String, format: 'date-time' })
  updatedAt!: Date;
}

export class PaginatedAccountingPeriodsResponseDto {
  @ApiProperty({ type: [AccountingPeriodResponseDto] })
  data!: AccountingPeriodResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
