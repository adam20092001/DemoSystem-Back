import { ApiPropertyOptional } from '@nestjs/swagger';
import { ImportOperationStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
} from 'class-validator';

/** Sin orderBy/sort/direction: el orden es fijo (createdAt desc, id desc) en el servicio. */
export class ListImportOperationsQueryDto {
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

  @ApiPropertyOptional({ enum: ImportOperationStatus })
  @IsOptional()
  @IsEnum(ImportOperationStatus)
  status?: ImportOperationStatus;

  @ApiPropertyOptional({ maxLength: 2 })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  originCountry?: string;

  @ApiPropertyOptional({ maxLength: 2 })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  destinationCountry?: string;

  @ApiPropertyOptional({
    maxLength: 150,
    description:
      'Búsqueda por reference, description o externalReference (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}
