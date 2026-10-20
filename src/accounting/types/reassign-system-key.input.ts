import { AccountingSystemKey, RoleName } from '@prisma/client';

/**
 * A1.3 — capacidad técnica de reasignación de mapeo, NUNCA ejercida
 * automáticamente por A1 (ver docblock de
 * ChartOfAccountsService.reassignSystemKey()). Mueve `systemKey` de la
 * cuenta que lo sostiene hoy hacia `targetAccountId`, dentro de una única
 * transacción; nunca toca AccountingEntryLine.accountId de ningún asiento
 * histórico.
 */
export interface ReassignSystemKeyInput {
  systemKey: AccountingSystemKey;
  targetAccountId: string;
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
