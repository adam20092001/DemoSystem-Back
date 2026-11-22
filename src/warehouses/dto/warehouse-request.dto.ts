import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { WarehouseStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsOptional,
  IsString,
  Matches,
  Max,
  MaxLength,
  Min,
} from 'class-validator';
import {
  LOCATION_CODE_PATTERN,
  WAREHOUSE_CODE_PATTERN,
} from '../warehouse.utils';

/** trim + mayúsculas antes de validar el patrón (mismo criterio que el CHECK de la base). */
function normalizeCodeInput({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim().toUpperCase() : value;
}

function trimText({ value }: { value: unknown }): unknown {
  return typeof value === 'string' ? value.trim() : value;
}

export class CreateWarehouseDto {
  @ApiProperty({
    maxLength: 20,
    example: 'SUR',
    description:
      'Se normaliza a mayúsculas. 1-20 caracteres: letras, números, guion o guion bajo. Único. MAIN existe desde la migración.',
  })
  @Transform(normalizeCodeInput)
  @IsString()
  @Matches(WAREHOUSE_CODE_PATTERN, {
    message:
      'code debe tener 1-20 caracteres (A-Z, 0-9, guion, guion bajo) y empezar por letra o número',
  })
  code!: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  description?: string;
}

/** code, status e isDefault son inmutables: enviarlos produce 400 (whitelist estricta). */
export class UpdateWarehouseDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 300,
    nullable: true,
    type: String,
    description: 'null o texto vacío limpia la descripción.',
  })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  description?: string | null;
}

export class CreateWarehouseLocationDto {
  @ApiProperty({
    maxLength: 30,
    example: 'A-01',
    description:
      'Se normaliza a mayúsculas. 1-30 caracteres. Único dentro del almacén. DEFAULT está reservado.',
  })
  @Transform(normalizeCodeInput)
  @IsString()
  @Matches(LOCATION_CODE_PATTERN, {
    message:
      'code debe tener 1-30 caracteres (A-Z, 0-9, guion, guion bajo) y empezar por letra o número',
  })
  code!: string;

  @ApiProperty({ maxLength: 100 })
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  description?: string;
}

/** code, status e isDefault son inmutables: enviarlos produce 400 (whitelist estricta). */
export class UpdateWarehouseLocationDto {
  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({
    maxLength: 300,
    nullable: true,
    type: String,
    description: 'null o texto vacío limpia la descripción.',
  })
  @IsOptional()
  @Transform(trimText)
  @IsString()
  @MaxLength(300)
  description?: string | null;
}

/** Sin sort/orderBy: el orden es fijo (predeterminado primero, luego por código). */
export class ListWarehousesQueryDto {
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

  @ApiPropertyOptional({ enum: WarehouseStatus })
  @IsOptional()
  @IsEnum(WarehouseStatus)
  status?: WarehouseStatus;

  @ApiPropertyOptional({
    maxLength: 100,
    description: 'Busca en código y nombre.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}

/** Mismos parámetros que el listado de almacenes. */
export class ListWarehouseLocationsQueryDto extends ListWarehousesQueryDto {}
