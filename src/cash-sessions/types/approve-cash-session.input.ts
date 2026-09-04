import { RoleName } from '@prisma/client';

export interface ApproveCashSessionInput {
  cashSessionId: string;
  comment?: string | null;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
