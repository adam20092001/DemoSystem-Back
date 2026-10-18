import { NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * Policy de propiedad de ventas (permisos por vendedor, P1).
 *
 * Funciones puras, sin acceso a base de datos ni inyección de dependencias,
 * pensadas para que los servicios las apliquen DENTRO de sus propias
 * consultas Prisma y transacciones (mismo patrón que `hasSaleReadAccess` en
 * SalesService). No reemplaza a RolesGuard: el guard sigue decidiendo qué
 * rol puede invocar cada endpoint; esta policy decide sobre QUÉ ventas.
 *
 * Reglas (decisión confirmada del cliente):
 * - SELLER: solo lee y opera ventas propias (`Sale.sellerId === requester.id`).
 * - ADMIN: lee todas; opera las que sus guards/controllers ya le permiten.
 * - MANAGEMENT: conserva la lectura completa vigente y NO obtiene permisos
 *   de operación (su política definitiva queda pendiente).
 * - WAREHOUSE y cualquier rol no contemplado: sin acceso (falla cerrado).
 *
 * La identidad y el rol salen SIEMPRE del usuario autenticado (`id` y rol
 * ACTIVO de la sesión, revalidados por JwtAuthGuard en cada request); nunca
 * de un `sellerId` o rol enviados por el cliente.
 */

/** Identidad mínima requerida: el usuario autenticado de la request. */
export type SaleAccessRequester = Pick<AuthenticatedUser, 'id' | 'role'>;

/** Alcance de lectura resuelto para un solicitante. */
export type SaleReadScope =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'ALL' }
  | { readonly kind: 'OWN'; readonly sellerId: string };

/** Mensaje único para cualquier venta inexistente o ajena (sin revelar existencia). */
export const SALE_NOT_FOUND_MESSAGE = 'Venta no encontrada';

export function resolveSaleReadScope(
  requester: SaleAccessRequester,
): SaleReadScope {
  switch (requester.role) {
    case RoleName.ADMIN:
    case RoleName.MANAGEMENT:
      return { kind: 'ALL' };
    case RoleName.SELLER:
      return { kind: 'OWN', sellerId: requester.id };
    case RoleName.WAREHOUSE:
    default:
      return { kind: 'NONE' };
  }
}

/**
 * Condición Prisma obligatoria del alcance de lectura. `null` = sin acceso
 * (el servicio debe responder vacío/404 sin consultar). `{}` = sin
 * restricción. Para SELLER, siempre `{ sellerId: requester.id }`.
 */
export function saleReadScopeWhere(
  requester: SaleAccessRequester,
): Prisma.SaleWhereInput | null {
  const scope = resolveSaleReadScope(requester);
  switch (scope.kind) {
    case 'ALL':
      return {};
    case 'OWN':
      return { sellerId: scope.sellerId };
    case 'NONE':
    default:
      return null;
  }
}

/**
 * Combina el alcance obligatorio con los filtros solicitados mediante AND:
 * ningún filtro del cliente (p. ej. otro `sellerId`, o su omisión) puede
 * ampliar el alcance. Un `sellerId` ajeno pedido por un SELLER produce una
 * condición insatisfacible (lista vacía), nunca un error que revele datos.
 * Devuelve `null` si el solicitante no tiene acceso de lectura.
 */
export function applySaleReadScope(
  requester: SaleAccessRequester,
  requested: Prisma.SaleWhereInput,
): Prisma.SaleWhereInput | null {
  const scopeWhere = saleReadScopeWhere(requester);
  if (scopeWhere === null) {
    return null;
  }
  if (Object.keys(scopeWhere).length === 0) {
    return requested;
  }
  return { AND: [scopeWhere, requested] };
}

/** ¿Puede leer la venta cuyo vendedor persistido es `saleSellerId`? */
export function canReadSale(
  requester: SaleAccessRequester,
  saleSellerId: string,
): boolean {
  const scope = resolveSaleReadScope(requester);
  switch (scope.kind) {
    case 'ALL':
      return true;
    case 'OWN':
      return scope.sellerId === saleSellerId;
    case 'NONE':
    default:
      return false;
  }
}

/**
 * ¿Puede operar (cobrar, cambiar entrega, etc.) la venta cuyo vendedor
 * persistido es `saleSellerId`? Separado de la lectura a propósito: que
 * MANAGEMENT lea una venta no lo habilita a modificarla. Para ADMIN solo
 * significa "sin restricción de propiedad": qué operación concreta puede
 * invocar lo siguen decidiendo RolesGuard y los controllers.
 */
export function canOperateSale(
  requester: SaleAccessRequester,
  saleSellerId: string,
): boolean {
  switch (requester.role) {
    case RoleName.ADMIN:
      return true;
    case RoleName.SELLER:
      return requester.id === saleSellerId;
    case RoleName.MANAGEMENT:
    case RoleName.WAREHOUSE:
    default:
      return false;
  }
}

/**
 * Lanza 404 si la venta no es legible para el solicitante (nunca 403).
 * `notFoundMessage` permite usar el MISMO mensaje que el servicio llamador
 * ya devuelve para una venta inexistente, de modo que ajena e inexistente
 * sean indistinguibles en ese endpoint.
 */
export function assertCanReadSale(
  requester: SaleAccessRequester,
  saleSellerId: string,
  notFoundMessage: string = SALE_NOT_FOUND_MESSAGE,
): void {
  if (!canReadSale(requester, saleSellerId)) {
    throw new NotFoundException(notFoundMessage);
  }
}

/**
 * Lanza 404 si la venta no es operable por el solicitante: una venta ajena
 * responde igual que una inexistente (mismo criterio de `notFoundMessage`).
 * Pensada para invocarse dentro de la transacción, con el `sellerId` leído
 * de la fila ya bloqueada.
 */
export function assertCanOperateSale(
  requester: SaleAccessRequester,
  saleSellerId: string,
  notFoundMessage: string = SALE_NOT_FOUND_MESSAGE,
): void {
  if (!canOperateSale(requester, saleSellerId)) {
    throw new NotFoundException(notFoundMessage);
  }
}
