import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PaymentMethod } from '@prisma/client';
import {
  IsEnum,
  IsOptional,
  IsString,
  Matches,
  MaxLength,
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
 * PaymentEngine (Bloque B). La validación dependiente del método
 * (BANK_TRANSFER/BANK_DEPOSIT/CARD exigen referencia no vacía —
 * Documento Maestro §16) es responsabilidad del dominio
 * (payment-calculator.ts): este DTO solo valida la forma HTTP, nunca la
 * duplica.
 */
export class CreatePaymentDto {
  @ApiProperty({ enum: PaymentMethod })
  @IsEnum(PaymentMethod)
  method!: PaymentMethod;

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
      'Obligatoria para BANK_TRANSFER/BANK_DEPOSIT/CARD (validado en el dominio); opcional para CASH/DIGITAL_WALLET/OTHER.',
    example: 'OP-000123',
  })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  reference?: string;
}
