import { RoleName } from '@prisma/client';

/** Entrada común de close()/reopen() (mismo criterio que AccountStatusActionInput). */
export interface AccountingPeriodStatusActionInput {
  periodId: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress: string | null;
}
