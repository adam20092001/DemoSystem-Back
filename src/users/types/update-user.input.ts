import { RoleName } from '@prisma/client';

/**
 * Solo estos cuatro campos pueden modificarse por esta vía. username,
 * passwordHash, status, mustChangePassword, failedLoginAttempts y
 * lastLoginAt tienen sus propios flujos (bloqueo, reset, cambio de clave).
 * KAN-18, Bloque A: roleName (singular) se reemplaza por roleNames, con
 * semántica de reemplazo total (ver UpdateUserDto). undefined = no tocar
 * los roles asignados.
 */
export interface UpdateUserInput {
  userId: string;
  firstName?: string;
  lastName?: string;
  email?: string;
  roleNames?: RoleName[];
  actorUserId: string;
  ipAddress?: string | null;
}
