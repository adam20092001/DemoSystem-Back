import { AccountType, AccountingSystemKey } from '@prisma/client';

/**
 * Forma segura de una cuenta del plan de cuentas básico (Fase 8, Bloque C).
 * Sin createdAt (sin caso de uso real: las seis cuentas son fijas e
 * inmutables en este MVP — plan final aprobado), sin status/balance/
 * metadata interna.
 */
export interface SafeAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: AccountingSystemKey;
}
