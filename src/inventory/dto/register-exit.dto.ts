import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  IsUUID,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';
import { INVENTORY_QUANTITY_PATTERN } from '../constants/inventory-decimal.constants';

/**
 * Nunca acepta movementType/origin/direction/auditAction/previousStock/
 * newStock/createdByUserId/referenceType/referenceId: StockMovementEngine
 * los fija internamente (siempre EXIT + MANUAL). El ValidationPipe global
 * (whitelist + forbidNonWhitelisted) rechaza cualquier campo adicional.
 */
export class RegisterExitDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    type: String,
    description:
      'Decimal no negativo, sin signo, sin notación científica, máximo 11 enteros y 3 decimales, como string.',
    example: '2.000',
  })
  @IsString()
  @Matches(INVENTORY_QUANTITY_PATTERN, {
    message:
      'quantity debe ser un decimal no negativo, como string, con máximo 11 enteros y 3 decimales',
  })
  quantity!: string;

  @ApiProperty({ maxLength: 200, example: 'Merma por daño' })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  reason!: string;

  @ApiPropertyOptional({ maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  notes?: string;
}
