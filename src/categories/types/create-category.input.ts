export interface CreateCategoryInput {
  code: string;
  name: string;
  description?: string;
  parentId?: string;
  sortOrder?: number;
  actorUserId: string;
  ipAddress?: string | null;
}
