import { CategoryStatus } from '@prisma/client';

export interface ListCategoriesQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: CategoryStatus;
  parentId?: string;
}
