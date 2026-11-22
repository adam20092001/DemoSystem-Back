import { RoleName, WarehouseStatus } from '@prisma/client';

/** Forma segura de Warehouse expuesta hacia afuera. */
export interface SafeWarehouse {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: WarehouseStatus;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

/** Forma segura de WarehouseLocation expuesta hacia afuera. */
export interface SafeWarehouseLocation {
  id: string;
  warehouseId: string;
  code: string;
  name: string;
  description: string | null;
  status: WarehouseStatus;
  isDefault: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface ListWarehousesQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: WarehouseStatus;
}

export interface ListLocationsQuery {
  page?: number;
  limit?: number;
  search?: string;
  status?: WarehouseStatus;
}

/** Campos comunes de toda operación de escritura. */
interface ActorContext {
  /** Rol ACTIVO del solicitante: el servicio lo revalida, independiente de @Roles(). */
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}

export interface CreateWarehouseInput extends ActorContext {
  code: string;
  name: string;
  description?: string;
}

/** code, status e isDefault son inmutables aquí (ver WarehousesService). */
export interface UpdateWarehouseInput extends ActorContext {
  warehouseId: string;
  name?: string;
  /** null limpia la descripción. */
  description?: string | null;
}

export interface WarehouseActionInput extends ActorContext {
  warehouseId: string;
}

export interface CreateLocationInput extends ActorContext {
  warehouseId: string;
  code: string;
  name: string;
  description?: string;
}

export interface UpdateLocationInput extends ActorContext {
  warehouseId: string;
  locationId: string;
  name?: string;
  description?: string | null;
}

export interface LocationActionInput extends ActorContext {
  warehouseId: string;
  locationId: string;
}
