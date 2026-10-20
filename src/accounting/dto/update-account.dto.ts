import { ApiPropertyOptional } from '@nestjs/swagger';
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
 * `code`/`systemKey`/`status` nunca se aceptan aquí: `code` es inmutable,
 * `systemKey` solo se reasigna vía el endpoint dedicado, `status` se
 * administra únicamente vía activate/deactivate (mismo criterio que
 * UpdateCategoryDto). `parentId` acepta null explícito (convertir en
 * cuenta raíz) además de omitirse (no tocar).
 */
export class UpdateAccountDto {
  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @MinLength(1)
  @MaxLength(150)
  name?: string;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'null convierte la cuenta en raíz.',
  })
  @IsOptional()
  @IsUUID()
  parentId?: string | null;

  @ApiPropertyOptional({
    enum: AccountType,
    description:
      'Bloqueado (409) si la cuenta ya tiene al menos un asiento histórico.',
  })
  @IsOptional()
  @IsEnum(AccountType)
  type?: AccountType;

  @ApiPropertyOptional({
    description:
      'true solo permitido si la cuenta no tiene subcuentas; una cuenta con hijos nunca puede ser postable. false bloqueado (409) en una cuenta de sistema (systemKey no nulo): AccountingEngine la sigue necesitando postable.',
  })
  @IsOptional()
  @IsBoolean()
  isPostable?: boolean;
}
