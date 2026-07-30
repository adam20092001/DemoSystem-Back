/**
 * A diferencia de @Type(() => Boolean), esto no convierte "false" (string no
 * vacío) en true. Mismo defecto ya corregido en env.validation.ts, aplicado
 * aquí a filtros de query string que representan booleanos.
 */
export function toStrictBoolean({ value }: { value: unknown }): unknown {
  if (value === 'true' || value === true) {
    return true;
  }
  if (value === 'false' || value === false) {
    return false;
  }
  return value;
}
