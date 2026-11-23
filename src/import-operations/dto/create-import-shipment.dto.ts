import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ImportIncoterm, ImportTransportMode } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  ArrayMinSize,
  IsArray,
  IsEnum,
  IsIn,
  IsOptional,
  IsString,
  MaxLength,
  ValidateNested,
} from 'class-validator';
import { IsDateOnly } from './is-date-only.decorator';
import { ImportShipmentLineDto } from './import-shipment-line.dto';

/**
 * id, status y toda auditoría de cancelación nunca se aceptan: son
 * valores de sistema. actualDepartureDate/actualArrivalDate NUNCA se
 * aceptan aquí: solo se fijan vía depart()/arrive() (CLAUDE.md B1 §2:
 * "prevent modification of historical facts through unrestricted PATCH
 * operations").
 */
export class CreateImportShipmentDto {
  @ApiProperty({ enum: ImportTransportMode })
  @IsEnum(ImportTransportMode)
  transportMode!: ImportTransportMode;

  @ApiPropertyOptional({
    enum: ImportIncoterm,
    description:
      'Incoterms 2020. Sin valor predeterminado. FAS, FOB, CFR y CIF solo con transportMode=SEA. Con incoterm es obligatorio incotermNamedPlace.',
  })
  @IsOptional()
  @IsEnum(ImportIncoterm)
  incoterm?: ImportIncoterm;

  @ApiPropertyOptional({
    maxLength: 150,
    description: 'Lugar o puerto convenido (obligatorio si se envía incoterm).',
  })
  @IsOptional()
  @IsString()
  @MaxLength(150)
  incotermNamedPlace?: string;

  @ApiPropertyOptional({
    enum: ['2020'],
    description: 'Versión de los Incoterms; si se omite con incoterm, se asigna 2020.',
  })
  @IsOptional()
  @IsString()
  @IsIn(['2020'])
  incotermVersion?: string;

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

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Bill of Lading (SEA) o Air Waybill (AIR), según el modo de transporte.',
  })
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

  @ApiProperty({ type: [ImportShipmentLineDto] })
  @IsArray()
  @ArrayMinSize(1)
  @ValidateNested({ each: true })
  @Type(() => ImportShipmentLineDto)
  lines!: ImportShipmentLineDto[];
}
