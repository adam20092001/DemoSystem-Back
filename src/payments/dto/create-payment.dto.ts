import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsOptional,
  IsString,
  Matches,
  MaxLength,
  MinLength,
} from 'class-validator';

/**
 * Mismo criterio textual que el resto del dominio (payment-calculator.ts,
 * Bloque B): sin notación científica, sin coma decimal, máximo 2 decimales
 * (Decimal(14,2)). ">0" y el máximo de Decimal(14,2) los revalida el
 * dominio, no este DTO.
 */
export const PAYMENT_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Cuerpo de un pago posterior (POST /sales/:saleId/payments). saleId viaja
 * en la URL, nunca aquí. paidAt/status/createdBy/campos de anulación/
 * amount summary nunca se aceptan: son valores de sistema calculados por
 * PaymentEngine (Bloque B).
 *
 * `method` (Ticket C, Bloque C3): código de un método de pago dinámico
 * (`payment_methods.code`, ADMIN-administrable vía PaymentMethodsModule),
 * NUNCA el antiguo enum PaymentMethod (eliminado). Este DTO solo valida
 * FORMA HTTP mínima (texto no vacío, longitud razonable) — trim/mayúsculas,
 * existencia, actividad y la exigencia de referencia dependiente del método
 * son responsabilidad exclusiva del dominio (payment-calculator.ts +
 * PaymentEngine.register(), dentro de la misma transacción que crea el
 * pago): este DTO nunca la duplica ni la anticipa, para no rechazar en la
 * capa HTTP un `method` en minúsculas que el dominio normalizaría
 * correctamente.
 */
export class CreatePaymentDto {
  @ApiProperty({
    minLength: 1,
    maxLength: 30,
    example: 'CASH',
    description:
      'Código de un método de pago dinámico (ver GET /payment-methods para la lista de códigos activos). Se normaliza a mayúsculas en el dominio; debe existir y estar activo, o la petición se rechaza (404/409).',
  })
  @IsString()
  @MinLength(1)
  @MaxLength(30)
  method!: string;

  @ApiProperty({
    type: String,
    description:
      'Decimal positivo, como texto, máximo 2 decimales. Sin notación científica ni comas.',
    example: '40.00',
  })
  @IsString()
  @Matches(PAYMENT_AMOUNT_PATTERN, {
    message:
      'amount debe ser un decimal positivo, como texto, con máximo 2 decimales',
  })
  amount!: string;

  @ApiPropertyOptional({
    maxLength: 100,
    description:
      'Obligatoria cuando el método de pago resuelto tiene requiresReference=true (validado en el dominio, ver GET /payment-methods); opcional en caso contrario.',
    example: 'OP-000123',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;
}
