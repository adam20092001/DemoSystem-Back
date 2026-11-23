import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';

export class ListCountriesQueryDto {
  @ApiPropertyOptional({
    description:
      'Por defecto solo países activos (para formularios nuevos). true incluye los inactivos (consulta histórica).',
  })
  @IsOptional()
  @Transform(({ value }: { value: unknown }) =>
    value === 'true' ? true : value === 'false' ? false : value,
  )
  @IsBoolean()
  includeInactive?: boolean;

  @ApiPropertyOptional({
    description:
      'Filtra por código o nombre (contiene, sin distinguir mayúsculas).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  search?: string;
}
