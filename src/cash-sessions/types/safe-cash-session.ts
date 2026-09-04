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

/**
 * Una fila del desglose por método (Ticket B, Bloque B3), ya con
 * totalAmount como string de 2 decimales fijos. Usada tanto para el
 * desglose EN VIVO (liveBreakdownByMethod, solo mientras OPEN) como para el
 * desglose CONGELADO (breakdownByMethod, snapshot de
 * CashSessionPaymentMethodSummary, solo PENDING_APPROVAL/CLOSED) — misma
 * forma en ambos casos, origen de datos distinto.
 */
export interface SafeCashSessionMethodBreakdownRow {
  paymentMethodId: string;
  paymentMethodCode: string;
  paymentMethodName: string;
  totalAmount: string;
}

/**
 * Forma enriquecida de CashSession para GET /cash-sessions/current y GET
 * /cash-sessions/:id (Ticket B, Bloque B3) — NUNCA para el historial
 * paginado (GET /cash-sessions), que se mantiene liviano a propósito (§25
 * del plan aprobado: sin desglose por fila para evitar N+1).
 *
 * Exactamente uno de los dos pares de campos está poblado según el estado,
 * nunca ambos a la vez:
 *  - OPEN: live* recalculado en cada lectura a partir de los Payment ACTIVE
 *    vinculados vigentes (nunca persistido); breakdownByMethod es null
 *    (todavía no existe ningún intento de cierre).
 *  - PENDING_APPROVAL / CLOSED: live* es null (el campo persistido
 *    `expectedCashAmount` de SafeCashSession ya es la fuente de verdad
 *    congelada); breakdownByMethod son las filas YA PERSISTIDAS de
 *    CashSessionPaymentMethodSummary en el instante del cierre — nunca
 *    recalculadas desde el estado actual de Payment (§26/§27 del plan
 *    aprobado: un Payment cancelado después del cierre nunca altera este
 *    snapshot).
 */
export interface SafeCashSessionDetail extends SafeCashSession {
  liveCollectionsTotal: string | null;
  liveCashCollectionsTotal: string | null;
  liveExpectedCashAmount: string | null;
  liveBreakdownByMethod: SafeCashSessionMethodBreakdownRow[] | null;
  breakdownByMethod: SafeCashSessionMethodBreakdownRow[] | null;
}
