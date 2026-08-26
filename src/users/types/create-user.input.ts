import { RoleName } from '@prisma/client';

export interface CreateUserInput {
  firstName: string;
  lastName: string;
  username: string;
  email: string;
  temporaryPassword: string;
  /** Uno o más roles a asignar (KAN-18, Bloque A). Mínimo uno, sin duplicados. */
  roleNames: RoleName[];
  /** Quién realiza la acción, para auditoría. */
  actorUserId: string;
  ipAddress?: string | null;
}
