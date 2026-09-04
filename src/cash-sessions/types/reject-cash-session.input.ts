import { RoleName } from '@prisma/client';

export interface RejectCashSessionInput {
  cashSessionId: string;
  reason: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
