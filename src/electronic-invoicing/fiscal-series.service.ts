import {
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { FiscalDocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { MAX_FISCAL_NUMBER } from './constants/electronic-invoicing.constants';
import { ListFiscalSeriesQuery } from './types/list-fiscal-series.query';
import { SafeFiscalSeries } from './types/safe-fiscal-series';

/** Resultado de una asignación exitosa: el número YA es el que corresponde emitir. */
export interface FiscalNumberAllocation {
  fiscalSeriesId: string;
  number: number;
}

interface FiscalSeriesUpdateRow {
  id: string;
  currentNumber: number;
}

interface FiscalSeriesLookupRow {
  active: boolean;
  currentNumber: number;
}

/**
 * Asignación concurrency-safe de números fiscales (Bloque 11C §16/§17).
 * `allocateNext()` NUNCA abre su propia transacción ni inyecta
 * PrismaService: `tx` es siempre la transacción del llamador
 * (ElectronicDocumentsService.issue(), dentro de la transacción de
 * creación del documento fiscal) — mismo criterio que
 * DocumentSequenceService.next() (Fase 5, Bloque B).
 *
 * Un único UPDATE ... RETURNING (parametrizado con Prisma.sql, nunca
 * $queryRawUnsafe/$executeRawUnsafe) realiza la asignación real: el propio
 * UPDATE toma el lock de fila y lo mantiene hasta el commit/rollback del
 * llamador, sin leer current_number y calcular el incremento en memoria
 * (evita la clásica carrera léctura-luego-escritura). Si el UPDATE no
 * afecta ninguna fila (documentType/series inexistente, serie inactiva, o
 * serie agotada), una consulta de diagnóstico SEPARADA — ejecutada
 * únicamente en esa rama de fallo, nunca para calcular el número asignado —
 * distingue la causa exacta para devolver un error de negocio limpio.
 */
@Injectable()
export class FiscalSeriesService {
  constructor(private readonly prisma: PrismaService) {}

  /**
   * Descubrimiento de solo lectura (Bloque 11D §20/§21/§25): la emisión
   * exige una serie explícita, así que el cliente necesita poder listar
   * las disponibles. Sin paginación (catálogo pequeño por diseño); orden
   * fijo documentType ASC, series ASC. NUNCA calcula/expone un "próximo
   * número" (§22): currentNumber es puramente informativo y puede quedar
   * obsoleto de inmediato ante emisión concurrente.
   */
  async list(query: ListFiscalSeriesQuery): Promise<SafeFiscalSeries[]> {
    const where: Prisma.FiscalSeriesWhereInput = {};
    if (query.documentType !== undefined) {
      where.documentType = query.documentType;
    }
    if (query.active !== undefined) {
      where.active = query.active;
    }

    const rows = await this.prisma.fiscalSeries.findMany({
      where,
      orderBy: [{ documentType: 'asc' }, { series: 'asc' }],
    });

    return rows.map((row) => ({
      id: row.id,
      documentType: row.documentType,
      series: row.series,
      currentNumber: row.currentNumber,
      active: row.active,
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
    }));
  }

  async allocateNext(
    tx: Prisma.TransactionClient,
    documentType: FiscalDocumentType,
    series: string,
  ): Promise<FiscalNumberAllocation> {
    const rows = await tx.$queryRaw<FiscalSeriesUpdateRow[]>(Prisma.sql`
      UPDATE fiscal_series
      SET
        current_number = current_number + 1,
        updated_at = CURRENT_TIMESTAMP
      WHERE document_type = ${documentType}::"FiscalDocumentType"
        AND series = ${series}
        AND active = true
        AND current_number < ${MAX_FISCAL_NUMBER}
      RETURNING id, current_number AS "currentNumber"
    `);

    const allocated = rows[0];
    if (allocated !== undefined) {
      return { fiscalSeriesId: allocated.id, number: allocated.currentNumber };
    }

    await this.diagnoseAllocationFailure(tx, documentType, series);
    // diagnoseAllocationFailure siempre lanza; esta línea es inalcanzable,
    // solo satisface el tipo de retorno sin usar `as never`.
    throw new ConflictException(
      `No se pudo asignar un número fiscal para ${documentType}/${series}`,
    );
  }

  private async diagnoseAllocationFailure(
    tx: Prisma.TransactionClient,
    documentType: FiscalDocumentType,
    series: string,
  ): Promise<never> {
    const existing = await tx.$queryRaw<FiscalSeriesLookupRow[]>(Prisma.sql`
      SELECT active, current_number AS "currentNumber"
      FROM fiscal_series
      WHERE document_type = ${documentType}::"FiscalDocumentType" AND series = ${series}
    `);
    const found = existing[0];

    if (found === undefined) {
      throw new NotFoundException(
        `No existe la serie fiscal ${series} para el tipo de documento ${documentType}`,
      );
    }
    if (!found.active) {
      throw new ConflictException(`La serie fiscal ${series} está inactiva`);
    }
    throw new ConflictException(
      `La serie fiscal ${series} alcanzó su límite máximo de numeración (${MAX_FISCAL_NUMBER})`,
    );
  }
}
