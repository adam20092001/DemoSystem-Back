/**
 * NR-06: tipo de columna de una exportación .xlsx. Decide el formato de
 * celda y si el valor pasa por sanitizeExcelString() (solo 'string' e
 * 'identifier' — nunca 'number'/'date'/'boolean', que nunca pueden ser
 * fórmulas y deben conservarse como celdas nativas de Excel).
 *
 * 'identifier': texto que debe conservar ceros a la izquierda (número de
 * documento, SKU) — se escribe como string (nunca como number) y con
 * formato de celda "Texto" (@) para que Excel no lo reinterprete.
 */
export type ExcelColumnType =
  'string' | 'identifier' | 'number' | 'date' | 'boolean';

export interface ExcelColumn<T> {
  /** Clave interna estable (nunca el texto visible): evita colisiones si dos encabezados coinciden. */
  key: string;
  /** Encabezado visible, en español, legible para quien abre el archivo. */
  header: string;
  type: ExcelColumnType;
  /** Ancho de columna en caracteres aproximados; 18 por defecto si se omite. */
  width?: number;
  /** Extrae el valor crudo de la fila. null se escribe como celda vacía. */
  value: (row: T) => string | number | Date | boolean | null;
}
