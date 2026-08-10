import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

/**
 * Mismo criterio textual que el dominio (sale-calculator.ts, que reexporta
 * el parser de quote-calculator.ts, Bloque B): solo dígitos, sin signo, sin
 * notación científica, máximo 3 decimales (Decimal(14,3)). ">0" y el ancho
 * máximo de 11 enteros los revalida SalesService, no este DTO.
 */
const SALE_QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

/**
 * Solo productId + quantity: unitPrice/lineTotal/snapshots nunca se
 * aceptan aquí. El precio siempre se lee de Product.salePrice vigente
 * (venta directa) dentro de SalesService.
 */
export class CreateSaleItemDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  productId!: string;

  @ApiProperty({
    type: String,
    description:
      'Decimal no negativo, como texto, máximo 3 decimales. Sin notación científica ni comas.',
    example: '2.500',
  })
  @IsString()
  @Matches(SALE_QUANTITY_PATTERN, {
    message:
      'quantity debe ser un decimal no negativo, como texto, con máximo 3 decimales',
  })
  quantity!: string;
}
