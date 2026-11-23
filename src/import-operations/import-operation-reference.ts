import { InternalServerErrorException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

const REFERENCE_PREFIX = 'IMP';
const NUMBER_PADDING = 6;
/** Tope del correlativo anual (6 dígitos): millones de operaciones por año. */
const MAX_ANNUAL_NUMBER = 999_999;

/** IMP-AAAA-000001 */
export function formatImportOperationReference(
  year: number,
  sequence: number,
): string {
  return `${REFERENCE_PREFIX}-${year}-${String(sequence).padStart(NUMBER_PADDING, '0')}`;
}

/** Año calendario (zona de negocio) de una fecha `YYYY-MM-DD`. */
export function yearOfBusinessDate(businessDate: string): number {
  return Number(businessDate.slice(0, 4));
}

/**
 * Siguiente número del correlativo ANUAL de operaciones de importación.
 *
 * Un único `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` dentro de la
 * transacción de creación: dos solicitudes simultáneas se serializan por la
 * fila del año (la segunda espera al commit de la primera) y, como la fila
 * forma parte de la transacción, un rollback devuelve el número (sin huecos).
 * Nunca MAX()+1. Cada año nuevo reinicia en 1 al insertarse su fila.
 */
export async function nextImportOperationNumber(
  tx: Prisma.TransactionClient,
  year: number,
): Promise<number> {
  const rows = await tx.$queryRaw<{ lastNumber: number }[]>(Prisma.sql`
    INSERT INTO import_operation_sequences (year, last_number)
    VALUES (${year}, 1)
    ON CONFLICT (year) DO UPDATE
      SET last_number = import_operation_sequences.last_number + 1
    RETURNING last_number AS "lastNumber"
  `);
  const next = rows[0]?.lastNumber;
  if (next === undefined) {
    throw new InternalServerErrorException(
      'No se pudo generar el correlativo de la operación de importación',
    );
  }
  if (next > MAX_ANNUAL_NUMBER) {
    throw new InternalServerErrorException(
      `Se agotó el correlativo anual de operaciones de importación del año ${year}`,
    );
  }
  return next;
}
