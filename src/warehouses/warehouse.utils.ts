import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';

/** Código técnico reservado de la ubicación predeterminada de cada almacén. */
export const DEFAULT_LOCATION_CODE = 'DEFAULT';

export const WAREHOUSE_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,19}$/;
export const LOCATION_CODE_PATTERN = /^[A-Z0-9][A-Z0-9_-]{0,29}$/;

export const DEFAULT_PAGE = 1;
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 100;

/**
 * Lectura del catálogo (R2-A1, D15): ADMIN, WAREHOUSE, MANAGEMENT y SELLER
 * (para elegir origen en ventas, más adelante). Cualquier otro rol —incluidos
 * PURCHASING y ACCOUNTANT— queda en 403.
 */
export const READ_ROLES: ReadonlySet<RoleName> = new Set([
  RoleName.ADMIN,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
  RoleName.SELLER,
  RoleName.PURCHASING,
]);

/** Administración del catálogo: exclusiva de ADMIN. */
export const MANAGE_ROLES: ReadonlySet<RoleName> = new Set([RoleName.ADMIN]);

export function assertCanRead(role: RoleName): void {
  if (!READ_ROLES.has(role)) {
    throw new ForbiddenException(
      'No tiene permisos para consultar almacenes y ubicaciones',
    );
  }
}

export function assertCanManage(role: RoleName): void {
  if (!MANAGE_ROLES.has(role)) {
    throw new ForbiddenException(
      'No tiene permisos para administrar almacenes y ubicaciones',
    );
  }
}

/** trim + mayúsculas: la misma normalización que exige el CHECK de la base. */
export function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase();
}

export function normalizeWarehouseCode(raw: string): string {
  const code = normalizeCode(raw);
  if (!WAREHOUSE_CODE_PATTERN.test(code)) {
    throw new BadRequestException(
      'El código del almacén debe tener 1 a 20 caracteres (letras, números, guion o guion bajo) y empezar por letra o número',
    );
  }
  return code;
}

export function normalizeLocationCode(raw: string): string {
  const code = normalizeCode(raw);
  if (!LOCATION_CODE_PATTERN.test(code)) {
    throw new BadRequestException(
      'El código de la ubicación debe tener 1 a 30 caracteres (letras, números, guion o guion bajo) y empezar por letra o número',
    );
  }
  return code;
}

export function normalizeRequiredName(raw: string): string {
  const name = raw.trim();
  if (name.length === 0) {
    throw new BadRequestException('El nombre no puede estar vacío');
  }
  return name;
}

/** Cadena vacía o solo espacios equivale a "sin descripción". */
export function normalizeOptionalDescription(
  raw: string | null | undefined,
): string | null {
  if (raw === undefined || raw === null) {
    return null;
  }
  const text = raw.trim();
  return text.length === 0 ? null : text;
}

export interface Pagination {
  page: number;
  limit: number;
  skip: number;
}

export function resolvePagination(query: {
  page?: number;
  limit?: number;
}): Pagination {
  const page =
    query.page !== undefined && query.page > 0
      ? Math.floor(query.page)
      : DEFAULT_PAGE;
  const limit = Math.min(
    query.limit !== undefined && query.limit > 0
      ? Math.floor(query.limit)
      : DEFAULT_LIMIT,
    MAX_LIMIT,
  );
  return { page, limit, skip: (page - 1) * limit };
}

/**
 * ¿Existe alguna dependencia que impida desactivar estas ubicaciones?
 *
 * R2-A1 (EXPAND): los saldos por ubicación NO son todavía la fuente de verdad
 * del stock (esa sigue siendo Product.stockCurrent, consolidado), así que no
 * puede PROBARSE que una ubicación carezca de existencias consultando solo
 * stock_balances. Por eso se bloquea ante cualquier rastro: un saldo distinto
 * de cero o cualquier movimiento, línea de venta o línea de recepción que la
 * referencie. Nunca se asume "stock cero" sin evidencia.
 */
export async function hasLocationDependencies(
  tx: Prisma.TransactionClient,
  locationIds: readonly string[],
): Promise<boolean> {
  if (locationIds.length === 0) {
    return false;
  }
  const ids = [...locationIds];
  const [balances, movements, saleItems, receiptLines] = await Promise.all([
    tx.stockBalance.count({
      where: { locationId: { in: ids }, quantity: { not: 0 } },
    }),
    tx.inventoryMovement.count({ where: { locationId: { in: ids } } }),
    tx.saleItem.count({ where: { locationId: { in: ids } } }),
    tx.purchaseReceiptLine.count({ where: { locationId: { in: ids } } }),
  ]);
  return balances + movements + saleItems + receiptLines > 0;
}

export const DEACTIVATION_BLOCKED_MESSAGE =
  'No se puede desactivar: existen saldos, movimientos u otras dependencias asociadas, o no puede comprobarse la ausencia de stock';
