import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsUUID, Matches } from 'class-validator';

/**
 * Mismo criterio textual que PAYMENT_AMOUNT_PATTERN (payments/dto/
 * create-payment.dto.ts): sin notación científica, sin coma decimal,
 * máximo 2 decimales (Decimal(14,2)), sin signo — por construcción nunca
 * acepta un valor negativo. A diferencia de un monto de pago, SÍ permite
 * "0"/"0.00": una línea de BORRADOR todavía sin llenar es válida (A4.2);
 * la exigencia más estricta ("exactamente un lado positivo") se aplica
 * recién al contabilizar (A4.3), nunca en este DTO.
 */
export const MANUAL_JOURNAL_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

export class ManualJournalLineDto {
  @ApiProperty({ format: 'uuid' })
  @IsUUID()
  accountId!: string;

  @ApiProperty({
    type: String,
    example: '100.00',
    description:
      'Decimal como texto, máximo 2 decimales, nunca negativo. "0.00" es válido mientras el borrador no esté contabilizado.',
  })
  @IsString()
  @Matches(MANUAL_JOURNAL_AMOUNT_PATTERN, {
    message:
      'debitAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  debitAmount!: string;

  @ApiProperty({
    type: String,
    example: '0.00',
    description:
      'Decimal como texto, máximo 2 decimales, nunca negativo. "0.00" es válido mientras el borrador no esté contabilizado.',
  })
  @IsString()
  @Matches(MANUAL_JOURNAL_AMOUNT_PATTERN, {
    message:
      'creditAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  creditAmount!: string;
}
