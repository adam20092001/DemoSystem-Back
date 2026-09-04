import { ApiProperty } from '@nestjs/swagger';
import { IsString, Matches } from 'class-validator';

/**
 * Mismo criterio textual que PAYMENT_AMOUNT_PATTERN
 * (payments/dto/create-payment.dto.ts): sin notación científica, sin coma
 * decimal, máximo 2 decimales (Decimal(14,2)). Duplicado a propósito en vez
 * de importado desde cash-session-calculator.ts — mismo criterio ya
 * establecido en el repositorio de no acoplar la capa HTTP a la capa de
 * dominio para un patrón puramente textual (>0 vs. >=0 y el máximo de
 * Decimal(14,2) los revalida el dominio, no este DTO).
 */
export const OPENING_AMOUNT_PATTERN = /^\d{1,12}(\.\d{1,2})?$/;

/**
 * Cuerpo de POST /cash-sessions/open (Ticket B, Bloque B2). `userId`/
 * `status`/`openedAt` nunca se aceptan aquí: son valores de sistema
 * fijados por CashSessionsService.open() (actor autenticado, OPEN,
 * now()) — abrir una caja es siempre manual, nunca automática al iniciar
 * sesión.
 */
export class OpenCashSessionDto {
  @ApiProperty({
    type: String,
    description:
      'Decimal no negativo, como texto, máximo 2 decimales. Cero es válido (caja abierta sin fondo inicial); negativo se rechaza (400).',
    example: '100.00',
  })
  @IsString()
  @Matches(OPENING_AMOUNT_PATTERN, {
    message:
      'openingAmount debe ser un decimal no negativo, como texto, con máximo 2 decimales',
  })
  openingAmount!: string;
}
