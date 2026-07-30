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

/**
 * A diferencia de Type(() => Boolean), esto no convierte "false" (string no
 * vacío) en true: mismo defecto que ya se corrigió en env.validation.ts.
 */
function toStrictBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === true) return true;
  if (value === 'false' || value === false) return false;
  return value;
}

export class ListUnitsQueryDto {
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;

  @IsOptional()
  @IsString()
  search?: string;

  @IsOptional()
  @IsEnum(UnitStatus)
  status?: UnitStatus;

  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  allowDecimal?: boolean;
}
