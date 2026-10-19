/**
 * NR-06: mitigación de inyección de fórmulas en Excel/CSV (recomendación
 * OWASP). Un valor de texto controlado por el usuario (nombre de cliente,
 * SKU, marca, etc.) que comience — tras descontar espacios simples
 * iniciales — con uno de estos caracteres puede ejecutarse como fórmula al
 * abrir el archivo en Excel/Sheets/Calc: `=`, `+`, `-`, `@`, tabulador o
 * retorno de carro. Se neutraliza anteponiendo una comilla simple `'` al
 * valor ORIGINAL (nunca al recortado): Excel la interpreta como "forzar
 * texto" y no la muestra.
 *
 * Solo se aplica a columnas de tipo texto/identificador — nunca a celdas
 * numéricas o de fecha (PURA, sin acceso a Excel real): un monto negativo
 * legítimo (-150.00) se escribe siempre como number, nunca pasa por aquí.
 */
const DANGEROUS_LEADING_CHARS = new Set(['=', '+', '-', '@', '\t', '\r']);

export function sanitizeExcelString(value: string): string {
  // Solo se descuentan espacios simples (" ") antes de decidir: un
  // tabulador o retorno de carro inicial es en sí mismo uno de los
  // caracteres peligrosos listados, no un espacio en blanco a ignorar.
  const withoutLeadingSpaces = value.replace(/^ +/, '');
  const firstChar = withoutLeadingSpaces.charAt(0);
  if (DANGEROUS_LEADING_CHARS.has(firstChar)) {
    return `'${value}`;
  }
  return value;
}
