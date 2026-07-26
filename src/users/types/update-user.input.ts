import { RoleName } from '@prisma/client';

/**
 * Solo estos cuatro campos pueden modificarse por esta vía. username,
 * passwordHash, status, mustChangePassword, failedLoginAttempts y
 * lastLoginAt tienen sus propios flujos (bloqueo, reset, cambio de clave).
 */
export interface UpdateUserInput {
  userId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  roleName?: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
