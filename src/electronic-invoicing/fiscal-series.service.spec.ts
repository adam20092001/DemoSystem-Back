import { ConflictException, NotFoundException } from '@nestjs/common';
import { FiscalDocumentType, Prisma } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { MAX_FISCAL_NUMBER } from './constants/electronic-invoicing.constants';
import { FiscalSeriesService } from './fiscal-series.service';

const FISCAL_SERIES_ID = '55555555-5555-4555-8555-555555555555';

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
  };
}

function createPrismaMock() {
  return {
    fiscalSeries: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
  };
}

describe('FiscalSeriesService', () => {
  let tx: ReturnType<typeof createTxMock>;
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: FiscalSeriesService;

  beforeEach(() => {
    tx = createTxMock();
    prisma = createPrismaMock();
    service = new FiscalSeriesService(prisma as unknown as PrismaService);
  });

  describe('list', () => {
    const ROW = {
      id: FISCAL_SERIES_ID,
      documentType: FiscalDocumentType.FACTURA,
      series: 'F001',
      currentNumber: 5,
      active: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-02T00:00:00.000Z'),
    };

    it('mapea las filas a SafeFiscalSeries, sin nextNumber', async () => {
      prisma.fiscalSeries.findMany.mockResolvedValue([ROW]);

      const result = await service.list({});

      expect(result).toEqual([
        {
          id: FISCAL_SERIES_ID,
          documentType: FiscalDocumentType.FACTURA,
          series: 'F001',
          currentNumber: 5,
          active: true,
          createdAt: ROW.createdAt,
          updatedAt: ROW.updatedAt,
        },
      ]);
      expect(result[0]).not.toHaveProperty('nextNumber');
    });

    it('ordena documentType ASC, series ASC', async () => {
      prisma.fiscalSeries.findMany.mockResolvedValue([]);

      await service.list({});

      expect(prisma.fiscalSeries.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ documentType: 'asc' }, { series: 'asc' }],
        }),
      );
    });

    it('aplica el filtro documentType', async () => {
      prisma.fiscalSeries.findMany.mockResolvedValue([]);

      await service.list({ documentType: FiscalDocumentType.BOLETA });

      const call = prisma.fiscalSeries.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ documentType: FiscalDocumentType.BOLETA });
    });

    it('aplica el filtro active', async () => {
      prisma.fiscalSeries.findMany.mockResolvedValue([]);

      await service.list({ active: false });

      const call = prisma.fiscalSeries.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({ active: false });
    });

    it('sin filtros: where vacío (devuelve todas las series)', async () => {
      prisma.fiscalSeries.findMany.mockResolvedValue([]);

      await service.list({});

      const call = prisma.fiscalSeries.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({});
    });
  });

  it('currentNumber 0 -> el UPDATE lo incrementa y devuelve 1', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      { id: FISCAL_SERIES_ID, currentNumber: 1 },
    ]);

    const result = await service.allocateNext(
      tx as unknown as Prisma.TransactionClient,
      FiscalDocumentType.FACTURA,
      'F001',
    );

    expect(result).toEqual({ fiscalSeriesId: FISCAL_SERIES_ID, number: 1 });
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('usa un único UPDATE ... RETURNING parametrizado (Prisma.sql), nunca una API insegura', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      { id: FISCAL_SERIES_ID, currentNumber: 5 },
    ]);

    await service.allocateNext(
      tx as unknown as Prisma.TransactionClient,
      FiscalDocumentType.BOLETA,
      'B001',
    );

    const sql = tx.$queryRaw.mock.calls[0][0];
    expect(sql.strings.join(' ')).toContain('UPDATE fiscal_series');
    expect(sql.strings.join(' ')).toContain('RETURNING');
    // Los valores viajan parametrizados (Prisma.Sql.values), nunca
    // interpolados directamente en el texto SQL.
    expect(sql.values).toContain('BOLETA');
    expect(sql.values).toContain('B001');
  });

  it('nunca lee current_number y calcula el incremento en memoria: no hay un SELECT previo al UPDATE en el camino feliz', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      { id: FISCAL_SERIES_ID, currentNumber: 1 },
    ]);

    await service.allocateNext(
      tx as unknown as Prisma.TransactionClient,
      FiscalDocumentType.FACTURA,
      'F001',
    );

    // Una sola invocación total: el UPDATE es la única consulta ejecutada
    // cuando afecta una fila.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('serie inexistente para ese documentType -> NotFoundException, tras diagnosticar', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([]) // UPDATE no afecta ninguna fila
      .mockResolvedValueOnce([]); // diagnóstico: no existe la fila

    await expect(
      service.allocateNext(
        tx as unknown as Prisma.TransactionClient,
        FiscalDocumentType.FACTURA,
        'B001',
      ),
    ).rejects.toThrow(NotFoundException);
    expect(tx.$queryRaw).toHaveBeenCalledTimes(2);
  });

  it('serie inactiva -> ConflictException', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{ active: false, currentNumber: 3 }]);

    await expect(
      service.allocateNext(
        tx as unknown as Prisma.TransactionClient,
        FiscalDocumentType.FACTURA,
        'F001',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('serie agotada (currentNumber == límite máximo) -> ConflictException, sin desbordar', async () => {
    tx.$queryRaw
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([
        { active: true, currentNumber: MAX_FISCAL_NUMBER },
      ]);

    await expect(
      service.allocateNext(
        tx as unknown as Prisma.TransactionClient,
        FiscalDocumentType.FACTURA,
        'F001',
      ),
    ).rejects.toThrow(ConflictException);
  });

  it('la condición current_number < límite viaja en el propio UPDATE (nunca solo el CHECK de base de datos como primera defensa)', async () => {
    tx.$queryRaw.mockResolvedValueOnce([
      { id: FISCAL_SERIES_ID, currentNumber: 42 },
    ]);

    await service.allocateNext(
      tx as unknown as Prisma.TransactionClient,
      FiscalDocumentType.FACTURA,
      'F001',
    );

    const sql = tx.$queryRaw.mock.calls[0][0];
    expect(sql.strings.join(' ')).toContain('current_number <');
    expect(sql.values).toContain(MAX_FISCAL_NUMBER);
  });
});
