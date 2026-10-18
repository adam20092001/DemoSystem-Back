import { NotFoundException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../common/types/authenticated-user';

/**
 * Policy de propiedad de cotizaciones (permisos por vendedor, P6-B1).
 *
 * Mismo patrón que `src/sales/sale-access.policy.ts`: funciones puras, sin
 * acceso a base de datos ni inyección de dependencias, que los servicios
 * aplican dentro de sus propias consultas Prisma y transacciones. No
 * reemplaza a RolesGuard (que decide qué rol puede invocar cada endpoint);
 * esta policy decide sobre QUÉ cotizaciones.
 *
 * El propietario es siempre `Quote.sellerId`. Reglas:
 * - SELLER: solo lee (P6-B1) y, cuando se integre en P6-B2, opera sus
 *   propias cotizaciones.
 * - ADMIN: lee todas; opera las que sus guards/controllers ya le permiten.
 * - MANAGEMENT: lectura completa; ninguna autorización de operación.
 * - WAREHOUSE y cualquier rol no contemplado: sin acceso (falla cerrado).
 *
 * Identidad y rol salen SIEMPRE del usuario autenticado (id + rol ACTIVO
 * revalidados por JwtAuthGuard), nunca de datos enviados por el cliente.
 */

export type QuoteAccessRequester = Pick<AuthenticatedUser, 'id' | 'role'>;

export type QuoteReadScope =
  | { readonly kind: 'NONE' }
  | { readonly kind: 'ALL' }
  | { readonly kind: 'OWN'; readonly sellerId: string };

/** Mensaje único de 404 de lectura: cotización inexistente o ajena. */
export const QUOTE_NOT_FOUND_MESSAGE = 'Cotización no encontrada';

export function resolveQuoteReadScope(
  requester: QuoteAccessRequester,
): QuoteReadScope {
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
 * Condición Prisma obligatoria del alcance de lectura: `null` = sin acceso,
 * `{}` = sin restricción, `{ sellerId: requester.id }` para SELLER.
 */
export function quoteReadScopeWhere(
  requester: QuoteAccessRequester,
): Prisma.QuoteWhereInput | null {
  const scope = resolveQuoteReadScope(requester);
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
 * Alcance obligatorio AND filtros solicitados: ningún filtro (otro
 * `sellerId`, su omisión o un OR anidado) amplía el alcance. `null` si el
 * solicitante no tiene acceso de lectura.
 */
export function applyQuoteReadScope(
  requester: QuoteAccessRequester,
  requested: Prisma.QuoteWhereInput,
): Prisma.QuoteWhereInput | null {
  const scopeWhere = quoteReadScopeWhere(requester);
  if (scopeWhere === null) {
    return null;
  }
  if (Object.keys(scopeWhere).length === 0) {
    return requested;
  }
  return { AND: [scopeWhere, requested] };
}

export function canReadQuote(
  requester: QuoteAccessRequester,
  quoteSellerId: string,
): boolean {
  const scope = resolveQuoteReadScope(requester);
  switch (scope.kind) {
    case 'ALL':
      return true;
    case 'OWN':
      return scope.sellerId === quoteSellerId;
    case 'NONE':
    default:
      return false;
  }
}

/**
 * Permiso de operación (editar/aceptar/rechazar/convertir), separado de la
 * lectura: MANAGEMENT lee pero nunca opera. Preparado para P6-B2; todavía
 * NO se conecta a ninguna mutación productiva.
 */
export function canOperateQuote(
  requester: QuoteAccessRequester,
  quoteSellerId: string,
): boolean {
  switch (requester.role) {
    case RoleName.ADMIN:
      return true;
    case RoleName.SELLER:
      return requester.id === quoteSellerId;
    case RoleName.MANAGEMENT:
    case RoleName.WAREHOUSE:
    default:
      return false;
  }
}

/** 404 (nunca 403) si la cotización no es legible para el solicitante. */
export function assertCanReadQuote(
  requester: QuoteAccessRequester,
  quoteSellerId: string,
  notFoundMessage: string = QUOTE_NOT_FOUND_MESSAGE,
): void {
  if (!canReadQuote(requester, quoteSellerId)) {
    throw new NotFoundException(notFoundMessage);
  }
}

/** 404 si la cotización no es operable (preparado para P6-B2). */
export function assertCanOperateQuote(
  requester: QuoteAccessRequester,
  quoteSellerId: string,
  notFoundMessage: string = QUOTE_NOT_FOUND_MESSAGE,
): void {
  if (!canOperateQuote(requester, quoteSellerId)) {
    throw new NotFoundException(notFoundMessage);
  }
}
