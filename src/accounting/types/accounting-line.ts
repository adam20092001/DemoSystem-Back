import { AccountingSystemKey, Prisma } from '@prisma/client';

/**
 * Línea contable PURA, previa a resolver la cuenta real (accountId): la
 * construye accounting-calculator.ts a partir de montos de negocio, y
 * AccountingEngine la resuelve a un accountId concreto vía systemKey (nunca
 * por nombre/UUID hardcodeado — plan final aprobado, §7). Exactamente un
 * lado positivo; el otro siempre 0 explícito (nunca ambos indefinidos).
 */
export interface AccountingLineInput {
  systemKey: AccountingSystemKey;
  debitAmount: Prisma.Decimal;
  creditAmount: Prisma.Decimal;
}

/**
 * Línea ya resuelta a su accountId real, tal como vive en
 * AccountingEntryLine. Usada para invertir las líneas de un asiento
 * ORIGINAL al construir su REVERSAL (plan final aprobado, §22): la
 * inversión reutiliza el MISMO accountId ya persistido, nunca vuelve a
 * resolver por systemKey.
 */
export interface ResolvedAccountingLine {
  accountId: string;
  debitAmount: Prisma.Decimal;
  creditAmount: Prisma.Decimal;
}
