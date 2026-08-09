import { BadRequestException } from '@nestjs/common';

/**
 * Zona horaria de negocio única del MVP (Fase 5). Toda fecha de negocio
 * (emisión, vigencia, "hoy" para vencimiento) se deriva de aquí, nunca del
 * huso del servidor ni de PostgreSQL (CURRENT_DATE). America/Lima es
 * UTC-5 todo el año (sin horario de verano), lo que hace el cálculo estable
 * y sin casos borde de DST.
 */
const BUSINESS_TIMEZONE = 'America/Lima';

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

const DATE_PART_FORMATTER = new Intl.DateTimeFormat('en-US', {
  timeZone: BUSINESS_TIMEZONE,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * No usa el orden textual del locale (deliberadamente no se asume que
 * 'en-CA' produce YYYY-MM-DD "por accidente"): ensambla el string a mano a
 * partir de formatToParts(), que es estable sin importar el layout del
 * locale elegido.
 */
function requirePart(parts: Intl.DateTimeFormatPart[], type: string): string {
  const found = parts.find((part) => part.type === type);
  if (found === undefined) {
    throw new Error(`No se pudo obtener la parte de fecha "${type}"`);
  }
  return found.value;
}

/** "Hoy" en la zona de negocio (America/Lima), como YYYY-MM-DD. */
export function businessToday(now: Date = new Date()): string {
  const parts = DATE_PART_FORMATTER.formatToParts(now);
  const year = requirePart(parts, 'year');
  const month = requirePart(parts, 'month');
  const day = requirePart(parts, 'day');
  return `${year}-${month}-${day}`;
}

/**
 * Verifica formato Y calendario real: "2026-02-30" y "2023-02-29" (no
 * bisiesto) son rechazados aunque cumplan el patrón YYYY-MM-DD, porque
 * Date.UTC() normaliza el desbordamiento (30 de febrero -> 2 de marzo) y la
 * comparación de vuelta ya no coincide.
 */
export function isValidDateOnly(value: string): boolean {
  if (!DATE_ONLY_PATTERN.test(value)) {
    return false;
  }
  const [yearStr, monthStr, dayStr] = value.split('-');
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);

  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

/**
 * Convierte "YYYY-MM-DD" a un Date en medianoche UTC exacta, la
 * representación que @db.Date de Prisma espera sin desplazamiento de huso.
 * Revalida el formato/calendario aquí (no confía en que el llamador ya lo
 * validó), consistente con el resto del dominio.
 */
export function toPrismaDate(value: string): Date {
  if (!isValidDateOnly(value)) {
    throw new BadRequestException(
      `Fecha inválida: "${value}". Se espera una fecha real en formato YYYY-MM-DD.`,
    );
  }
  const [year, month, day] = value.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, day));
}

/**
 * Formatea un Date proveniente de una columna @db.Date usando componentes
 * UTC (nunca locales): es lo que previene el corrimiento de día que
 * getFullYear()/getMonth()/getDate() introducirían en un huso con offset
 * negativo como America/Lima.
 */
export function fromPrismaDate(date: Date): string {
  const year = String(date.getUTCFullYear()).padStart(4, '0');
  const month = String(date.getUTCMonth() + 1).padStart(2, '0');
  const day = String(date.getUTCDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Vencida únicamente cuando expirationDate < businessDate (igualdad =
 * vigente, sin semántica de hora). La comparación lexicográfica de strings
 * "YYYY-MM-DD" coincide con el orden cronológico, así que no hace falta
 * aritmética de fechas.
 */
export function isExpired(
  expirationDate: Date | string,
  businessDate: string,
): boolean {
  const expirationDateOnly =
    typeof expirationDate === 'string'
      ? expirationDate
      : fromPrismaDate(expirationDate);
  return expirationDateOnly < businessDate;
}
