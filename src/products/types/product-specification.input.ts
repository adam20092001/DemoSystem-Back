export interface CreateProductSpecificationInput {
  productId: string;
  name: string;
  value: string;
  unit?: string;
  sortOrder?: number;
  actorUserId: string;
  ipAddress?: string | null;
}

export interface UpdateProductSpecificationInput {
  productId: string;
  specificationId: string;
  name?: string;
  value?: string;
  /** undefined = no tocar; null = limpiar. */
  unit?: string | null;
  sortOrder?: number;
  actorUserId: string;
  ipAddress?: string | null;
}

export interface DeleteProductSpecificationInput {
  productId: string;
  specificationId: string;
  actorUserId: string;
  ipAddress?: string | null;
}
