import { ProductType } from '@prisma/client';

/** salePrice y stockMinimum llegan como string: el servicio los convierte a Prisma.Decimal. */
export interface CreateProductInput {
  sku: string;
  name: string;
  brand?: string;
  productType: ProductType;
  categoryId: string;
  unitId: string;
  salePrice: string;
  commercialDescription?: string;
  internalNotes?: string;
  isInventoryTracked: boolean;
  stockMinimum?: string;
  actorUserId: string;
  ipAddress?: string | null;
}
