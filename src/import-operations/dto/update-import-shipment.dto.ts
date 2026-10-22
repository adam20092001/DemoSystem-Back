import { ApiPropertyOptional } from '@nestjs/swagger';
import { ImportTransportMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';
import { ImportShipmentLineDto } from './import-shipment-line.dto';

/**
 * Solo aplicable mientras el embarque está PLANNED (ImportShipmentsService
 * lo rechaza con 409 en cualquier otro estado). `lines`, si se provee,
 * REEMPLAZA el arreglo completo — nunca un parche línea a línea.
 */
export class UpdateImportShipmentDto {
  @ApiPropertyOptional({ enum: ImportTransportMode })
  @IsOptional()
  @IsEnum(ImportTransportMode)
  transportMode?: ImportTransportMode;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  carrierName?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  trackingReference?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  billOfLadingNumber?: string;

  @ApiPropertyOptional({ maxLength: 100 })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  containerReference?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  originLocation?: string;

  @ApiPropertyOptional({ maxLength: 150 })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  destinationLocation?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-01' })
  @IsOptional()
  @IsDateOnly()
  estimatedDepartureDate?: string;

  @ApiPropertyOptional({ type: String, example: '2026-11-25' })
  @IsOptional()
  @IsDateOnly()
  estimatedArrivalDate?: string;

  @ApiPropertyOptional({ maxLength: 1000 })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  notes?: string;

  @ApiPropertyOptional({
    type: [ImportShipmentLineDto],
    description: 'Si se provee, REEMPLAZA el arreglo completo de líneas.',
  })
  @IsOptional()
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportShipmentLineDto)
  lines?: ImportShipmentLineDto[];
}
