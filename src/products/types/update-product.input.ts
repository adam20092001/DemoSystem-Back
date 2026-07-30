import { ProductType } from '@prisma/client';

export interface UpdateProductInput {
  productId: string;
  sku?: string;
  name?: string;
  /** undefined = no tocar; null = limpiar. */
  brand?: string | null;
  productType?: ProductType;
  categoryId?: string;
  unitId?: string;
  salePrice?: string;
  /** undefined = no tocar; null = limpiar. */
  commercialDescription?: string | null;
  /** undefined = no tocar; null = limpiar. */
  internalNotes?: string | null;
  isInventoryTracked?: boolean;
  stockMinimum?: string;
  actorUserId: string;
  ipAddress?: string | null;
}
