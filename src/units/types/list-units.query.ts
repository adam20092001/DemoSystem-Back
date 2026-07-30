import { UnitStatus } from '@prisma/client';

export interface ListUnitsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: UnitStatus;
  allowDecimal?: boolean;
}
