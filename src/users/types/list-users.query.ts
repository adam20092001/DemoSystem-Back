import { RoleName, UserStatus } from '@prisma/client';

export interface ListUsersQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: UserStatus;
  roleName?: RoleName;
}

export interface PaginatedResult<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
