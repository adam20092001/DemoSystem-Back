import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  AccountType,
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  Prisma,
  RoleName,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AccountingService } from './accounting.service';

function makeAccountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'account-1',
    code: 'AR',
    name: 'Cuentas por cobrar',
    type: AccountType.ASSET,
    systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
    ...overrides,
  };
}

function makeEntryListRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'entry-1',
    sourceType: AccountingSourceType.SALE,
    sourceId: 'sale-1',
    eventType: AccountingEventType.ORIGINAL,
    reversesEntryId: null,
    description: 'Venta NV-000001',
    postedAt: new Date(),
    createdAt: new Date(),
    ...overrides,
  };
}

function makeEntryDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...makeEntryListRow(),
    createdBy: {
      id: 'user-1',
      username: 'admin',
      firstName: 'Ana',
      lastName: 'Diaz',
    },
    lines: [
      {
        id: 'line-1',
        accountId: 'account-1',
        debitAmount: new Prisma.Decimal('100.00'),
        creditAmount: new Prisma.Decimal('0.00'),
        account: { code: 'AR', name: 'Cuentas por cobrar' },
      },
      {
        id: 'line-2',
        accountId: 'account-2',
        debitAmount: new Prisma.Decimal('0.00'),
        creditAmount: new Prisma.Decimal('100.00'),
        account: { code: 'SALES', name: 'Ventas' },
      },
    ],
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    account: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    accountingEntry: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };
}

