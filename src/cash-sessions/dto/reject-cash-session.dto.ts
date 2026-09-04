import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * Cuerpo de POST /cash-sessions/:id/reject (Ticket B, Bloque B3). El
 * dominio (normalizeRejectionReason) sigue siendo la autoridad final
 * (trim, no vacío tras recortar, máximo 500) — un valor de solo espacios
 * pasa IsNotEmpty pero el dominio lo rechaza igual.
 */
export class RejectCashSessionDto {
  @ApiProperty({
    type: String,
    maxLength: 500,
    description: 'Motivo obligatorio del rechazo del descuadre.',
    example: 'El conteo no coincide con lo reportado por el cobrador',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  reason!: string;
}
