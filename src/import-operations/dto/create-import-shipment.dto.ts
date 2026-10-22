import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
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
