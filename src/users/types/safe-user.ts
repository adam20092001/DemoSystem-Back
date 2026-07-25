import { RoleName, UserStatus } from '@prisma/client';

/**
 * Forma de usuario segura para salir del dominio: nunca incluye
 * passwordHash, failedLoginAttempts, blockedAt ni roleId. El rol se expone
 * por nombre, no por su identificador interno.
 */
export interface SafeUser {
  id: string;
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  role: RoleName;
  status: UserStatus;
  mustChangePassword: boolean;
  lastLoginAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}
