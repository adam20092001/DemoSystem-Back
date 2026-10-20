import { ApiPropertyOptional } from '@nestjs/swagger';
import { AccountStatus, AccountType } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import { nullStringToNull } from '../../common/validators/null-string-to-null.transform';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

/**
 * `parentId=null` (literal, en query string) filtra explícitamente las
 * cuentas raíz; omitir el parámetro no filtra por jerarquía en absoluto
 * — misma ambigüedad que ya resuelve ListCategoriesQueryDto.parentId con
 * el mismo criterio (`query.parentId !== undefined` en el servicio).
 */
export class ListChartAccountsQueryDto {
  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ minimum: 1, maximum: 100, default: 20 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @ApiPropertyOptional({
    description: 'Búsqueda por code o name (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({ enum: AccountType })
  @IsOptional()
  @IsEnum(AccountType)
  type?: AccountType;

  @ApiPropertyOptional({ enum: AccountStatus })
  @IsOptional()
  @IsEnum(AccountStatus)
  status?: AccountStatus;

  @ApiPropertyOptional()
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  isPostable?: boolean;

  @ApiPropertyOptional({
    format: 'uuid',
    nullable: true,
    description: 'Enviar literalmente "null" para filtrar cuentas raíz.',
  })
  @IsOptional()
  @Transform(nullStringToNull)
  @IsUUID()
  parentId?: string | null;
}
