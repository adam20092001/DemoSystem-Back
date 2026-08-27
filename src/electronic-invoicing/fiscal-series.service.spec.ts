import { ConflictException, NotFoundException } from '@nestjs/common';
import { FiscalDocumentType, Prisma } from '@prisma/client';
import { MAX_FISCAL_NUMBER } from './constants/electronic-invoicing.constants';
import { FiscalSeriesService } from './fiscal-series.service';

const FISCAL_SERIES_ID = '55555555-5555-4555-8555-555555555555';

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
  };
}

describe('FiscalSeriesService', () => {
  let tx: ReturnType<typeof createTxMock>;
  let service: FiscalSeriesService;

  beforeEach(() => {
    tx = createTxMock();
    service = new FiscalSeriesService();
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
