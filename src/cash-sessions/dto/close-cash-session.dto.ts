import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';

/** Duplicado a propósito de OPENING_AMOUNT_PATTERN (mismo criterio de no acoplar DTO-a-DTO ya usado en el repositorio). */
export const COUNTED_CASH_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Cuerpo de POST /cash-sessions/current/close (Ticket B, Bloque B3).
 * `cashSessionId`/`userId` nunca se aceptan: la ruta siempre opera sobre la
 * caja sin resolver del actor autenticado. `closingObservation` es
 * OPCIONAL a nivel de DTO a propósito — la regla real (obligatoria y no en
 * blanco SOLO cuando el cierre resulta en descuadre) depende de
 * differenceAmount, que el servidor recién conoce después de calcular
 * expectedCashAmount; exigirla aquí rechazaría en la capa HTTP un cierre
 * exacto legítimo que no la necesita.
 */
export class CloseCashSessionDto {
  @ApiProperty({
    type: String,
    description:
      'Efectivo físico contado, como texto decimal no negativo, máximo 2 decimales.',
    example: '295.00',
  })
  @IsString()
  @Matches(COUNTED_CASH_AMOUNT_PATTERN, {
    message:
      'countedCashAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  countedCashAmount!: string;

  @ApiPropertyOptional({
    type: String,
    maxLength: 500,
    description:
      'Obligatoria y no vacía SOLO cuando el cierre resulta en un descuadre (differenceAmount <> 0); opcional en un cierre exacto.',
    example: 'Faltante por vuelto mal entregado en la mañana',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  closingObservation?: string;
}
