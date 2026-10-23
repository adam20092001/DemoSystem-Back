import { RoleName } from '@prisma/client';

/**
 * Los roles del sistema son un enum de Prisma (`RoleName`), no registros
 * dinámicos en una tabla — este tipo nunca duplica esos valores a mano:
 * `UsersService.listRoles()` siempre los deriva de `Object.values(RoleName)`.
 * `name` es el identificador estable (el propio valor del enum, el mismo
 * que ya usa `@Roles()`/`roleNames` en el resto de la API) para un selector
 * de Angular. Sin `label`: no existe hoy ninguna fuente de nombres
 * descriptivos para los roles en este backend.
 */
export interface RoleOption {
  name: RoleName;
}
