import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * id, status y toda auditoría de completado/cancelación nunca se aceptan:
 * son valores de sistema fijados por ImportOperationsService. La
 * normalización (trim, formato ISO-2 de país, unicidad de reference) se
 * valida en el servicio, no aquí (mismo criterio que CreateSupplierDto).
 */
export class CreateImportOperationDto {
  @ApiProperty({ maxLength: 40, example: 'IMP-2026-0001' })
  @IsString()
  @MinLength(1)
  @MaxLength(40)
  reference!: string;

  @ApiPropertyOptional({ maxLength: 300 })
  @IsOptional()
  @IsString()
  @MaxLength(300)
  description?: string;

  @ApiProperty({
    maxLength: 2,
    example: 'CN',
    description: 'ISO 3166-1 alpha-2.',
  })
  @IsString()
  @MaxLength(2)
  originCountry!: string;

  @ApiProperty({
    maxLength: 2,
    example: 'PE',
    description: 'ISO 3166-1 alpha-2.',
  })
  @IsString()
  @MaxLength(2)
  destinationCountry!: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Referencia externa opcional (agente de carga, agente de aduanas, etc.).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  externalReference?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;
}
