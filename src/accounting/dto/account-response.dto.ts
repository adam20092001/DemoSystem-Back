import { ApiProperty } from '@nestjs/swagger';
import { AccountType, AccountingSystemKey } from '@prisma/client';

/**
 * Fila segura de una cuenta del plan de cuentas básico. Sin createdAt
 * (sin caso de uso real: las seis cuentas son fijas e inmutables en este
 * MVP), sin status/balance/metadata interna.
 */
export class AccountResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'AR' })
  code!: string;

  @ApiProperty({ example: 'Cuentas por cobrar' })
  name!: string;

  @ApiProperty({ enum: AccountType })
  type!: AccountType;

  @ApiProperty({ enum: AccountingSystemKey })
  systemKey!: AccountingSystemKey;
}
