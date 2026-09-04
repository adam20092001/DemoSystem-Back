import { RoleName } from '@prisma/client';

/**
 * `userId`/`status`/`openedAt` deliberadamente AUSENTES (Ticket B, Bloque
 * B2 §5): el servidor los fija siempre — el caller nunca puede abrir una
 * caja a nombre de otro usuario, ni fabricar su estado/instante inicial.
 */
export interface OpenCashSessionInput {
  openingAmount: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
