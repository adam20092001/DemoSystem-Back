import { RoleName } from '@prisma/client';

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  temporaryPassword: string;
  roleName: RoleName;
  /** Quién realiza la acción, para auditoría. */
  actorUserId: string;
  ipAddress?: string | null;
}
