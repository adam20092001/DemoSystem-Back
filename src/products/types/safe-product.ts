import { ProductStatus, ProductType } from '@prisma/client';

export interface CategorySummary {
  id: string;
  code: string;
  name: string;
}

export interface UnitSummary {
  id: string;
  code: string;
  name: string;
  abbreviation: string;
  allowDecimal: boolean;
}

export interface SafeProductSpecification {
  id: string;
  name: string;
  value: string;
  unit: string | null;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Forma de producto segura para listados. Los campos Decimal (salePrice,
 * stockCurrent, stockMinimum) viajan como string con escala fija — nunca
 * como instancias de Prisma.Decimal ni como number de JavaScript.
 *
 * internalNotes es opcional a propósito: se omite la clave por completo
 * (no solo su valor) cuando el rol solicitante no debe verla.
 */
export interface SafeProductListItem {
  id: string;
  sku: string;
  name: string;
  brand: string | null;
  productType: ProductType;
  category: CategorySummary;
  unit: UnitSummary;
  salePrice: string;
  isInventoryTracked: boolean;
  stockCurrent: string;
  stockMinimum: string;
  status: ProductStatus;
  createdAt: Date;
  updatedAt: Date;
  internalNotes?: string | null;
}

export interface SafeProductDetail extends SafeProductListItem {
  commercialDescription: string | null;
  specifications: SafeProductSpecification[];
}