describe('AccountingService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AccountingService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.account.findMany.mockResolvedValue([makeAccountRow()]);
    prisma.accountingEntry.findMany.mockResolvedValue([makeEntryListRow()]);
    prisma.accountingEntry.count.mockResolvedValue(1);
    prisma.accountingEntry.findUnique.mockResolvedValue(makeEntryDetailRow());
    service = new AccountingService(prisma as unknown as PrismaService);
  });

  describe('listAccounts', () => {
    it('ADMIN/MANAGEMENT: consultan normalmente, orden code asc', async () => {
      for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
        prisma.account.findMany.mockClear();
        await service.listAccounts(role);
        expect(prisma.account.findMany).toHaveBeenCalledWith(
          expect.objectContaining({ orderBy: [{ code: 'asc' }] }),
        );
      }
    });

    it('SELLER/WAREHOUSE/rol desconocido: lista vacía sin tocar Prisma', async () => {
      for (const role of [
        RoleName.SELLER,
        RoleName.WAREHOUSE,
        'UNKNOWN' as RoleName,
      ]) {
        prisma.account.findMany.mockClear();
        const result = await service.listAccounts(role);
        expect(result).toEqual([]);
        expect(prisma.account.findMany).not.toHaveBeenCalled();
      }
    });

    it('mapea cada fila a SafeAccount sin createdAt', async () => {
      const result = await service.listAccounts(RoleName.ADMIN);
      expect(result[0]).toEqual({
        id: 'account-1',
        code: 'AR',
        name: 'Cuentas por cobrar',
        type: AccountType.ASSET,
        systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
      });
      expect(Object.keys(result[0])).not.toContain('createdAt');
    });
  });

  describe('listEntries', () => {
    it('filtros sourceType/eventType/sourceId se incluyen en el where', async () => {
      await service.listEntries(
        {
          sourceType: AccountingSourceType.PAYMENT,
          eventType: AccountingEventType.REVERSAL,
          sourceId: 'payment-1',
        },
        RoleName.ADMIN,
      );
      const call = prisma.accountingEntry.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND).toEqual(
        expect.arrayContaining([
          { sourceType: AccountingSourceType.PAYMENT },
          { eventType: AccountingEventType.REVERSAL },
          { sourceId: 'payment-1' },
        ]),
      );
    });

    it('sin filtros: where vacío ({})', async () => {
      await service.listEntries({}, RoleName.ADMIN);
      const call = prisma.accountingEntry.findMany.mock.calls[0][0] as {
        where: unknown;
      };
      expect(call.where).toEqual({});
    });

    it('postedFrom/postedTo inválidos -> 400', async () => {
      await expect(
        service.listEntries({ postedFrom: 'no-es-fecha' }, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('postedFrom > postedTo -> 400', async () => {
      await expect(
        service.listEntries(
          { postedFrom: '2026-03-20', postedTo: '2026-03-10' },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('orden createdAt asc, id asc (cronológico de libro diario)', async () => {
      await service.listEntries({}, RoleName.ADMIN);
      const call = prisma.accountingEntry.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(call.orderBy).toEqual([{ createdAt: 'asc' }, { id: 'asc' }]);
    });

    it('findMany y count usan el mismo where', async () => {
      await service.listEntries(
        { sourceType: AccountingSourceType.SALE },
        RoleName.ADMIN,
      );
      const findManyWhere = (
        prisma.accountingEntry.findMany.mock.calls[0][0] as {
          where: unknown;
        }
      ).where;
      const countWhere = (
        prisma.accountingEntry.count.mock.calls[0][0] as { where: unknown }
      ).where;
      expect(findManyWhere).toEqual(countWhere);
    });

    it('limit por defecto 20, máximo 100', async () => {
      const defaultResult = await service.listEntries({}, RoleName.ADMIN);
      expect(defaultResult.limit).toBe(20);

      const cappedResult = await service.listEntries(
        { limit: 500 },
        RoleName.ADMIN,
      );
      expect(cappedResult.limit).toBe(100);
    });

    it('sin resultados: totalPages=0', async () => {
      prisma.accountingEntry.findMany.mockResolvedValue([]);
      prisma.accountingEntry.count.mockResolvedValue(0);
      const result = await service.listEntries({}, RoleName.ADMIN);
      expect(result.totalPages).toBe(0);
    });

    it('mapea la fila sin lines/createdBy/sourceNumber', async () => {
      const postedAt = new Date();
      const createdAt = new Date();
      prisma.accountingEntry.findMany.mockResolvedValue([
        makeEntryListRow({ postedAt, createdAt }),
      ]);
      const result = await service.listEntries({}, RoleName.ADMIN);
      expect(result.data[0]).toEqual({
        id: 'entry-1',
        sourceType: AccountingSourceType.SALE,
        sourceId: 'sale-1',
        eventType: AccountingEventType.ORIGINAL,
        reversesEntryId: null,
        description: 'Venta NV-000001',
        postedAt,
        createdAt,
      });
      const serialized = JSON.stringify(result.data[0]);
      expect(serialized).not.toMatch(/lines|createdBy|sourceNumber/i);
    });

    it('SELLER/WAREHOUSE/rol desconocido: página vacía sin tocar Prisma', async () => {
      for (const role of [
        RoleName.SELLER,
        RoleName.WAREHOUSE,
        'UNKNOWN' as RoleName,
      ]) {
        prisma.accountingEntry.findMany.mockClear();
        prisma.accountingEntry.count.mockClear();
        const result = await service.listEntries({}, role);
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.accountingEntry.findMany).not.toHaveBeenCalled();
        expect(prisma.accountingEntry.count).not.toHaveBeenCalled();
      }
    });
  });

  describe('findEntry', () => {
    it('ADMIN/MANAGEMENT: retorna el detalle con líneas y createdBy', async () => {
      const result = await service.findEntry('entry-1', RoleName.ADMIN);
      expect(result.id).toBe('entry-1');
      expect(result.createdBy).toEqual({
        id: 'user-1',
        username: 'admin',
        firstName: 'Ana',
        lastName: 'Diaz',
      });
      expect(result.lines).toEqual([
        {
          id: 'line-1',
          accountId: 'account-1',
          accountCode: 'AR',
          accountName: 'Cuentas por cobrar',
          debitAmount: '100.00',
          creditAmount: '0.00',
        },
        {
          id: 'line-2',
          accountId: 'account-2',
          accountCode: 'SALES',
          accountName: 'Ventas',
          debitAmount: '0.00',
          creditAmount: '100.00',
        },
      ]);
    });

    it('entryId inexistente -> 404', async () => {
      prisma.accountingEntry.findUnique.mockResolvedValue(null);
      await expect(
        service.findEntry('missing', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SELLER/WAREHOUSE/rol desconocido: 404 sin tocar Prisma (fail-closed, sin revelar existencia)', async () => {
      for (const role of [
        RoleName.SELLER,
        RoleName.WAREHOUSE,
        'UNKNOWN' as RoleName,
      ]) {
        prisma.accountingEntry.findUnique.mockClear();
        await expect(service.findEntry('entry-1', role)).rejects.toBeInstanceOf(
          NotFoundException,
        );
        expect(prisma.accountingEntry.findUnique).not.toHaveBeenCalled();
      }
    });
  });
});
