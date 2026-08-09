import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { DocumentType, Prisma } from '@prisma/client';

interface DocumentSequenceRow {
  currentNumber: number;
  prefix: string;
  padding: number;
}

/**
 * Servicio transaccional mínimo de correlativos (Fase 5, Bloque B). `next()`
 * NUNCA abre su propia transacción ni inyecta PrismaService: `tx` es un
 * parámetro obligatorio, siempre la transacción abierta por el llamador
 * (QuotesService hoy; el futuro SalesService, dentro de la transacción de
 * la venta). Esto garantiza que el incremento de la secuencia y la
 * creación del documento (Quote/Sale) confirmen o reviertan juntos.
 *
 * Sin CRUD de administración de secuencias: eso es Fase 10.
 */
@Injectable()
export class DocumentSequenceService {
  /**
   * Incrementa atómicamente la secuencia y devuelve el número formateado.
   * Un único UPDATE ... RETURNING (sin SELECT previo): el propio UPDATE
   * toma el lock de fila y lo mantiene hasta el commit/rollback del
   * llamador, sin ventana entre leer y escribir. current_number representa
   * el ÚLTIMO número emitido, así que el valor devuelto por RETURNING ya es
   * el número a formatear (no el anterior).
   *
   * updated_at se avanza explícitamente en el propio UPDATE: al ser SQL
   * crudo, el `@updatedAt` de Prisma no se aplica automáticamente aquí.
   */
  async next(
    tx: Prisma.TransactionClient,
    documentType: DocumentType,
  ): Promise<string> {
    const rows = await tx.$queryRaw<DocumentSequenceRow[]>(Prisma.sql`
      UPDATE document_sequences
      SET
        current_number = current_number + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE document_type = ${documentType}::"DocumentType"
      RETURNING current_number AS "currentNumber", prefix, padding
    `);

    const row = rows[0];
    if (row === undefined) {
      // Falta de configuración operativa (fila de secuencia inexistente),
      // no un error de validación del cliente: nunca se traduce a 400.
      throw new InternalServerErrorException(
        'No hay una secuencia de documentos configurada para este tipo de documento',
      );
    }

    return `${row.prefix}${String(row.currentNumber).padStart(row.padding, '0')}`;
  }
}
