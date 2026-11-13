import { businessToday, fromPrismaDate } from '../../common/date/business-date';

export const PERIOD_PATTERN = /^\d{4}(0[1-9]|1[0-2])$/;

export function isValidPeriod(value: string): boolean {
  return PERIOD_PATTERN.test(value);
}

/** Primer y último día (YYYY-MM-DD) del periodo YYYYMM. */
export function periodBounds(period: string): { first: string; last: string } {
  const year = Number(period.slice(0, 4));
  const month = Number(period.slice(4, 6));
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  const mm = period.slice(4, 6);
  return {
    first: `${period.slice(0, 4)}-${mm}-01`,
    last: `${period.slice(0, 4)}-${mm}-${String(lastDay).padStart(2, '0')}`,
  };
}

export function periodOfDateOnly(dateOnly: string): string {
  return `${dateOnly.slice(0, 4)}${dateOnly.slice(5, 7)}`;
}

/**
 * REGLA DEMO PROVISIONAL (RVIE): el periodo es el mes de la fecha de emisión
 * en America/Lima. La relación oficial entre el campo "periodo" y la fecha de
 * emisión no pudo verificarse en las copias públicas de los anexos de SUNAT.
 */
export function rviePeriodOf(issuedAt: Date): string {
  return periodOfDateOnly(businessToday(issuedAt));
}

/**
 * REGLA DEMO PROVISIONAL (RCE): el periodo es el mes de la FECHA CONTABLE
 * (accountingDate). Los anexos oficiales del RCE no estaban accesibles; la
 * alternativa evaluada era registrationDate. Aislada en una sola función para
 * poder cambiarla sin tocar el resto del módulo.
 */
export function rcePeriodOf(accountingDate: Date): string {
  return periodOfDateOnly(fromPrismaDate(accountingDate));
}

export const RVIE_PERIOD_RULE = 'issueDate (America/Lima) - PROVISIONAL (DEMO)';
export const RCE_PERIOD_RULE = 'accountingDate - PROVISIONAL (DEMO)';
