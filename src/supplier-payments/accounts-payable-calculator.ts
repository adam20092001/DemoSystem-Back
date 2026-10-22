import { Prisma } from '@prisma/client';

/**
 * Categoría de antigüedad de deuda (Fase A5.4), derivada SIEMPRE en tiempo
 * de lectura a partir de `dueDate` — nunca persistida. `NO_DUE_DATE` es la
 * clasificación explícita para una factura sin fecha de vencimiento (nunca
 * se asume vencida automáticamente, ni se infiere un plazo por defecto).
 */
export type AgingBucket =
  | 'NOT_OVERDUE'
  | 'OVERDUE_1_30'
  | 'OVERDUE_31_60'
  | 'OVERDUE_61_90'
  | 'OVERDUE_90_PLUS'
  | 'NO_DUE_DATE';

export const AGING_BUCKET_ORDER: readonly AgingBucket[] = [
  'NOT_OVERDUE',
  'OVERDUE_1_30',
  'OVERDUE_31_60',
  'OVERDUE_61_90',
  'OVERDUE_90_PLUS',
  'NO_DUE_DATE',
];

/**
 * Diferencia en días de calendario entre dos fechas YYYY-MM-DD (copia del
 * dominio, mismo criterio exacto que daysBetweenDateOnly en
 * payments/receivable-calculator.ts): comparación por componentes de
 * calendario, nunca aritmética de milisegundos sobre un instante real.
 * Puede ser negativo (vencimiento todavía en el futuro) — a diferencia de
 * calculateDaysOutstanding, aquí el signo es información útil para decidir
 * el bucket, nunca se recorta a 0 en este paso.
 */
export function calculateDaysOverdue(dueDate: string, today: string): number {
  const [dueYear, dueMonth, dueDay] = dueDate.split('-').map(Number);
  const [todayYear, todayMonth, todayDay] = today.split('-').map(Number);
  const dueUtc = Date.UTC(dueYear, dueMonth - 1, dueDay);
  const todayUtc = Date.UTC(todayYear, todayMonth - 1, todayDay);
  return Math.round((todayUtc - dueUtc) / (24 * 60 * 60 * 1000));
}

/**
 * Clasifica una factura por antigüedad de deuda a partir de SU `dueDate` y
 * la fecha de negocio `today` — siempre la fecha VIGENTE (nunca una fecha
 * de corte histórica reconstruida, ver limitación documentada en
 * AccountsPayableService.getAging()). `dueDate=null` -> NO_DUE_DATE
 * siempre, nunca NOT_OVERDUE ni vencida: no existe un plazo que evaluar.
 * `daysOverdue` se recorta a 0 cuando todavía no vence (información de
 * "cuántos días vencida", nunca "cuántos días faltan").
 */
export function computeAgingBucket(
  dueDate: string | null,
  today: string,
): { bucket: AgingBucket; daysOverdue: number | null } {
  if (dueDate === null) {
    return { bucket: 'NO_DUE_DATE', daysOverdue: null };
  }
  const days = calculateDaysOverdue(dueDate, today);
  if (days <= 0) {
    return { bucket: 'NOT_OVERDUE', daysOverdue: 0 };
  }
  if (days <= 30) {
    return { bucket: 'OVERDUE_1_30', daysOverdue: days };
  }
  if (days <= 60) {
    return { bucket: 'OVERDUE_31_60', daysOverdue: days };
  }
  if (days <= 90) {
    return { bucket: 'OVERDUE_61_90', daysOverdue: days };
  }
  return { bucket: 'OVERDUE_90_PLUS', daysOverdue: days };
}

/** `part/total` como porcentaje, 2 decimales, como texto. '0.00' si total es 0 (nunca división por cero). */
export function calculatePercentage(
  part: Prisma.Decimal,
  total: Prisma.Decimal,
): string {
  if (total.lessThanOrEqualTo(0)) {
    return '0.00';
  }
  return part.dividedBy(total).times(100).toFixed(2);
}
