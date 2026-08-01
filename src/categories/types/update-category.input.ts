export interface UpdateCategoryInput {
  categoryId: string;
  code?: string;
  name?: string;
  /** undefined = no tocar; null = limpiar la descripción. */
  description?: string | null;
  /** undefined = no tocar; null = convertir en categoría raíz. */
  parentId?: string | null;
  sortOrder?: number;
  actorUserId: string;
  ipAddress?: string | null;
}
