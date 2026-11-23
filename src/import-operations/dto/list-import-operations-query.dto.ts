import { ApiPropertyOptional } from '@nestjs/swagger';
import { ImportOperationStatus } from '@prisma/client';
import { Transform, Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsString,
  IsUUID,
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
    format: 'uuid',
    description: 'Operaciones de una factura de compra.',
  })
  @IsOptional()
  @IsUUID()
  purchaseInvoiceId?: string;

  @ApiPropertyOptional({
    description:
      'true: solo históricas sin factura principal; false: solo vinculadas.',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  isLegacyUnlinked?: boolean;

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
