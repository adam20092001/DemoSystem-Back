import { businessToday } from '../common/date/business-date';

/**
 * Diferencia en días de calendario entre dos fechas YYYY-MM-DD, comparadas
 * como componentes de calendario (nunca aritmética de milisegundos sobre
 * instantes reales, que se rompería con DST — irrelevante aquí porque
 * America/Lima es UTC-5 fijo, pero el criterio se mantiene uniforme con el
 * resto del dominio de fechas de negocio).
 */
function daysBetweenDateOnly(from: string, to: string): number {
  const [fromYear, fromMonth, fromDay] = from.split('-').map(Number);
  const [toYear, toMonth, toDay] = to.split('-').map(Number);
  const fromUtc = Date.UTC(fromYear, fromMonth - 1, fromDay);
  const toUtc = Date.UTC(toYear, toMonth - 1, toDay);
  return Math.round((toUtc - fromUtc) / (24 * 60 * 60 * 1000));
}

/**
 * Días de calendario transcurridos entre la fecha de negocio America/Lima
 * de `confirmedAt` (un instante real, no @db.Date) y `today` (por defecto,
 * businessToday() — nunca CURRENT_DATE del servidor/BD). No es una medida
 * de mora contra una fecha de vencimiento: no existe dueDate en el MVP: es
 * simplemente "cuántos días de calendario lleva pendiente esta venta".
 * Nunca negativo: una `confirmedAt` futura/corrupta se recorta a 0 en vez
 * de propagar un valor engañoso.
 */
export function calculateDaysOutstanding(
  confirmedAt: Date,
  today: string = businessToday(),
): number {
  const confirmedBusinessDate = businessToday(confirmedAt);
  const diff = daysBetweenDateOnly(confirmedBusinessDate, today);
  return diff < 0 ? 0 : diff;
}
