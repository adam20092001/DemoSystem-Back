import { Prisma, RoleName } from '@prisma/client';
import { AuthenticatedUser } from '../../common/types/authenticated-user';
import { SafeUser } from '../types/safe-user';

/**
 * Orden estable de PRESENTACIÓN (KAN-18, Bloque A, §12 del kickoff
 * aprobado): únicamente para ordenar el arreglo `roles` en las respuestas
 * de usuario. Deliberadamente DISTINTO del orden de selección del rol
 * ACTIVO por defecto al iniciar sesión (SELLER > WAREHOUSE > MANAGEMENT >
 * ADMIN, ver default-active-role.ts) — nunca confundir ambos.
 */
const ROLE_PRESENTATION_ORDER: readonly RoleName[] = [
  RoleName.ADMIN,
  RoleName.MANAGEMENT,
  RoleName.WAREHOUSE,
  RoleName.SELLER,
];

/** Ordena un conjunto de roles asignados según ROLE_PRESENTATION_ORDER. */
export function sortRolesForPresentation(
  roles: readonly RoleName[],
): RoleName[] {
  return [...roles].sort(
    (a, b) =>
      ROLE_PRESENTATION_ORDER.indexOf(a) - ROLE_PRESENTATION_ORDER.indexOf(b),
  );
}

/**
 * Select explícito: única fuente de verdad de qué sale de la base de datos
 * hacia el dominio. passwordHash, failedLoginAttempts, blockedAt y
 * roleId/role_id quedan fuera desde la consulta, no por filtrado
 * posterior. KAN-18: `roles` reemplaza a la relación singular `role` —
 * trae la colección completa de UserRole con el nombre de cada Role ya
 * resuelto, en una sola consulta (sin N+1), reutilizada tanto para el
 * usuario "seguro" persistente (SafeUser, roles asignados) como para el
 * actor de sesión (AuthenticatedUser, un único rol activo — ver
 * JwtAuthGuard, que es el único otro consumidor de este mismo select).
 */
export const USER_WITH_ROLES_SELECT = {
  id: true,
  firstName: true,
  lastName: true,
  username: true,
  email: true,
  status: true,
  mustChangePassword: true,
  lastLoginAt: true,
  createdAt: true,
  updatedAt: true,
  roles: { select: { role: { select: { name: true } } } },
} satisfies Prisma.UserSelect;

export type UserWithRoles = Prisma.UserGetPayload<{
  select: typeof USER_WITH_ROLES_SELECT;
}>;

/** Extrae los nombres de rol asignados de una fila UserWithRoles, sin orden particular. */
export function assignedRoleNames(user: UserWithRoles): RoleName[] {
  return user.roles.map((userRole) => userRole.role.name);
}

/** true si el usuario tiene el rol dado entre sus roles asignados (nunca desde el JWT). */
export function hasAssignedRole(
  user: UserWithRoles,
  roleName: RoleName,
): boolean {
  return user.roles.some((userRole) => userRole.role.name === roleName);
}

/**
 * Forma persistente/administrativa: `roles` es la colección completa de
 * roles asignados, en orden de presentación estable.
 */
export function toSafeUser(user: UserWithRoles): SafeUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    roles: sortRolesForPresentation(assignedRoleNames(user)),
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

/**
 * Forma de sesión/actor de request: `role` es el único rol ACTIVO ya
 * validado por el llamador (JwtAuthGuard) contra la colección de roles
 * asignados — este mapper nunca decide ni valida cuál es válido, solo
 * construye la forma final a partir del valor ya verificado.
 */
export function toAuthenticatedUser(
  user: UserWithRoles,
  activeRole: RoleName,
): AuthenticatedUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    role: activeRole,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
