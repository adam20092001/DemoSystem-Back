import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  PurchaseInvoiceDocumentType,
  PurchaseInvoiceStatus,
} from '@prisma/client';
import { Type } from 'class-transformer';
import {
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
export class ListPurchaseInvoicesQueryDto {
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

  @ApiPropertyOptional({ enum: PurchaseInvoiceStatus })
  @IsOptional()
  @IsEnum(PurchaseInvoiceStatus)
  status?: PurchaseInvoiceStatus;

  @ApiPropertyOptional({ enum: PurchaseInvoiceDocumentType })
  @IsOptional()
  @IsEnum(PurchaseInvoiceDocumentType)
  documentType?: PurchaseInvoiceDocumentType;

  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  supplierId?: string;

  @ApiPropertyOptional({
    maxLength: 150,
    description:
      'Búsqueda por documentNumber o documentSeries (insensible a mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  search?: string;
}
