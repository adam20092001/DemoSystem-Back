import { ProductStatus, ProductType } from '@prisma/client';

export interface ListProductsQuery {
  page?: number;
  limit?: number;
  search?: string;
  categoryId?: string;
  unitId?: string;
  productType?: ProductType;
  status?: ProductStatus;
  isInventoryTracked?: boolean;
}
