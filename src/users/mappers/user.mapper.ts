import { Prisma } from '@prisma/client';
import { SafeUser } from '../types/safe-user';

/**
 * Select explícito: es la única fuente de verdad de qué sale de la base de
 * datos hacia el dominio. passwordHash, failedLoginAttempts, blockedAt y
 * roleId quedan fuera desde la consulta, no por filtrado posterior.
 */
export const USER_SAFE_SELECT = {
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
  role: { select: { name: true } },
} satisfies Prisma.UserSelect;

export type UserWithRoleName = Prisma.UserGetPayload<{
  select: typeof USER_SAFE_SELECT;
}>;

export function toSafeUser(user: UserWithRoleName): SafeUser {
  return {
    id: user.id,
    firstName: user.firstName,
    lastName: user.lastName,
    username: user.username,
    email: user.email,
    role: user.role.name,
    status: user.status,
    mustChangePassword: user.mustChangePassword,
    lastLoginAt: user.lastLoginAt,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}
