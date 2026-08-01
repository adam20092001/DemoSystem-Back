import { Prisma, RoleName } from '@prisma/client';
import { SafeProductImage } from '../types/safe-product-image';
import {
  SafeProductDetail,
  SafeProductListItem,
  SafeProductSpecification,
} from '../types/safe-product';

function buildProductImageFileUrl(productId: string, imageId: string): string {
  return `/api/v1/products/${productId}/images/${imageId}/file`;
}

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

/** Nunca incluye storagePath: es lo único que garantiza que jamás viaje al cliente. */
const IMAGE_SELECT = {
  id: true,
  fileName: true,
  mimeType: true,
  fileSize: true,
  sortOrder: true,
  isPrimary: true,
  createdAt: true,
} satisfies Prisma.ProductImageSelect;

/** Solo la imagen principal (a lo sumo una, garantizado por el índice único parcial). */
const PRIMARY_IMAGE_SELECT = {
  where: { isPrimary: true },
  select: IMAGE_SELECT,
  take: 1,
} satisfies Prisma.Product$imagesArgs;

/** Detalle: todas las imágenes, principal primero. */
const ALL_IMAGES_SELECT = {
  select: IMAGE_SELECT,
  orderBy: [{ isPrimary: 'desc' }, { sortOrder: 'asc' }, { createdAt: 'asc' }],
} satisfies Prisma.Product$imagesArgs;

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
  images: PRIMARY_IMAGE_SELECT,
} satisfies Prisma.ProductSelect;

/** Select explícito para detalle: agrega descripción comercial, especificaciones e imágenes ordenadas. */
export const PRODUCT_DETAIL_SELECT = {
  ...PRODUCT_LIST_SELECT,
  commercialDescription: true,
  specifications: {
    select: SPECIFICATION_SELECT,
    orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }],
  },
  images: ALL_IMAGES_SELECT,
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

export type ProductImageRow = Prisma.ProductImageGetPayload<{
  select: typeof IMAGE_SELECT;
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

export function toSafeProductImage(
  row: ProductImageRow,
  productId: string,
): SafeProductImage {
  return {
    id: row.id,
    fileName: row.fileName,
    mimeType: row.mimeType,
    fileSize: row.fileSize,
    sortOrder: row.sortOrder,
    isPrimary: row.isPrimary,
    createdAt: row.createdAt,
    fileUrl: buildProductImageFileUrl(productId, row.id),
  };
}

export function toSafeProductListItem(
  row: ProductListRow,
  showInternalNotes: boolean,
): SafeProductListItem {
  const primaryImageRow = row.images[0];
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
    primaryImage:
      primaryImageRow !== undefined
        ? toSafeProductImage(primaryImageRow, row.id)
        : null,
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
    images: row.images.map((image) => toSafeProductImage(image, row.id)),
  };
}
