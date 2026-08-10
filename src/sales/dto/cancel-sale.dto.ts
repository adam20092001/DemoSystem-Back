import { ApiProperty } from '@nestjs/swagger';
import { IsNotEmpty, IsString, MaxLength } from 'class-validator';

/**
 * status/cancelledAt/cancelledByUserId nunca se aceptan aquí: son valores
 * de sistema. Esta validación es solo el límite HTTP; SalesService sigue
 * siendo la autoridad final (trim, no vacío tras recortar espacios, máximo
 * 200) — un valor de solo espacios pasa IsNotEmpty pero SalesService lo
 * rechaza igual.
 */
export class CancelSaleDto {
  @ApiProperty({
    maxLength: 200,
    description: 'Motivo obligatorio de la anulación.',
    example: 'Cliente se arrepintió del pedido',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  reason!: string;
}
