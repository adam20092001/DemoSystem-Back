import { ApiPropertyOptional, ApiProperty } from '@nestjs/swagger';
import { LineDiscountType } from '@prisma/client';
import { IsEnum, IsOptional, IsString, IsUUID, Matches } from 'class-validator';

/**
 * Mismo criterio textual que el dominio (quote-calculator.ts, Bloque B):
 * solo dígitos, sin signo, sin notación científica, máximo 3 decimales
 * (Decimal(14,3)). ">0" y el ancho máximo de 11 enteros los revalida
 * QuotesService, no este DTO.
 */
const QUOTE_QUANTITY_PATTERN = /^\d{1,11}(\.\d{1,3})?$/;

/**
 * Mismo criterio textual que QUOTE_DISCOUNT_PATTERN (create-quote.dto.ts):
 * sin notación científica, máximo 2 decimales. Rango real (0-100 para
 * PERCENT; ≤ bruto de línea para FIXED) y límite configurado
 * (maxDiscountPercent) los revalida QuotesService vía
 * quote-calculator.ts, no este DTO.
 */
export const LINE_DISCOUNT_VALUE_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * NR-03: solo productId + quantity + descuento de línea OPCIONAL
 * (discountType/discountValue, ambos presentes o ambos ausentes —
 * QuotesService lo revalida con parseLineDiscount()). unitPrice/lineTotal/
 * discountAmount/snapshots nunca se aceptan aquí: el precio siempre se lee
 * de Product.salePrice y el descuento se calcula dentro de QuotesService.
 */
export class CreateQuoteItemDto {
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
  @Matches(QUOTE_QUANTITY_PATTERN, {
    message:
      'quantity debe ser un decimal no negativo, como texto, con máximo 3 decimales',
  })
  quantity!: string;

  @ApiPropertyOptional({
    enum: LineDiscountType,
    description:
      'Descuento individual de esta línea. FIXED = discountValue en soles (nunca mayor que el bruto de la línea); PERCENT = discountValue entre 0 y 100. Debe proveerse junto con discountValue (ambos o ninguno). El límite maxDiscountPercent configurado también aplica al descuento efectivo de la línea, incluso si es FIXED.',
  })
  @IsOptional()
  @IsEnum(LineDiscountType)
  discountType?: LineDiscountType;

  @ApiPropertyOptional({
    type: String,
    description:
      'Decimal no negativo, como texto, máximo 2 decimales. Soles si discountType=FIXED; porcentaje (0-100) si discountType=PERCENT.',
    example: '10.00',
  })
  @IsOptional()
  @IsString()
  @Matches(LINE_DISCOUNT_VALUE_PATTERN, {
    message:
      'discountValue debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  discountValue?: string;
}
