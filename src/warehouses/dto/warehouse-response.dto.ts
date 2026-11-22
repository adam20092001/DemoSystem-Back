import { ApiProperty } from '@nestjs/swagger';
import { WarehouseStatus } from '@prisma/client';

/**
 * Documenta SafeWarehouse. Es documentación de contrato/Swagger, no una
 * segunda fuente de mapeo (la frontera real es WAREHOUSE_SAFE_SELECT +
 * toSafeWarehouse()).
 */
export class WarehouseResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ example: 'MAIN' })
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ enum: WarehouseStatus })
  status!: WarehouseStatus;

  @ApiProperty({
    description:
      'Almacén principal (MAIN). Informativo en R2-A1: el motor de stock todavía no lo usa.',
  })
  isDefault!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class WarehouseLocationResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid' })
  warehouseId!: string;

  @ApiProperty({ example: 'DEFAULT' })
  code!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ nullable: true, type: String })
  description!: string | null;

  @ApiProperty({ enum: WarehouseStatus })
  status!: WarehouseStatus;

  @ApiProperty({
    description: 'true solo para la ubicación técnica DEFAULT del almacén.',
  })
  isDefault!: boolean;

  @ApiProperty({ format: 'date-time' })
  createdAt!: Date;

  @ApiProperty({ format: 'date-time' })
  updatedAt!: Date;
}

export class PaginatedWarehousesResponseDto {
  @ApiProperty({ type: [WarehouseResponseDto] })
  data!: WarehouseResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}

export class PaginatedWarehouseLocationsResponseDto {
  @ApiProperty({ type: [WarehouseLocationResponseDto] })
  data!: WarehouseLocationResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
