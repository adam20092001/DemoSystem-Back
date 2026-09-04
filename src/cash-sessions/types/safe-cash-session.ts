import { CashSessionStatus } from '@prisma/client';

/**
 * Forma segura de una CashSession (Ticket B post-MVP, Bloque B2) expuesta
 * por POST /cash-sessions/open, GET /cash-sessions/current, GET
 * /cash-sessions y GET /cash-sessions/:id. `userId` es la única referencia
 * al dueño — nunca un User completo (sin email/password/rol, ver
 * mappers/cash-session.mapper.ts). `approvedByUserId` es igualmente un ID
 * plano, sin objeto de revisor anidado: B2 es lectura/apertura únicamente,
 * ningún flujo todavía puebla estos campos de aprobación (eso llega en el
 * Bloque B3).
 *
 * Todos los montos son Decimal(14,2) serializados como string de 2
 * decimales fijos, nunca number (mismo criterio que SafePayment). Los
 * campos del snapshot de cierre (closeRequestedAt en adelante) son
 * nullable a propósito: B2 nunca los puebla, pero el tipo ya los declara
 * para que B3 no tenga que rediseñar el contrato de lectura (ver §15 del
 * plan aprobado: "B2 read/list/detail debe entender PENDING_APPROVAL desde
 * ya").
 */
export interface SafeCashSession {
  id: string;
  userId: string;
  status: CashSessionStatus;

  openingAmount: string;
  openedAt: Date;

  closeRequestedAt: Date | null;
  expectedCashAmount: string | null;
  countedCashAmount: string | null;
  differenceAmount: string | null;
  closingObservation: string | null;

  closedAt: Date | null;

  approvedByUserId: string | null;
  approvedAt: Date | null;
  approvalComment: string | null;

  createdAt: Date;
  updatedAt: Date;
}
