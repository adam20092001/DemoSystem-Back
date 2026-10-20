/**
 * Mismo criterio que toStrictBoolean(): un query param de texto no tiene
 * forma nativa de representar `null` (siempre llega como string). Una
 * cadena literal "null" se convierte en el `null` real; cualquier otro
 * valor pasa intacto para que el resto de la cadena de validadores decida.
 */
export function nullStringToNull({ value }: { value: unknown }): unknown {
  if (value === 'null') {
    return null;
  }
  return value;
}
