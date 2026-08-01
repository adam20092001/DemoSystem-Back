import { ApiPropertyOptional } from '@nestjs/swagger';
import { UnitStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  Min,
} from 'class-validator';
import { toStrictBoolean } from '../../common/validators/to-strict-boolean.transform';

export class ListUnitsQueryDto {
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
    description:
      'Búsqueda por code, name o abbreviation (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  search?: string;

  @ApiPropertyOptional({
    enum: UnitStatus,
    description: 'SELLER siempre ve solo ACTIVE, sin importar este valor.',
  })
  @IsOptional()
  @IsEnum(UnitStatus)
  status?: UnitStatus;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Acepta true/false (boolean o string). Cualquier otro valor falla la validación.',
  })
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  allowDecimal?: boolean;
}
