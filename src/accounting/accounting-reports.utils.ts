import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { isValidDateOnly } from '../common/date/business-date';
import { NormalBalance } from './account-hierarchy.utils';

/**
 * Validación común de rango de fecha contable para los 3 reportes de A3
 * (Diario/Mayor/Balance de comprobación): formato YYYY-MM-DD real y
 * `from <= to`. Mismo criterio que
 * AccountingService.assertValidDateRangeQuery(), reutilizado aquí en vez
 * de duplicado tres veces.
 */
export function assertValidAccountingDateRange(from: string, to: string): void {
  if (!isValidDateOnly(from)) {
    throw new BadRequestException(
      'accountingDateFrom debe ser una fecha válida en formato YYYY-MM-DD',
    );
  }
  if (!isValidDateOnly(to)) {
    throw new BadRequestException(
      'accountingDateTo debe ser una fecha válida en formato YYYY-MM-DD',
    );
  }
  if (from > to) {
    throw new BadRequestException(
      'accountingDateFrom no puede ser posterior a accountingDateTo',
    );
  }
}

const ZERO = new Prisma.Decimal(0);

/**
 * Saldo neto expresado en la dirección NATURAL de la cuenta (A3.2): crece
 * con el débito si accountNormalBalance()==='DEBIT', con el crédito en
 * caso contrario. Mismo criterio de "naturaleza" ya definido por
 * account-hierarchy.utils.ts — nunca un segundo criterio de signo
 * inventado para los reportes.
 */
export function signedNaturalBalance(
  normalBalance: NormalBalance,
  sumDebit: Prisma.Decimal,
  sumCredit: Prisma.Decimal,
): Prisma.Decimal {
  return normalBalance === 'DEBIT'
    ? sumDebit.minus(sumCredit)
    : sumCredit.minus(sumDebit);
}

/**
 * Reparte un saldo neto (débito - crédito) en las dos columnas de un
 * balance de comprobación (A3.3): nunca según la naturaleza "esperada" de
 * la cuenta (eso ocultaría una cuenta que terminó con el signo contrario
 * al habitual, un dato real que el reporte debe mostrar, no corregir en
 * silencio) — solo según el signo real del saldo. net>0 -> columna débito;
 * net<0 -> columna crédito (valor absoluto); net=0 -> ambas en cero.
 */
export function splitNetBalance(
  sumDebit: Prisma.Decimal,
  sumCredit: Prisma.Decimal,
): { debit: Prisma.Decimal; credit: Prisma.Decimal } {
  const net = sumDebit.minus(sumCredit);
  if (net.greaterThan(0)) {
    return { debit: net, credit: ZERO };
  }
  if (net.lessThan(0)) {
    return { debit: ZERO, credit: net.negated() };
  }
  return { debit: ZERO, credit: ZERO };
}
