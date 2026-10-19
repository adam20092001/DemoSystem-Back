import { StreamableFile } from '@nestjs/common';

/** Tipo MIME correcto de un .xlsx real (OOXML) — nunca text/csv. */
export const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

/**
 * NR-06: envoltura HTTP común para los 4 endpoints de exportación.
 * `baseFileName` es SIEMPRE un literal fijo por controller (nunca un valor
 * controlado por el usuario), así que el nombre de archivo resultante es
 * seguro por construcción — sin necesidad de sanitizar ningún carácter.
 */
export function excelFileResponse(
  buffer: Buffer,
  baseFileName: string,
): StreamableFile {
  const datePart = new Date().toISOString().slice(0, 10);
  const fileName = `${baseFileName}-${datePart}.xlsx`;
  return new StreamableFile(buffer, {
    type: XLSX_CONTENT_TYPE,
    disposition: `attachment; filename="${fileName}"`,
    length: buffer.length,
  });
}
