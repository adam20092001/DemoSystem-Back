import { AccountStatus, AccountType } from '@prisma/client';

export interface ListChartAccountsQuery {
  page?: number;
  limit?: number;
  search?: string;
  type?: AccountType;
  status?: AccountStatus;
  isPostable?: boolean;
  /** `null` filtra explícitamente las cuentas raíz (sin padre). */
  parentId?: string | null;
}
