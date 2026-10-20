import { AccountType, RoleName } from '@prisma/client';

export interface CreateAccountInput {
  code: string;
  name: string;
  type: AccountType;
  /** Omitir para crear una cuenta raíz. */
  parentId?: string;
  /** Por defecto true (una cuenta nueva sin hijos nace postable). */
  isPostable?: boolean;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
