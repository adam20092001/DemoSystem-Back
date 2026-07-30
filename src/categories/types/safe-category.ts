import { CategoryStatus } from '@prisma/client';

/** Forma de categoría segura para salir del dominio. */
export interface SafeCategory {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  status: CategoryStatus;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}
