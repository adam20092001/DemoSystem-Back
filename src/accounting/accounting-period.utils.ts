import { businessToday, toPrismaDate } from '../common/date/business-date';

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
