import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import {
  AccountingEventType,
  AccountingSourceType,
  AccountStatus,
  AccountType,
  Prisma,
  RoleName,
} from '@prisma/client';
import { ExcelExportService } from '../common/excel/excel-export.service';
import { PrismaService } from '../database/prisma.service';
import { AccountingReportsService } from './accounting-reports.service';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

const ACCOUNT_AR = {
  id: 'acc-ar',
  code: 'AR',
  name: 'Cuentas por cobrar',
  type: AccountType.ASSET,
  status: AccountStatus.ACTIVE,
};

function createPrismaMock() {
  const client = {
    accountingEntry: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
    },
    account: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    accountingEntryLine: {
      aggregate: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      groupBy: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
  };
  // $transaction: misma técnica que el resto del dominio (ver
  // ChartOfAccountsService.spec) — el callback recibe el propio mock
  // (nunca un cliente distinto), ya que para estas pruebas unitarias el
  // aislamiento real de PostgreSQL no aplica; solo importa que el
  // callback se invoque con algo que exponga los mismos métodos.
  return {
    ...client,
    $transaction: jest.fn((fn: (tx: typeof client) => Promise<unknown>) =>
      fn(client),
    ),
  };
}

function createExcelExportServiceMock() {
  return {
    assertWithinExportLimit: jest.fn(),
    buildWorkbook: jest
      .fn<Promise<Buffer>, [string, unknown[], readonly unknown[]]>()
      .mockResolvedValue(Buffer.from('fake-xlsx')),
  };
}

