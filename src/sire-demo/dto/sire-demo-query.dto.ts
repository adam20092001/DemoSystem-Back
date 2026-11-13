import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsIn, IsInt, IsOptional, Matches, Max, Min } from 'class-validator';
import { PERIOD_PATTERN } from '../core/period';
import { DATA_QUALITY_FLAGS, SIRE_SOURCES } from '../core/types';
import type { DataQualityFlag, SireSource } from '../core/types';
import { SIRE_DEMO_MAX_PAGE_SIZE } from '../sire-demo.constants';

export class SireSampleFileQueryDto {
  @ApiProperty({
    enum: SIRE_SOURCES,
    description:
      'Origen de los documentos. Obligatorio y explícito: nunca se mezclan datos reales y sintéticos.',
  })
  @IsIn(SIRE_SOURCES, { message: 'source debe ser POS o DEMO_FIXTURES' })
  source!: SireSource;

  @ApiProperty({ example: '202601', description: 'Periodo YYYYMM.' })
  @Matches(PERIOD_PATTERN, {
    message: 'period debe tener formato YYYYMM con mes 01-12',
  })
  period!: string;
}

export class SireDocumentsQueryDto extends SireSampleFileQueryDto {
  @ApiPropertyOptional({
    enum: DATA_QUALITY_FLAGS,
    description: 'Filtra los documentos que tienen esta alerta de datos.',
  })
  @IsOptional()
  @IsIn(DATA_QUALITY_FLAGS, { message: 'flag no es una alerta válida' })
  flag?: DataQualityFlag;

  @ApiPropertyOptional({ minimum: 1, default: 1 })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    minimum: 1,
    maximum: SIRE_DEMO_MAX_PAGE_SIZE,
    default: 50,
  })
  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(SIRE_DEMO_MAX_PAGE_SIZE)
  pageSize?: number;
}
