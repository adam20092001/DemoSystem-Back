import { ApiProperty } from '@nestjs/swagger';
import { AccountStatus, AccountType } from '@prisma/client';

export class TrialBalanceAccountRowDto {
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

  @ApiProperty({ type: String })
  openingDebit!: string;

  @ApiProperty({ type: String })
  openingCredit!: string;

  @ApiProperty({ type: String })
  periodDebit!: string;

  @ApiProperty({ type: String })
  periodCredit!: string;

  @ApiProperty({ type: String })
  endingDebit!: string;

  @ApiProperty({ type: String })
  endingCredit!: string;
}

export class TrialBalanceReconciliationDto {
  @ApiProperty({
    description:
      'false cuando se filtró un subconjunto explícito de cuentas: un subconjunto arbitrario nunca tiene por qué cuadrar por sí solo.',
  })
  applicable!: boolean;

  @ApiProperty({ type: Boolean, nullable: true })
  openingBalanced!: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true })
  periodBalanced!: boolean | null;

  @ApiProperty({ type: Boolean, nullable: true })
  endingBalanced!: boolean | null;

  @ApiProperty({ type: String })
  totalOpeningDebit!: string;

  @ApiProperty({ type: String })
  totalOpeningCredit!: string;

  @ApiProperty({ type: String })
  totalPeriodDebit!: string;

  @ApiProperty({ type: String })
  totalPeriodCredit!: string;

  @ApiProperty({ type: String })
  totalEndingDebit!: string;

  @ApiProperty({ type: String })
  totalEndingCredit!: string;
}

export class TrialBalanceResponseDto {
  @ApiProperty({ type: String, format: 'date' })
  accountingDateFrom!: string;

  @ApiProperty({ type: String, format: 'date' })
  accountingDateTo!: string;

  @ApiProperty({ type: [TrialBalanceAccountRowDto] })
  data!: TrialBalanceAccountRowDto[];

  @ApiProperty({ type: TrialBalanceReconciliationDto })
  reconciliation!: TrialBalanceReconciliationDto;
}