describe('AccountingReportsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let excel: ReturnType<typeof createExcelExportServiceMock>;
  let service: AccountingReportsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    excel = createExcelExportServiceMock();
    service = new AccountingReportsService(
      prisma as unknown as PrismaService,
      excel as unknown as ExcelExportService,
    );
  });

  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s: ForbiddenException en los 3 reportes, sin tocar Prisma',
      async (role) => {
        await expect(
          service.getJournalReport(
            {
              accountingDateFrom: '2026-01-01',
              accountingDateTo: '2026-01-31',
            },
            role,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.getLedgerReport(
            {
              accountId: ACCOUNT_AR.id,
              accountingDateFrom: '2026-01-01',
              accountingDateTo: '2026-01-31',
            },
            role,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.getTrialBalanceReport(
            {
              accountingDateFrom: '2026-01-01',
              accountingDateTo: '2026-01-31',
            },
            role,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);

        expect(prisma.accountingEntry.findMany).not.toHaveBeenCalled();
        expect(prisma.account.findUnique).not.toHaveBeenCalled();
        expect(prisma.accountingEntryLine.groupBy).not.toHaveBeenCalled();
      },
    );

    it.each([RoleName.ADMIN, RoleName.MANAGEMENT])(
      '%s: puede leer (no lanza por rol)',
      async (role) => {
        prisma.accountingEntry.findMany.mockResolvedValue([]);
        prisma.accountingEntry.count.mockResolvedValue(0);
        await expect(
          service.getJournalReport(
            {
              accountingDateFrom: '2026-01-01',
              accountingDateTo: '2026-01-31',
            },
            role,
          ),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('getJournalReport', () => {
    it('rango inválido (from > to): BadRequestException sin tocar Prisma', async () => {
      await expect(
        service.getJournalReport(
          { accountingDateFrom: '2026-03-31', accountingDateTo: '2026-03-01' },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.accountingEntry.findMany).not.toHaveBeenCalled();
    });

    it('calcula totalDebit/totalCredit sumando las líneas, nunca recalculando desde otra fuente', async () => {
      prisma.accountingEntry.findMany.mockResolvedValue([
        {
          id: 'entry-1',
          sourceType: AccountingSourceType.SALE,
          sourceId: 'sale-1',
          eventType: AccountingEventType.ORIGINAL,
          reversesEntryId: null,
          description: 'Venta NV-000001',
          postedAt: new Date('2026-03-15T12:00:00.000Z'),
          accountingDate: new Date('2026-03-15T00:00:00.000Z'),
          periodId: 'period-1',
          journalNumber: 1,
          period: { year: 2026, month: 3 },
          lines: [
            {
              id: 'line-1',
              accountId: 'acc-ar',
              debitAmount: d('118.00'),
              creditAmount: d('0.00'),
              account: { code: 'AR', name: 'Cuentas por cobrar' },
            },
            {
              id: 'line-2',
              accountId: 'acc-sales',
              debitAmount: d('0.00'),
              creditAmount: d('100.00'),
              account: { code: 'SALES', name: 'Ventas' },
            },
            {
              id: 'line-3',
              accountId: 'acc-vat',
              debitAmount: d('0.00'),
              creditAmount: d('18.00'),
              account: { code: 'VAT', name: 'IGV por pagar' },
            },
          ],
        },
      ]);
      prisma.accountingEntry.count.mockResolvedValue(1);

      const result = await service.getJournalReport(
        { accountingDateFrom: '2026-03-01', accountingDateTo: '2026-03-31' },
        RoleName.ADMIN,
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].totalDebit).toBe('118.00');
      expect(result.data[0].totalCredit).toBe('118.00');
      expect(result.data[0].periodYear).toBe(2026);
      expect(result.data[0].periodMonth).toBe(3);
      expect(result.data[0].accountingDate).toBe('2026-03-15');
    });

    it('incluye periodId en el where solo cuando se provee', async () => {
      prisma.accountingEntry.findMany.mockResolvedValue([]);
      prisma.accountingEntry.count.mockResolvedValue(0);

      await service.getJournalReport(
        {
          accountingDateFrom: '2026-03-01',
          accountingDateTo: '2026-03-31',
          periodId: 'period-xyz',
        },
        RoleName.ADMIN,
      );

      const call = prisma.accountingEntry.findMany.mock.calls[0][0] as {
        where: { periodId?: string };
      };
      expect(call.where.periodId).toBe('period-xyz');
    });

    it('limit por defecto 20, tope 100', async () => {
      prisma.accountingEntry.findMany.mockResolvedValue([]);
      prisma.accountingEntry.count.mockResolvedValue(0);

      const defaultResult = await service.getJournalReport(
        { accountingDateFrom: '2026-03-01', accountingDateTo: '2026-03-31' },
        RoleName.ADMIN,
      );
      expect(defaultResult.limit).toBe(20);

      const cappedResult = await service.getJournalReport(
        {
          accountingDateFrom: '2026-03-01',
          accountingDateTo: '2026-03-31',
          limit: 500,
        },
        RoleName.ADMIN,
      );
      expect(cappedResult.limit).toBe(100);
    });
  });

  describe('getLedgerReport', () => {
    it('cuenta inexistente: NotFoundException', async () => {
      prisma.account.findUnique.mockResolvedValue(null);
      await expect(
        service.getLedgerReport(
          {
            accountId: 'does-not-exist',
            accountingDateFrom: '2026-03-01',
            accountingDateTo: '2026-03-31',
          },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('calcula apertura, saldo acumulado y cierre correctamente para una cuenta DEBIT (ASSET)', async () => {
      prisma.account.findUnique.mockResolvedValue(ACCOUNT_AR);
      prisma.accountingEntryLine.aggregate.mockResolvedValue({
        _sum: { debitAmount: d('500.00'), creditAmount: d('200.00') },
      });
      prisma.accountingEntryLine.findMany.mockResolvedValue([
        {
          id: 'line-a',
          debitAmount: d('100.00'),
          creditAmount: d('0.00'),
          entry: {
            id: 'entry-a',
            accountingDate: new Date('2026-03-05T00:00:00.000Z'),
            periodId: 'period-1',
            journalNumber: 1,
            description: 'Venta NV-000002',
            eventType: AccountingEventType.ORIGINAL,
            sourceType: AccountingSourceType.SALE,
            sourceId: 'sale-2',
          },
        },
        {
          id: 'line-b',
          debitAmount: d('0.00'),
          creditAmount: d('40.00'),
          entry: {
            id: 'entry-b',
            accountingDate: new Date('2026-03-10T00:00:00.000Z'),
            periodId: 'period-1',
            journalNumber: 2,
            description: 'Cobro de venta NV-000002',
            eventType: AccountingEventType.ORIGINAL,
            sourceType: AccountingSourceType.PAYMENT,
            sourceId: 'payment-1',
          },
        },
      ]);

      const result = await service.getLedgerReport(
        {
          accountId: ACCOUNT_AR.id,
          accountingDateFrom: '2026-03-01',
          accountingDateTo: '2026-03-31',
        },
        RoleName.ADMIN,
      );

      // apertura: 500 - 200 = 300.00 (DEBIT crece con el débito)
      expect(result.openingBalance).toBe('300.00');
      expect(result.normalBalance).toBe('DEBIT');
      expect(result.data).toHaveLength(2);
      // fila 1: 300 + 100 (debito) = 400.00
      expect(result.data[0].runningBalance).toBe('400.00');
      // fila 2: 400 - 40 (credito) = 360.00
      expect(result.data[1].runningBalance).toBe('360.00');
      expect(result.closingBalance).toBe('360.00');
      expect(result.total).toBe(2);
    });

    it('cuenta LIABILITY (naturaleza CREDIT): el saldo crece con el crédito', async () => {
      prisma.account.findUnique.mockResolvedValue({
        id: 'acc-vat',
        code: 'VAT',
        name: 'IGV por pagar',
        type: AccountType.LIABILITY,
        status: AccountStatus.ACTIVE,
      });
      prisma.accountingEntryLine.aggregate.mockResolvedValue({
        _sum: { debitAmount: d('0.00'), creditAmount: d('100.00') },
      });
      prisma.accountingEntryLine.findMany.mockResolvedValue([]);

      const result = await service.getLedgerReport(
        {
          accountId: 'acc-vat',
          accountingDateFrom: '2026-03-01',
          accountingDateTo: '2026-03-31',
        },
        RoleName.ADMIN,
      );

      expect(result.normalBalance).toBe('CREDIT');
      expect(result.openingBalance).toBe('100.00');
      expect(result.closingBalance).toBe('100.00');
    });

    it('la paginación de movimientos nunca afecta apertura/cierre (calculados sobre el total, no la página)', async () => {
      prisma.account.findUnique.mockResolvedValue(ACCOUNT_AR);
      prisma.accountingEntryLine.aggregate.mockResolvedValue({
        _sum: { debitAmount: d('0.00'), creditAmount: d('0.00') },
      });
      const makeLine = (n: number) => ({
        id: `line-${n}`,
        debitAmount: d('10.00'),
        creditAmount: d('0.00'),
        entry: {
          id: `entry-${n}`,
          accountingDate: new Date(
            `2026-03-${String(n).padStart(2, '0')}T00:00:00.000Z`,
          ),
          periodId: 'period-1',
          journalNumber: n,
          description: `Movimiento ${n}`,
          eventType: AccountingEventType.ORIGINAL,
          sourceType: AccountingSourceType.SALE,
          sourceId: `sale-${n}`,
        },
      });
      prisma.accountingEntryLine.findMany.mockResolvedValue(
        Array.from({ length: 5 }, (_, i) => makeLine(i + 1)),
      );

      const result = await service.getLedgerReport(
        {
          accountId: ACCOUNT_AR.id,
          accountingDateFrom: '2026-03-01',
          accountingDateTo: '2026-03-31',
          page: 1,
          limit: 2,
        },
        RoleName.ADMIN,
      );

      expect(result.data).toHaveLength(2);
      expect(result.total).toBe(5);
      expect(result.totalPages).toBe(3);
      // El cierre es sobre las 5 líneas completas (50.00), no solo la página (20.00).
      expect(result.closingBalance).toBe('50.00');
      // La última fila de la PÁGINA refleja su posición real en la secuencia completa (20.00), no 1+2 de la página.
      expect(result.data[1].runningBalance).toBe('20.00');
    });
  });

  describe('getTrialBalanceReport', () => {
    it('accountIds vacío: BadRequestException', async () => {
      await expect(
        service.getTrialBalanceReport(
          {
            accountingDateFrom: '2026-03-01',
            accountingDateTo: '2026-03-31',
            accountIds: [],
          },
          RoleName.ADMIN,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sin filtro de cuentas: reconciliation.applicable=true y totales cuadran', async () => {
      prisma.account.findMany.mockResolvedValue([
        {
          id: 'acc-cash',
          code: 'CASH',
          name: 'Caja',
          type: AccountType.ASSET,
          status: AccountStatus.ACTIVE,
        },
        {
          id: 'acc-sales',
          code: 'SALES',
          name: 'Ventas',
          type: AccountType.REVENUE,
          status: AccountStatus.ACTIVE,
        },
      ]);
      prisma.accountingEntryLine.groupBy
        .mockResolvedValueOnce([]) // opening groups (sin historial previo)
        .mockResolvedValueOnce([
          {
            accountId: 'acc-cash',
            _sum: { debitAmount: d('118.00'), creditAmount: d('0.00') },
          },
          {
            accountId: 'acc-sales',
            _sum: { debitAmount: d('0.00'), creditAmount: d('118.00') },
          },
        ]);

      const result = await service.getTrialBalanceReport(
        { accountingDateFrom: '2026-03-01', accountingDateTo: '2026-03-31' },
        RoleName.ADMIN,
      );

      expect(result.reconciliation.applicable).toBe(true);
      expect(result.reconciliation.periodBalanced).toBe(true);
      expect(result.reconciliation.endingBalanced).toBe(true);
      expect(result.reconciliation.totalPeriodDebit).toBe('118.00');
      expect(result.reconciliation.totalPeriodCredit).toBe('118.00');
      expect(result.data).toHaveLength(2);
    });

    it('cuentas sin saldo/movimiento se excluyen por defecto', async () => {
      prisma.account.findMany.mockResolvedValue([
        {
          id: 'acc-cash',
          code: 'CASH',
          name: 'Caja',
          type: AccountType.ASSET,
          status: AccountStatus.ACTIVE,
        },
        {
          id: 'acc-discounts',
          code: 'DISCOUNTS',
          name: 'Descuentos',
          type: AccountType.CONTRA_REVENUE,
          status: AccountStatus.ACTIVE,
        },
      ]);
      prisma.accountingEntryLine.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            accountId: 'acc-cash',
            _sum: { debitAmount: d('50.00'), creditAmount: d('0.00') },
          },
        ]);

      const result = await service.getTrialBalanceReport(
        { accountingDateFrom: '2026-03-01', accountingDateTo: '2026-03-31' },
        RoleName.ADMIN,
      );

      expect(result.data).toHaveLength(1);
      expect(result.data[0].accountCode).toBe('CASH');
    });

    it('includeZeroBalances=true: incluye cuentas sin movimiento', async () => {
      prisma.account.findMany.mockResolvedValue([
        {
          id: 'acc-cash',
          code: 'CASH',
          name: 'Caja',
          type: AccountType.ASSET,
          status: AccountStatus.ACTIVE,
        },
        {
          id: 'acc-discounts',
          code: 'DISCOUNTS',
          name: 'Descuentos',
          type: AccountType.CONTRA_REVENUE,
          status: AccountStatus.ACTIVE,
        },
      ]);
      prisma.accountingEntryLine.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const result = await service.getTrialBalanceReport(
        {
          accountingDateFrom: '2026-03-01',
          accountingDateTo: '2026-03-31',
          includeZeroBalances: true,
        },
        RoleName.ADMIN,
      );

      expect(result.data).toHaveLength(2);
    });

    it('con accountIds filtrado: reconciliation.applicable=false y *Balanced en null', async () => {
      prisma.account.findMany.mockResolvedValue([
        {
          id: 'acc-cash',
          code: 'CASH',
          name: 'Caja',
          type: AccountType.ASSET,
          status: AccountStatus.ACTIVE,
        },
      ]);
      prisma.accountingEntryLine.groupBy
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([
          {
            accountId: 'acc-cash',
            _sum: { debitAmount: d('50.00'), creditAmount: d('0.00') },
          },
        ]);

      const result = await service.getTrialBalanceReport(
        {
          accountingDateFrom: '2026-03-01',
          accountingDateTo: '2026-03-31',
          accountIds: ['acc-cash'],
        },
        RoleName.ADMIN,
      );

      expect(result.reconciliation.applicable).toBe(false);
      expect(result.reconciliation.openingBalanced).toBeNull();
      expect(result.reconciliation.periodBalanced).toBeNull();
      expect(result.reconciliation.endingBalanced).toBeNull();
      // El subconjunto filtrado SÍ aparece aunque no tenga por qué cuadrar.
      expect(result.data).toHaveLength(1);
    });
  });

  describe('exportJournalXlsx', () => {
    it('verifica el límite de exportación antes de construir el workbook', async () => {
      prisma.accountingEntry.findMany.mockResolvedValue([]);
      prisma.accountingEntry.count.mockResolvedValue(0);

      await service.exportJournalXlsx(
        { accountingDateFrom: '2026-03-01', accountingDateTo: '2026-03-31' },
        RoleName.ADMIN,
      );

      expect(excel.assertWithinExportLimit).toHaveBeenCalledWith(
        0,
        'libro diario',
      );
      expect(excel.buildWorkbook).toHaveBeenCalledTimes(1);
    });
  });
});
