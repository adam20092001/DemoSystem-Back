import { ApiPropertyOptional } from '@nestjs/swagger';
import { FiscalDocumentType } from '@prisma/client';
import { Transform } from 'class-transformer';
import { IsBoolean, IsEnum, IsOptional } from 'class-validator';
import { toStrictBoolean } from '../../common/validators/to-strict-boolean.transform';

/**
 * Solo lectura (Bloque 11D §20/§21): sin paginación (el catálogo de series
 * es pequeño por diseño), orden fijo documentType ASC, series ASC.
 */
export class ListFiscalSeriesQueryDto {
  @ApiPropertyOptional({ enum: FiscalDocumentType })
  @IsOptional()
  @IsEnum(FiscalDocumentType)
  documentType?: FiscalDocumentType;

  @ApiPropertyOptional({
    type: Boolean,
    description:
      'Acepta true/false (boolean o string). Cualquier otro valor falla la validación.',
  })
  @IsOptional()
  @Transform(toStrictBoolean)
  @IsBoolean()
  active?: boolean;
}
