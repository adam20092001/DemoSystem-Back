import { ApiProperty } from '@nestjs/swagger';
import { CashSessionStatus } from '@prisma/client';

/**
 * Forma segura de una CashSession (Ticket B post-MVP, Bloque B2). `userId`
 * es la única referencia al dueño — nunca un User completo (sin
 * email/password/rol). Usada tanto para POST /open, GET /current, GET
 * /:id como cada fila de GET /cash-sessions.
 */
export class CashSessionResponseDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty({ format: 'uuid', description: 'Dueño de la caja.' })
  userId!: string;

  @ApiProperty({ enum: CashSessionStatus })
  status!: CashSessionStatus;

  @ApiProperty({
    type: String,
    description: 'Decimal con 2 decimales fijos, como string.',
    example: '100.00',
  })
  openingAmount!: string;

  @ApiProperty({ type: String, format: 'date-time' })
  openedAt!: Date;

  @ApiProperty({
    type: String,
    format: 'date-time',
    nullable: true,
    description:
      'NULL mientras OPEN. Poblado desde un bloque de negocio posterior (Ticket B, Bloque B3): B2 nunca lo escribe.',
  })
  closeRequestedAt!: Date | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Decimal con 2 decimales fijos, como string. NULL mientras OPEN; B2 nunca lo calcula (Bloque B3).',
  })
  expectedCashAmount!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Decimal con 2 decimales fijos, como string. NULL mientras OPEN.',
  })
  countedCashAmount!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Decimal con 2 decimales fijos, como string. NULL mientras OPEN.',
  })
  differenceAmount!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    maxLength: 500,
  })
  closingObservation!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  closedAt!: Date | null;

  @ApiProperty({
    format: 'uuid',
    nullable: true,
    description:
      'Solo poblado para un cierre con descuadre finalmente aprobado (Bloque B3). NULL para un cierre sin descuadre y mientras PENDING_APPROVAL.',
  })
  approvedByUserId!: string | null;

  @ApiProperty({ type: String, format: 'date-time', nullable: true })
  approvedAt!: Date | null;

  @ApiProperty({ type: String, nullable: true, maxLength: 500 })
  approvalComment!: string | null;

  @ApiProperty()
  createdAt!: Date;

  @ApiProperty()
  updatedAt!: Date;
}

/** Respuesta paginada del historial de CashSessions (GET /cash-sessions). */
export class PaginatedCashSessionsResponseDto {
  @ApiProperty({ type: [CashSessionResponseDto] })
  data!: CashSessionResponseDto[];

  @ApiProperty()
  page!: number;

  @ApiProperty()
  limit!: number;

  @ApiProperty()
  total!: number;

  @ApiProperty()
  totalPages!: number;
}
