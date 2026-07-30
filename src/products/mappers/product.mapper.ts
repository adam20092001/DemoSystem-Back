import { Prisma, RoleName } from '@prisma/client';
import {
  SafeProductDetail,
  SafeProductListItem,
  SafeProductSpecification,
} from '../types/safe-product';

/** internalNotes se oculta únicamente a SELLER; el resto de roles autenticados la ve. */
export function canSeeInternalNotes(role: RoleName): boolean {
  return role !== RoleName.SELLER;
}

const CATEGORY_SUMMARY_SELECT = {
  id: true,
  code: true,
  name: true,
} satisfies Prisma.CategorySelect;

const UNIT_SUMMARY_SELECT = {
  id: true,
  code: true,
  name: true,
  abbreviation: true,
  allowDecimal: true,
} satisfies Prisma.UnitSelect;

const SPECIFICATION_SELECT = {
  id: true,
  name: true,
  value: true,
  unit: true,
  sortOrder: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.ProductSpecificationSelect;

/** Select explícito para listados: sin especificaciones ni descripción comercial. */
export const PRODUCT_LIST_SELECT = {
  id: true,
  sku: true,
  name: true,
  brand: true,
  productType: true,
  salePrice: true,
  isInventoryTracked: true,
  stockCurrent: true,
  stockMinimum: true,
  status: true,
  internalNotes: true,
  createdAt: true,
  updatedAt: true,
  category: { select: CATEGORY_SUMMARY_SELECT },
  unit: { select: UNIT_SUMMARY_SELECT },
} satisfies Prisma.ProductSelect;

/** Select explícito para detalle: agrega descripción comercial y especificaciones ordenadas. */
export const PRODUCT_DETAIL_SELECT = {
  ...PRODUCT_LIST_SELECT,
  commercialDescription: true,
  specifications: {
    select: SPECIFICATION_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  },
} satisfies Prisma.ProductSelect;

export type ProductListRow = Prisma.ProductGetPayload<{
  select: typeof PRODUCT_LIST_SELECT;
}>;

export type ProductDetailRow = Prisma.ProductGetPayload<{
  select: typeof PRODUCT_DETAIL_SELECT;
}>;

export type ProductSpecificationRow = Prisma.ProductSpecificationGetPayload<{
  select: typeof SPECIFICATION_SELECT;
}>;

export function toSafeProductSpecification(
  row: ProductSpecificationRow,
): SafeProductSpecification {
  return {
    id: row.id,
    name: row.name,
    value: row.value,
    unit: row.unit,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function toSafeProductListItem(
  row: ProductListRow,
  showInternalNotes: boolean,
): SafeProductListItem {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    brand: row.brand,
    productType: row.productType,
    category: row.category,
    unit: row.unit,
    // Decimal(14,2)/Decimal(14,3) -> string con escala fija, nunca number.
    salePrice: row.salePrice.toFixed(2),
    isInventoryTracked: row.isInventoryTracked,
    stockCurrent: row.stockCurrent.toFixed(3),
    stockMinimum: row.stockMinimum.toFixed(3),
    status: row.status,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    ...(showInternalNotes ? { internalNotes: row.internalNotes } : {}),
  };
}

export function toSafeProductDetail(
  row: ProductDetailRow,
  showInternalNotes: boolean,
): SafeProductDetail {
  return {
    ...toSafeProductListItem(row, showInternalNotes),
    commercialDescription: row.commercialDescription,
    specifications: row.specifications.map(toSafeProductSpecification),
  };
}
