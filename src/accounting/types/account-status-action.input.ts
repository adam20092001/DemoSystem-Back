import { RoleName } from '@prisma/client';

export interface AccountStatusActionInput {
  accountId: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
