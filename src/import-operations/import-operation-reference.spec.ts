import { Prisma } from '@prisma/client';
import {
  formatImportOperationReference,
  nextImportOperationNumber,
  yearOfBusinessDate,
} from './import-operation-reference';

describe('correlativo de operaciones de importación (R4)', () => {
  it('formato IMP-AAAA-NNNNNN', () => {
    expect(formatImportOperationReference(2026, 1)).toBe('IMP-2026-000001');
    expect(formatImportOperationReference(2027, 123456)).toBe(
      'IMP-2027-123456',
    );
  });

  it('el año sale de la fecha de negocio', () => {
    expect(yearOfBusinessDate('2026-12-31')).toBe(2026);
    expect(yearOfBusinessDate('2027-01-01')).toBe(2027);
  });

  it('devuelve el número del año consultado (un solo INSERT ... ON CONFLICT ... RETURNING)', async () => {
    const queryRaw = jest.fn().mockResolvedValue([{ lastNumber: 5 }]);
    const tx = { $queryRaw: queryRaw } as unknown as Prisma.TransactionClient;
    await expect(nextImportOperationNumber(tx, 2026)).resolves.toBe(5);
    expect(queryRaw).toHaveBeenCalledTimes(1);
    const sql = (queryRaw.mock.calls[0] as [Prisma.Sql])[0].sql;
    expect(sql).toContain('ON CONFLICT (year)');
    expect(sql).toContain('RETURNING');
    expect(sql.toUpperCase()).not.toContain('MAX(');
  });

  it('un año nuevo reinicia en 1 (el INSERT crea la fila con 1)', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ lastNumber: 1 }]),
    } as unknown as Prisma.TransactionClient;
    await expect(nextImportOperationNumber(tx, 2027)).resolves.toBe(1);
  });

  it('error interno si la base no devuelve fila', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([]),
    } as unknown as Prisma.TransactionClient;
    await expect(nextImportOperationNumber(tx, 2026)).rejects.toThrow(
      /correlativo/,
    );
  });

  it('error interno al agotar el correlativo anual de 6 dígitos', async () => {
    const tx = {
      $queryRaw: jest.fn().mockResolvedValue([{ lastNumber: 1_000_000 }]),
    } as unknown as Prisma.TransactionClient;
    await expect(nextImportOperationNumber(tx, 2026)).rejects.toThrow(/agotó/);
  });
});
