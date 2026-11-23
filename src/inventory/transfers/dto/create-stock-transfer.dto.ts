import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { INVENTORY_QUANTITY_PATTERN } from '../../constants/inventory-decimal.constants';

/**
 * Nunca acepta movementType/origin/createdByUserId/referenceType/referenceId/
 * fecha: los fija el sistema. El ValidationPipe global (whitelist +
 * forbidNonWhitelisted) rechaza cualquier campo adicional.
 */
export class CreateStockTransferDto {
  @ApiProperty({
    format: 'uuid',
    description: 'Producto inventariable y activo.',
  })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Ubicación de ORIGEN. Debe tener saldo propio suficiente; nunca se completa con stock de otras ubicaciones.',
  })
  @IsUUID()
  sourceLocationId!: string;

  @ApiProperty({
    format: 'uuid',
    description:
      'Ubicación de DESTINO. Distinta del origen; puede ser de otro almacén.',
  })
  @IsUUID()
  destinationLocationId!: string;

  @ApiProperty({
    type: String,
    description:
      'Decimal positivo, sin signo ni notación científica, máximo 11 enteros y 3 decimales, como string.',
    example: '10.000',
  })
  @IsString()
  @Matches(INVENTORY_QUANTITY_PATTERN, {
    message:
      'quantity debe ser un decimal positivo, como string, con máximo 11 enteros y 3 decimales',
  })
  quantity!: string;

  @ApiProperty({ maxLength: 200, example: 'Reposición de estante' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Clave de idempotencia opcional (única por usuario). Misma clave y mismo contenido devuelve la transferencia original sin repetir movimientos; misma clave con contenido distinto responde 409. Sin clave NO hay garantía de deduplicación (un reintento crea otra transferencia).',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(100)
  idempotencyKey?: string;
}
