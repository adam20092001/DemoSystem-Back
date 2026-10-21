import { ApiPropertyOptional } from '@nestjs/swagger';
import { SupplierDocumentType, SupplierStatus } from '@prisma/client';
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
export class ListSuppliersQueryDto {
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

  @ApiPropertyOptional({ enum: SupplierStatus })
  @IsOptional()
  @IsEnum(SupplierStatus)
  status?: SupplierStatus;

  @ApiPropertyOptional({ enum: SupplierDocumentType })
  @IsOptional()
  @IsEnum(SupplierDocumentType)
  documentType?: SupplierDocumentType;

  @ApiPropertyOptional({ maxLength: 2 })
  @IsOptional()
  @IsString()
  @MaxLength(2)
  countryCode?: string;

  @ApiPropertyOptional({
    maxLength: 150,
    description:
      'Búsqueda por documentNumber, legalName, tradeName, contactName, email o phone (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}
