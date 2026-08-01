import { Prisma } from '@prisma/client';
import { SafeCategory } from '../types/safe-category';

/** Select explícito: única fuente de verdad de qué sale hacia el dominio. */
export const CATEGORY_SAFE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  parentId: true,
  status: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.CategorySelect;

export type CategoryRow = Prisma.CategoryGetPayload<{
  select: typeof CATEGORY_SAFE_SELECT;
}>;

export function toSafeCategory(category: CategoryRow): SafeCategory {
  return {
    id: category.id,
    code: category.code,
    name: category.name,
    description: category.description,
    parentId: category.parentId,
    status: category.status,
    sortOrder: category.sortOrder,
    createdAt: category.createdAt,
    updatedAt: category.updatedAt,
  };
}
