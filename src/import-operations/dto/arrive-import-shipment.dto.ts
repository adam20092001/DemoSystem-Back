import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional } from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';

export class ArriveImportShipmentDto {
  @ApiPropertyOptional({
    type: String,
    example: '2026-11-24',
    description: 'Por defecto, la fecha de negocio actual si se omite.',
  })
  @IsOptional()
  @IsDateOnly()
  actualArrivalDate?: string;
}
