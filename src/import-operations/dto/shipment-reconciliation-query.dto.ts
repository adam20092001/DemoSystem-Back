import { ApiPropertyOptional } from '@nestjs/swagger';
import { ImportShipmentStatus } from '@prisma/client';
import { Type } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsOptional,
  IsUUID,
  Max,
  Min,
} from 'class-validator';

export class ShipmentReconciliationQueryDto {
  @ApiPropertyOptional({ format: 'uuid' })
  @IsOptional()
  @IsUUID()
  importOperationId?: string;

  @ApiPropertyOptional({ enum: ImportShipmentStatus })
  @IsOptional()
  @IsEnum(ImportShipmentStatus)
  shipmentStatus?: ImportShipmentStatus;

  @ApiPropertyOptional({
    description:
      'Si es true, solo devuelve líneas con al menos un código de discrepancia.',
  })
  @IsOptional()
  @Type(() => Boolean)
  @IsBoolean()
  onlyWithDiscrepancies?: boolean;

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
}
