import { AccountingPeriodStatus } from '@prisma/client';

export interface ListAccountingPeriodsQuery {
  page?: number;
  limit?: number;
  year?: number;
  status?: AccountingPeriodStatus;
}
