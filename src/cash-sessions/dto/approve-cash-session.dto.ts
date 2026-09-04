import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';

/**
 * Cuerpo de POST /cash-sessions/:id/approve (Ticket B, Bloque B3).
 * `approvedByUserId`/`approvedAt` nunca se aceptan: el servidor los fija
 * siempre (actor autenticado, now()).
 */
export class ApproveCashSessionDto {
  @ApiPropertyOptional({
    type: String,
    maxLength: 500,
    description: 'Comentario opcional del revisor al aprobar el descuadre.',
    example: 'Verificado con el cobrador, faltante aceptado',
  })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  comment?: string;
}
