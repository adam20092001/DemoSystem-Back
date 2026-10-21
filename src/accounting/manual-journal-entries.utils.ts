import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { assertLinesBalanced } from './accounting-calculator';

/**
 * Fase A4.3: traduce exactamente la misma validación de cuadre que
 * assertLinesBalanced() (reutilizada sin duplicar ni reimplementar la
 * aritmética) a BadRequestException (400) — para un asiento MANUAL, un
 * borrador desbalanceado es un error de ENTRADA legítimo del ACCOUNTANT,
 * nunca una corrupción interna del servidor (que es lo que
 * assertLinesBalanced() asume para SALE/PAYMENT, donde el cliente nunca
 * construye líneas). Si por algún motivo esta traducción NO detectara un
 * desbalance real (no debería ocurrir: es la misma función), el motor
 * (AccountingEngine.postManualEntry()) vuelve a llamar a
 * assertLinesBalanced() sin traducir, como defensa en profundidad final.
 */
export function assertManualDraftLinesBalanced(
  lines: ReadonlyArray<{
    debitAmount: Prisma.Decimal;
    creditAmount: Prisma.Decimal;
  }>,
): void {
  try {
    assertLinesBalanced(lines);
  } catch (error) {
    if (error instanceof InternalServerErrorException) {
      throw new BadRequestException(error.message);
    }
    throw error;
  }
}

/**
 * Valida y parsea los montos de UNA línea de borrador (Fase A4.2/A4.3).
 * Replica exactamente los dos únicos invariantes que también protege el
 * CHECK de base de datos de `manual_journal_draft_lines` (nunca negativo,
 * nunca ambos lados positivos a la vez) — para que una violación llegue
 * como un 400 claro en vez de depender de la traducción genérica de un
 * error crudo de PostgreSQL. Deliberadamente NO exige "exactamente un
 * lado positivo" (0/0 es válido en un borrador: una línea todavía sin
 * llenar, A4.2) — esa exigencia más estricta es exclusiva del momento de
 * contabilizar (A4.3), ya cubierta por assertManualDraftLinesBalanced()/
 * AccountingEngine.postManualEntry().
 */
export function parseManualDraftLineAmounts(line: {
  debitAmount: string;
  creditAmount: string;
}): { debitAmount: Prisma.Decimal; creditAmount: Prisma.Decimal } {
  let debitAmount: Prisma.Decimal;
  let creditAmount: Prisma.Decimal;
  try {
    debitAmount = new Prisma.Decimal(line.debitAmount);
    creditAmount = new Prisma.Decimal(line.creditAmount);
  } catch {
    throw new BadRequestException(
      'debitAmount y creditAmount deben ser números decimales válidos',
    );
  }
  if (debitAmount.lessThan(0) || creditAmount.lessThan(0)) {
    throw new BadRequestException(
      'debitAmount y creditAmount no pueden ser negativos',
    );
  }
  if (debitAmount.greaterThan(0) && creditAmount.greaterThan(0)) {
    throw new BadRequestException(
      'Una línea no puede tener debitAmount y creditAmount positivos a la vez',
    );
  }
  return { debitAmount, creditAmount };
}
