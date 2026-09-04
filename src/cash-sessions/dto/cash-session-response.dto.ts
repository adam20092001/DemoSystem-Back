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

/** Una fila del desglose por método (Ticket B, Bloque B3) — mismo shape para el desglose en vivo y el congelado. */
export class CashSessionMethodBreakdownRowResponseDto {
  @ApiProperty({ format: 'uuid' })
  paymentMethodId!: string;

  @ApiProperty({ example: 'CASH' })
  paymentMethodCode!: string;

  @ApiProperty({ example: 'Efectivo' })
  paymentMethodName!: string;

  @ApiProperty({
    type: String,
    description: 'Decimal con 2 decimales fijos, como string.',
    example: '200.00',
  })
  totalAmount!: string;
}

/**
 * Forma enriquecida para GET /cash-sessions/current y GET
 * /cash-sessions/:id (Ticket B, Bloque B3) — nunca para el historial
 * paginado. Exactamente uno de los dos pares (live-* y breakdownByMethod)
 * está poblado según el estado: OPEN usa live-* (recalculado en cada
 * lectura, nunca persistido); PENDING_APPROVAL/CLOSED usa
 * breakdownByMethod (snapshot congelado de CashSessionPaymentMethodSummary
 * en el instante del cierre, jamás recalculado desde el estado actual de
 * Payment).
 */
export class CashSessionDetailResponseDto extends CashSessionResponseDto {
  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Suma de TODOS los Payment ACTIVE vinculados (cualquier método). Solo mientras OPEN; null en PENDING_APPROVAL/CLOSED (usar el snapshot congelado).',
  })
  liveCollectionsTotal!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'Suma de los Payment ACTIVE vinculados cuyo snapshot paymentMethodAffectsCashDrawer=true. Solo mientras OPEN.',
  })
  liveCashCollectionsTotal!: string | null;

  @ApiProperty({
    type: String,
    nullable: true,
    description:
      'openingAmount + liveCashCollectionsTotal, recalculado en cada lectura. Solo mientras OPEN — NUNCA el mismo campo que el `expectedCashAmount` persistido/congelado una vez que la sesión entra a PENDING_APPROVAL o CLOSED.',
  })
  liveExpectedCashAmount!: string | null;

  @ApiProperty({
    type: [CashSessionMethodBreakdownRowResponseDto],
    nullable: true,
    description:
      'Desglose EN VIVO por método a partir de los Payment ACTIVE vinculados vigentes. Solo mientras OPEN; null en PENDING_APPROVAL/CLOSED.',
  })
  liveBreakdownByMethod!: CashSessionMethodBreakdownRowResponseDto[] | null;

  @ApiProperty({
    type: [CashSessionMethodBreakdownRowResponseDto],
    nullable: true,
    description:
      'Desglose CONGELADO (CashSessionPaymentMethodSummary) en el instante del cierre. null mientras OPEN (todavía no existe ningún intento de cierre); nunca recalculado desde Payment tras el cierre, ni siquiera si un Payment vinculado se anula después.',
  })
  breakdownByMethod!: CashSessionMethodBreakdownRowResponseDto[] | null;
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
