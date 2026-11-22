import { Prisma } from '@prisma/client';
import { SafeWarehouse, SafeWarehouseLocation } from '../types/warehouse.types';

/** Única fuente de verdad para la forma segura de Warehouse. */
export const WAREHOUSE_SAFE_SELECT = {
  id: true,
  code: true,
  name: true,
  description: true,
  status: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WarehouseSelect;

export type WarehouseSafeRow = Prisma.WarehouseGetPayload<{
  select: typeof WAREHOUSE_SAFE_SELECT;
}>;

export function toSafeWarehouse(row: WarehouseSafeRow): SafeWarehouse {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Única fuente de verdad para la forma segura de WarehouseLocation. */
export const LOCATION_SAFE_SELECT = {
  id: true,
  warehouseId: true,
  code: true,
  name: true,
  description: true,
  status: true,
  isDefault: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.WarehouseLocationSelect;

export type LocationSafeRow = Prisma.WarehouseLocationGetPayload<{
  select: typeof LOCATION_SAFE_SELECT;
}>;

export function toSafeLocation(row: LocationSafeRow): SafeWarehouseLocation {
  return {
    id: row.id,
    warehouseId: row.warehouseId,
    code: row.code,
    name: row.name,
    description: row.description,
    status: row.status,
    isDefault: row.isDefault,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}
