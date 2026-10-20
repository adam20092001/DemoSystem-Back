import { AccountType, RoleName } from '@prisma/client';

/**
 * `code` y `systemKey` nunca aparecen aquí: `code` es inmutable después
 * de creada (mismo criterio que PaymentMethod.code); `systemKey` solo se
 * reasigna vía el endpoint dedicado `reassignSystemKey()` (A1.3), nunca
 * mezclado con una edición genérica. `status` tampoco aparece: se
 * administra únicamente vía activate/deactivate (mismo criterio que
 * Category).
 */
export interface UpdateAccountInput {
  accountId: string;
  name?: string;
  /** undefined = no tocar; null = convertir en cuenta raíz. */
  parentId?: string | null;
  /**
   * Bloqueado si la cuenta ya tiene al menos una AccountingEntryLine
   * histórica (A1.2: "protect historically used accounts" — cambiar la
   * naturaleza contable de una cuenta ya usada es un riesgo de
   * integridad, no una simple edición cosmética).
   */
  type?: AccountType;
  isPostable?: boolean;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
