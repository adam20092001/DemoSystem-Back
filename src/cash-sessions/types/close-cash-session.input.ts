import { RoleName } from '@prisma/client';

/**
 * `cashSessionId`/`userId` deliberadamente AUSENTES (Ticket B, Bloque B3
 * §3): la ruta siempre opera sobre la caja sin resolver del actor
 * autenticado — nunca una `cashSessionId` arbitraria del body. El servidor
 * la resuelve internamente por `actorUserId`.
 */
export interface CloseCashSessionInput {
  countedCashAmount: string;
  closingObservation?: string | null;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
