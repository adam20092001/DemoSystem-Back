import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * cancellationSource/cancelledAt/cancelledByUserId nunca se aceptan aquí:
 * son valores de sistema. El endpoint manual siempre resuelve a MANUAL
 * (PaymentsService.cancel -> PaymentEngine.cancel), nunca elegido por el
 * cliente. Esta validación es solo el límite HTTP; el dominio
 * (normalizePaymentCancellationReason) sigue siendo la autoridad final
 * (trim, no vacío tras recortar espacios, máximo 200) — un valor de solo
 * espacios pasa IsNotEmpty pero el dominio lo rechaza igual.
 */
export class CancelPaymentDto {
  @ApiProperty({
    maxLength: 200,
    description: 'Motivo obligatorio de la anulación manual del pago.',
    example: 'Pago registrado por error',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason!: string;
}
