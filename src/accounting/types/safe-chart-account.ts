import {
  AccountStatus,
  AccountType,
  AccountingSystemKey,
} from '@prisma/client';
import { NormalBalance } from '../account-hierarchy.utils';

/**
 * Forma segura de una cuenta del plan de cuentas JERÁRQUICO (Fase A1 —
 * PCGE), expuesta por el recurso NUEVO `/chart-of-accounts`. Distinta a
 * propósito de `SafeAccount` (src/accounting/types/safe-account.ts, Fase
 * 8, GET /accounts): esa sigue siendo el contrato histórico y acotado de
 * "las seis cuentas de sistema", esta es el plan de cuentas completo
 * (jerárquico, con o sin mapeo). `normalBalance` es un campo DERIVADO
 * (nunca persistido, ver accountNormalBalance()) — mismo criterio que
 * `stockStatus` en NR-04.
 */
export interface SafeChartAccount {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: AccountingSystemKey | null;
  parentId: string | null;
  level: number;
  isPostable: boolean;
  status: AccountStatus;
  normalBalance: NormalBalance;
  createdAt: Date;
  updatedAt: Date;
}
