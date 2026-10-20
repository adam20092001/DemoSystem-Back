import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AccountType } from '@prisma/client';
import {
  IsBoolean,
  IsEnum,
  IsOptional,
  IsUUID,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * `status` nunca se acepta aquí: toda cuenta nace ACTIVE; el estado se
 * administra únicamente vía activate/deactivate (mismo criterio que
 * CreateCategoryDto). `systemKey` tampoco: una cuenta nueva nace sin
 * mapeo — asignarlo es una operación explícita y separada
 * (reassignSystemKey(), A1.3). `level` nunca se acepta: lo calcula el
 * servidor a partir de `parentId`.
 */
export class CreateAccountDto {
  @ApiProperty({ maxLength: 20, example: '1041' })
  @MinLength(1)
  @MaxLength(20)
  code!: string;

  @ApiProperty({
    maxLength: 150,
    example: 'Cuentas corrientes en instituciones financieras',
  })
  @MinLength(1)
  @MaxLength(150)
  name!: string;

  @ApiProperty({ enum: AccountType })
  @IsEnum(AccountType)
  type!: AccountType;

  @ApiPropertyOptional({
    format: 'uuid',
    description: 'Cuenta padre. Omitir para crear una cuenta raíz.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string;

  @ApiPropertyOptional({
    default: true,
    description:
      'Si esta cuenta puede recibir líneas de asiento nuevas. Si se envía parentId, la cuenta padre debe estar marcada isPostable=false antes de agregarle una subcuenta (ver reglas de A1.2): una cuenta de agrupación nunca es postable.',
  })
  @IsOptional()
  @IsBoolean()
  isPostable?: boolean;
}
