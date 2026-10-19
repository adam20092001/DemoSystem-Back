import type { Response } from 'superagent';

/**
 * NR-06: supertest/superagent no reconoce el tipo MIME de un .xlsx
 * (application/vnd.openxmlformats-officedocument.spreadsheetml.sheet) como
 * binario por defecto, así que `.buffer(true)` por sí solo no basta —
 * intenta decodificarlo como texto y `response.body` queda vacío. Este
 * parser fuerza la lectura binaria explícita (igual que descargar un
 * archivo real), concatenando los chunks en un Buffer exacto.
 */
export function binaryParser(
  res: Response,
  callback: (error: Error | null, body: Buffer) => void,
): void {
  const chunks: Buffer[] = [];
  res.on('data', (chunk: Buffer) => chunks.push(chunk));
  res.on('end', () => callback(null, Buffer.concat(chunks)));
}
