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

/**
 * Medianoche de un día de negocio en America/Lima, expresada como el
 * instante UTC exacto (Fase 6, Bloque B: filtros de rango sobre
 * Sale.confirmedAt, que es un instante real, no @db.Date como Quote). Como
 * America/Lima es UTC-5 fijo todo el año (ver BUSINESS_TIMEZONE arriba), la
 * medianoche de cualquier día de negocio corresponde siempre a las 05:00 UTC
 * del mismo día calendario — sin necesidad de resolver el offset en tiempo
 * de ejecución ni de manejar casos de horario de verano.
 */
const LIMA_UTC_OFFSET_HOURS = 5;

/**
 * Instante UTC exacto del inicio (00:00:00.000) del día de negocio
 * `dateOnly` en America/Lima. Límite inferior INCLUSIVO al filtrar por un
 * instante real: `confirmedAt >= startOfBusinessDayUtc(desde)`.
 */
export function startOfBusinessDayUtc(dateOnly: string): Date {
  if (!isValidDateOnly(dateOnly)) {
    throw new BadRequestException(
      `Fecha inválida: "${dateOnly}". Se espera una fecha real en formato YYYY-MM-DD.`,
    );
  }
  const [year, month, day] = dateOnly.split('-').map(Number);
  return new Date(
    Date.UTC(year, month - 1, day, LIMA_UTC_OFFSET_HOURS, 0, 0, 0),
  );
}

/**
 * Instante UTC exacto del inicio del día de negocio SIGUIENTE a `dateOnly`
 * en America/Lima. Límite superior EXCLUSIVO al filtrar por un instante
 * real: `confirmedAt < endOfBusinessDayExclusiveUtc(hasta)`, de modo que
 * todo el día `dateOnly` completo queda incluido sin comparar contra una
 * marca de tiempo ambigua (p. ej. "23:59:59.999"). Un día de negocio en
 * America/Lima dura exactamente 24 horas (sin horario de verano), así que
 * sumar 24h en milisegundos al inicio del día es exacto.
 */
export function endOfBusinessDayExclusiveUtc(dateOnly: string): Date {
  const start = startOfBusinessDayUtc(dateOnly);
  return new Date(start.getTime() + 24 * 60 * 60 * 1000);
}
