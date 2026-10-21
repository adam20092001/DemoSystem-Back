import { BadRequestException } from '@nestjs/common';
import {
  businessToday,
  isValidDateOnly,
  toPrismaDate,
} from '../common/date/business-date';

export interface AccountingDateParts {
  accountingDate: Date;
  year: number;
  month: number;
}

/**
 * Deriva la fecha contable de un instante factual ya persistido
 * (Sale.confirmedAt/Payment.paidAt, o el instante de una anulación) en la
 * zona de negocio del MVP (Fase A2.2). Reutiliza exactamente
 * businessToday()/toPrismaDate() de common/date/business-date.ts —
 * America/Lima, UTC-5 fijo todo el año, sin horario de verano — en vez de
 * inventar un segundo cálculo de huso horario paralelo al ya usado por los
 * filtros de rango de AccountingService.listEntries().
 */
export function resolveAccountingDateParts(
  postedAt: Date,
): AccountingDateParts {
  const dateOnly = businessToday(postedAt);
  const [year, month] = dateOnly.split('-').map(Number);
  return {
    accountingDate: toPrismaDate(dateOnly),
    year,
    month,
  };
}

/**
 * Fase A4.4: a diferencia de resolveAccountingDateParts() (que DERIVA la
 * fecha contable de un instante real, nunca controlado por el cliente —
 * A2.2), un asiento manual recibe su fecha contable YA como fecha
 * calendario explícita, elegida por el ACCOUNTANT/ADMIN al crear el
 * borrador. Esta función solo valida y parsea ese valor — nunca
 * reinterpreta un huso horario, porque no hay ningún instante del que
 * derivar nada.
 */
export function parseAccountingDateOnly(dateOnly: string): AccountingDateParts {
  if (!isValidDateOnly(dateOnly)) {
    throw new BadRequestException(
      `accountingDate debe ser una fecha real en formato YYYY-MM-DD: "${dateOnly}"`,
    );
  }
  const [year, month] = dateOnly.split('-').map(Number);
  return {
    accountingDate: toPrismaDate(dateOnly),
    year,
    month,
  };
}
