import { RoleName, UserStatus } from '@prisma/client';

/**
 * Campos base compartidos entre la forma persistente/administrativa
 * (SafeUser, KAN-18: roles asignados) y la forma de sesión/actor de
 * request (AuthenticatedUser, en common/types: un único rol activo). Nunca
 * incluye passwordHash, failedLoginAttempts ni roleId/role_id.
 */
export interface SafeUserBase {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

/**
 * Forma de usuario segura para la administración persistente (Users CRUD).
 * KAN-18, Bloque A: `role` (singular) se reemplaza por `roles` (uno o más,
 * el conjunto completo de roles asignados) — nunca confundir con el rol
 * ACTIVO de una sesión, que vive únicamente en AuthenticatedUser.
 */
export interface SafeUser extends SafeUserBase {
  roles: RoleName[];
}
