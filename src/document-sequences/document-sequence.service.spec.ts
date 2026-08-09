import { InternalServerErrorException } from '@nestjs/common';
import { DocumentType, Prisma } from '@prisma/client';
import { DocumentSequenceService } from './document-sequence.service';

interface RawSequenceResult {
  currentNumber: number;
  prefix: string;
  padding: number;
}

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<RawSequenceResult[]>, [unknown]>(),
  };
}

describe('DocumentSequenceService', () => {
  let tx: ReturnType<typeof createTxMock>;
  let service: DocumentSequenceService;

  beforeEach(() => {
    tx = createTxMock();
    service = new DocumentSequenceService();
  });

  it('ejecuta exactamente un UPDATE ... RETURNING usando el tx recibido', async () => {
    tx.$queryRaw.mockResolvedValue([
      { currentNumber: 1, prefix: 'COT-', padding: 6 },
    ]);

    await service.next(
      tx as unknown as Prisma.TransactionClient,
      DocumentType.QUOTE,
    );

    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('no inyecta PrismaService ni abre su propia transacción (el servicio no tiene ningún otro colaborador)', () => {
    // El constructor no recibe argumentos: no hay PrismaService ni ningún
    // cliente propio inyectado. La única vía de acceso a datos es el `tx`
    // recibido como parámetro en next().
    expect(DocumentSequenceService.length).toBe(0);
  });

  it('formatea con el prefijo (que ya incluye el separador) + padding', async () => {
    tx.$queryRaw.mockResolvedValue([
      { currentNumber: 1, prefix: 'COT-', padding: 6 },
    ]);

    const result = await service.next(
      tx as unknown as Prisma.TransactionClient,
      DocumentType.QUOTE,
    );

    expect(result).toBe('COT-000001');
  });

  it('respeta el padding configurado (distinto de 6)', async () => {
    tx.$queryRaw.mockResolvedValue([
      { currentNumber: 7, prefix: 'COT-', padding: 4 },
    ]);

    const result = await service.next(
      tx as unknown as Prisma.TransactionClient,
      DocumentType.QUOTE,
    );

    expect(result).toBe('COT-0007');
  });

  it('currentNumber intermedio se formatea sin ceros de más', async () => {
    tx.$queryRaw.mockResolvedValue([
      { currentNumber: 42, prefix: 'COT-', padding: 6 },
    ]);

    const result = await service.next(
      tx as unknown as Prisma.TransactionClient,
      DocumentType.QUOTE,
    );

    expect(result).toBe('COT-000042');
  });

  it('un valor mayor que el ancho del padding NO se trunca', async () => {
    tx.$queryRaw.mockResolvedValue([
      { currentNumber: 1000000, prefix: 'COT-', padding: 6 },
    ]);

    const result = await service.next(
      tx as unknown as Prisma.TransactionClient,
      DocumentType.QUOTE,
    );

    expect(result).toBe('COT-1000000');
  });

  it('fila de secuencia inexistente -> InternalServerErrorException controlada (nunca 400)', async () => {
    tx.$queryRaw.mockResolvedValue([]);

    await expect(
      service.next(
        tx as unknown as Prisma.TransactionClient,
        DocumentType.QUOTE,
      ),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
  });

  it('el UPDATE crudo avanza updated_at explícitamente (Prisma @updatedAt no aplica a SQL crudo)', async () => {
    tx.$queryRaw.mockResolvedValue([
      { currentNumber: 1, prefix: 'COT-', padding: 6 },
    ]);

    await service.next(
      tx as unknown as Prisma.TransactionClient,
      DocumentType.QUOTE,
    );

    const sentQuery = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sentQuery.sql).toMatch(/updated_at\s*=\s*CURRENT_TIMESTAMP/);
    expect(sentQuery.sql).toMatch(
      /current_number\s*=\s*current_number\s*\+\s*1/,
    );
    expect(sentQuery.sql).toMatch(/RETURNING/);
  });

  it('el documentType se pasa como parámetro vinculado, no concatenado en el texto SQL', async () => {
    tx.$queryRaw.mockResolvedValue([
      { currentNumber: 1, prefix: 'COT-', padding: 6 },
    ]);

    await service.next(
      tx as unknown as Prisma.TransactionClient,
      DocumentType.QUOTE,
    );

    const sentQuery = tx.$queryRaw.mock.calls[0][0] as Prisma.Sql;
    expect(sentQuery.sql).not.toContain('QUOTE');
    expect(sentQuery.values).toEqual(['QUOTE']);
  });
});
