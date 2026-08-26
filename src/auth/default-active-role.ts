import { InternalServerErrorException } from '@nestjs/common';
import { RoleName } from '@prisma/client';

/**
 * Orden determinista de selección del rol ACTIVO por defecto al iniciar
 * sesión (KAN-18, Bloque A, §3 del kickoff aprobado — decisión de producto
 * CERRADA). Deliberadamente sesga hacia los roles operativos menos
 * privilegiados: un usuario con ADMIN + SELLER inicia sesión como SELLER,
 * no como ADMIN. Nunca se persiste como "último rol usado": cada login
 * nuevo vuelve a resolver desde cero con este mismo orden fijo.
 *
 * Deliberadamente DISTINTO de ROLE_PRESENTATION_ORDER (user.mapper.ts, solo
 * para mostrar `roles` en las respuestas) — nunca confundir ambos.
 */
const DEFAULT_ACTIVE_ROLE_ORDER: readonly RoleName[] = [
  RoleName.SELLER,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
  RoleName.ADMIN,
];

/**
 * Pura y determinista: dado el conjunto de roles asignados a un usuario,
 * devuelve el único rol activo con el que su sesión debe iniciar. Un
 * usuario sin ningún rol asignado es una violación de la invariante de
 * negocio (todo usuario debe tener uno o más roles) — nunca se inventa un
 * rol por defecto ni se permite continuar el login: falla cerrado con un
 * error interno, igual criterio que otras invariantes de datos violadas en
 * este dominio (p. ej. "configuración de la empresa no inicializada").
 */
export function resolveDefaultActiveRole(
  assignedRoles: readonly RoleName[],
): RoleName {
  for (const candidate of DEFAULT_ACTIVE_ROLE_ORDER) {
    if (assignedRoles.includes(candidate)) {
      return candidate;
    }
  }
  throw new InternalServerErrorException(
    'El usuario no tiene ningún rol asignado; no es posible iniciar sesión',
  );
}
