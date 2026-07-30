const DEFAULT_FILE_NAME = 'imagen';
const MAX_LENGTH = 255;

/**
 * Sanea un nombre de archivo original para conservarlo únicamente como
 * información descriptiva (nunca se usa para construir la ruta física en
 * disco, que siempre genera el backend). Elimina separadores de ruta,
 * caracteres de control y segmentos ".." que habiliten path traversal.
 */
export function sanitizeFileName(original: string | undefined | null): string {
  if (original === undefined || original === null) {
    return DEFAULT_FILE_NAME;
  }

  const withoutSeparators = original.replace(/[/\\]/g, '_');
  // eslint-disable-next-line no-control-regex -- se eliminan deliberadamente caracteres de control.
  const withoutControlChars = withoutSeparators.replace(/[\x00-\x1f\x7f]/g, '');
  const withoutTraversalSegments = withoutControlChars.replace(/\.{2,}/g, '_');
  const trimmed = withoutTraversalSegments.trim();

  return trimmed.length > 0 ? trimmed.slice(0, MAX_LENGTH) : DEFAULT_FILE_NAME;
}

/**
 * Neutraliza comillas en un nombre ya saneado antes de insertarlo dentro del
 * valor de la cabecera Content-Disposition, para que no pueda romper su
 * sintaxis ("...").
 */
export function toContentDisposition(fileName: string): string {
  return fileName.replace(/"/g, "'");
}
