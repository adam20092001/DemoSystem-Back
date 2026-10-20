import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AccountStatus,
  AccountType,
  AccountingSystemKey,
} from '@prisma/client';

export class ChartAccountResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: '1041' })
  code!: string;

  @ApiProperty({ example: 'Cuentas corrientes en instituciones financieras' })
  name!: string;

  @ApiProperty({ enum: AccountType })
  type!: AccountType;

  @ApiProperty({
    enum: AccountingSystemKey,
    nullable: true,
    description:
      'null si esta cuenta no resuelve ningún evento automático de AccountingEngine todavía.',
  })
  systemKey!: AccountingSystemKey | null;

  @ApiProperty({ nullable: true, type: String, format: 'uuid' })
  parentId!: string | null;

  @ApiProperty({ minimum: 1 })
  level!: number;

  @ApiProperty()
  isPostable!: boolean;

  @ApiProperty({ enum: AccountStatus })
  status!: AccountStatus;

  @ApiProperty({
    enum: ['DEBIT', 'CREDIT'],
    description: 'Derivado de `type`, nunca persistido.',
  })
  normalBalance!: 'DEBIT' | 'CREDIT';

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

export class PaginatedChartAccountsResponseDto {
  @ApiProperty({ type: [ChartAccountResponseDto] })
  data!: ChartAccountResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class AccountTreeNodeResponseDto extends ChartAccountResponseDto {
  @ApiPropertyOptional({ type: () => [AccountTreeNodeResponseDto] })
  children!: AccountTreeNodeResponseDto[];
}
