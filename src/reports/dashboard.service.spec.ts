import { BadRequestException } from '@nestjs/common';
import { Prisma, QuoteStatus, RoleName } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { SaleAccessRequester } from '../sales/sale-access.policy';
import { DashboardService } from './dashboard.service';

const ACTOR_ID = 'actor-id';

/** Mismo helper que PaymentsService.list()/ReportsService (P1-P6-E1). */
function asRole(role: RoleName, id: string = ACTOR_ID): SaleAccessRequester {
  return { id, role };
}

function createPrismaMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
    sale: {
      aggregate: jest.fn<Promise<unknown>, [unknown]>(),
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    payment: {
      aggregate: jest.fn<Promise<unknown>, [unknown]>(),
    },
    quote: {
      count: jest.fn<Promise<number>, [unknown]>(),
    },
  };
}

function emptySaleAgg() {
  return { _count: { _all: 0 }, _sum: { total: null } };
}
function emptyPaymentAgg() {
  return { _count: { _all: 0 }, _sum: { amount: null } };
}
function emptyReceivableAgg() {
  return { _count: { _all: 0 }, _sum: { balanceDue: null } };
}

describe('DashboardService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: DashboardService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new DashboardService(prisma as unknown as PrismaService);
    // Defaults inocuos para que un test enfocado en otra sección no falle
    // por falta de mock en una sección que igual se ejecuta (mismo rol).
    prisma.sale.aggregate.mockResolvedValue(emptySaleAgg());
    prisma.payment.aggregate.mockResolvedValue(emptyPaymentAgg());
    prisma.sale.findMany.mockResolvedValue([]);
    prisma.quote.count.mockResolvedValue(0);
    prisma.$queryRaw.mockResolvedValue([]);
  });

  // ==========================================================================
  // Resolución de período
  // ==========================================================================
  describe('resolución de período', () => {
    it('ambos omitidos: default = mes calendario actual America/Lima (día 1 hasta hoy)', async () => {
      // 2026-08-23 12:00 UTC cae en 2026-08-23 en America/Lima (UTC-5).
      // jest.useFakeTimers intercepta `new Date()` (no solo Date.now()), a
      // diferencia de sobreescribir Date.now a mano.
      jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
      try {
        const result = await service.getDashboard({}, asRole(RoleName.ADMIN));
        expect(result.period).toEqual({ from: '2026-08-01', to: '2026-08-23' });
      } finally {
        jest.useRealTimers();
      }
    });

    it('ambos provistos: se usan tal cual', async () => {
      const result = await service.getDashboard(
        { from: '2026-08-05', to: '2026-08-10' },
        asRole(RoleName.ADMIN),
      );
      expect(result.period).toEqual({ from: '2026-08-05', to: '2026-08-10' });
    });

    it('from sin to -> 400, sin tocar Prisma', async () => {
      await expect(
        service.getDashboard({ from: '2026-08-01' }, asRole(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.sale.aggregate).not.toHaveBeenCalled();
    });

    it('to sin from -> 400, sin tocar Prisma', async () => {
      await expect(
        service.getDashboard({ to: '2026-08-10' }, asRole(RoleName.ADMIN)),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.sale.aggregate).not.toHaveBeenCalled();
    });

    it('from > to -> 400', async () => {
      await expect(
        service.getDashboard(
          { from: '2026-08-10', to: '2026-08-01' },
          asRole(RoleName.ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('la resolución/validación del período ocurre incluso para un rol sin ninguna sección visible', async () => {
      await expect(
        service.getDashboard(
          { from: '2026-08-10' },
          asRole('NOT_A_ROLE' as RoleName),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  // ==========================================================================
  // Sales
  // ==========================================================================
  describe('sección sales', () => {
    it('filtra Sale ACTIVE con confirmedAt en el período (gte/lt exclusivo)', async () => {
      await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      const args = prisma.sale.aggregate.mock.calls[0][0] as {
        where: { status: string; confirmedAt: { gte: Date; lt: Date } };
      };
      expect(args.where.status).toBe('ACTIVE');
      expect(args.where.confirmedAt.gte).toEqual(
        new Date('2026-08-01T05:00:00.000Z'),
      );
      expect(args.where.confirmedAt.lt).toEqual(
        new Date('2026-09-01T05:00:00.000Z'),
      );
    });

    it('serializa count/total, vacío -> 0 / "0.00"', async () => {
      const result = await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );
      expect(result.sales).toEqual({ count: 0, total: '0.00' });
    });

    it('con datos: total fijo a 2 decimales', async () => {
      prisma.sale.aggregate.mockImplementation(
        (args: { where: { confirmedAt?: unknown } }) =>
          // La primera llamada (sales) recibe confirmedAt; distinguimos por eso.
          Promise.resolve(
            args.where.confirmedAt !== undefined
              ? {
                  _count: { _all: 4 },
                  _sum: { total: new Prisma.Decimal('1250.5') },
                }
              : emptyReceivableAgg(),
          ),
      );
      const result = await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );
      expect(result.sales).toEqual({ count: 4, total: '1250.50' });
    });
  });

  // ==========================================================================
  // Collections
  // ==========================================================================
  describe('sección collections', () => {
    it('filtra Payment ACTIVE con paidAt en el período', async () => {
      await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      const args = prisma.payment.aggregate.mock.calls[0][0] as {
        where: { status: string; paidAt: { gte: Date; lt: Date } };
      };
      expect(args.where.status).toBe('ACTIVE');
      expect(args.where.paidAt.gte).toEqual(
        new Date('2026-08-01T05:00:00.000Z'),
      );
      expect(args.where.paidAt.lt).toEqual(
        new Date('2026-09-01T05:00:00.000Z'),
      );
    });

    it('serializa count/total, vacío -> 0 / "0.00"', async () => {
      const result = await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );
      expect(result.collections).toEqual({ count: 0, total: '0.00' });
    });

    it('con datos: total fijo a 2 decimales', async () => {
      prisma.payment.aggregate.mockResolvedValue({
        _count: { _all: 3 },
        _sum: { amount: new Prisma.Decimal('980') },
      });
      const result = await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );
      expect(result.collections).toEqual({ count: 3, total: '980.00' });
    });
  });

  // ==========================================================================
  // LowStock
  // ==========================================================================
  describe('sección lowStock', () => {
    it('no aplica el período del Dashboard (siempre exactamente 2 $queryRaw sin filtros de fecha)', async () => {
      await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.WAREHOUSE),
      );
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).not.toMatch(/confirmed_at|paid_at|issue_date/);
      expect(rowsSql.text).toContain("p.status = 'ACTIVE'");
      expect(rowsSql.text).toContain("p.product_type = 'PRODUCT'");
      expect(rowsSql.text).toContain('p.is_inventory_tracked = true');
      expect(rowsSql.text).toContain("c.status = 'ACTIVE'");
      expect(rowsSql.text).toContain("u.status = 'ACTIVE'");
      expect(rowsSql.text).toContain('p.stock_current <= p.stock_minimum');
    });

    it('orden: mayor faltante primero, desempate sku ASC, id ASC; LIMIT 5', async () => {
      await service.getDashboard({}, asRole(RoleName.WAREHOUSE));
      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).toContain(
        'ORDER BY (p.stock_minimum - p.stock_current) DESC, p.sku ASC, p.id ASC',
      );
      expect(rowsSql.values).toContain(5);
    });

    it('count es independiente del límite de 5 (segunda consulta separada, sin LIMIT)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([]) // filas top-5
        .mockResolvedValueOnce([{ total: 42 }]); // count real

      const result = await service.getDashboard({}, asRole(RoleName.WAREHOUSE));

      const countSql = prisma.$queryRaw.mock.calls[1][0];
      expect(countSql.text).toContain('COUNT(*)::int');
      expect(countSql.text).not.toContain('LIMIT');
      expect(result.lowStock?.count).toBe(42);
    });

    it('serializa stockCurrent/stockMinimum/difference a 3 decimales', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            id: 'prod-1',
            sku: 'SKU-1',
            name: 'Producto uno',
            stockCurrent: new Prisma.Decimal('2'),
            stockMinimum: new Prisma.Decimal('5'),
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const result = await service.getDashboard({}, asRole(RoleName.WAREHOUSE));

      expect(result.lowStock?.items).toEqual([
        {
          productId: 'prod-1',
          sku: 'SKU-1',
          productName: 'Producto uno',
          stockCurrent: '2.000',
          stockMinimum: '5.000',
          difference: '3.000',
        },
      ]);
    });
  });

  // ==========================================================================
  // Quotes
  // ==========================================================================
  describe('sección quotes', () => {
    it('filtra Quote.issueDate en el período (gte/lte inclusive vía toPrismaDate)', async () => {
      await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      const firstCallArgs = prisma.quote.count.mock.calls[0][0] as {
        where: { issueDate: { gte: Date; lte: Date } };
      };
      expect(firstCallArgs.where.issueDate.gte).toEqual(
        new Date('2026-08-01T00:00:00.000Z'),
      );
      expect(firstCallArgs.where.issueDate.lte).toEqual(
        new Date('2026-08-31T00:00:00.000Z'),
      );
    });

    it('los 5 valores del enum QuoteStatus aparecen exactamente una vez, en el orden del enum, incluidos los de conteo cero', async () => {
      prisma.quote.count.mockResolvedValue(0);
      const result = await service.getDashboard({}, asRole(RoleName.ADMIN));

      const statuses = result.quotes?.byStatus.map((row) => row.status);
      expect(statuses).toEqual([
        QuoteStatus.PENDING,
        QuoteStatus.ACCEPTED,
        QuoteStatus.REJECTED,
        QuoteStatus.EXPIRED,
        QuoteStatus.CONVERTED,
      ]);
      expect(new Set(statuses).size).toBe(Object.values(QuoteStatus).length);
      expect(result.quotes?.byStatus.every((row) => row.count === 0)).toBe(
        true,
      );
    });

    it('total es una consulta independiente (1) + 5 por bucket = 6 consultas de cardinalidad fija', async () => {
      prisma.quote.count
        .mockResolvedValueOnce(6) // total (independiente, sin condición de estado)
        .mockResolvedValueOnce(2) // PENDING
        .mockResolvedValueOnce(1) // ACCEPTED
        .mockResolvedValueOnce(0) // REJECTED
        .mockResolvedValueOnce(0) // EXPIRED
        .mockResolvedValueOnce(3); // CONVERTED

      const result = await service.getDashboard({}, asRole(RoleName.ADMIN));

      expect(prisma.quote.count).toHaveBeenCalledTimes(6);
      expect(result.quotes?.total).toBe(6);
    });

    // ========================================================================
    // Fase 9, remediación EXPIRED (§16): byStatus usa estado EFECTIVO
    // (idéntico a GET /quotes y R8), evaluado contra la fecha de negocio
    // America/Lima ACTUAL — nunca contra from/to del Dashboard.
    // ========================================================================
    describe('estado EFECTIVO (EXPIRED derivado, §16)', () => {
      it('cada bucket usa la condición WHERE de estado EFECTIVO (idéntica a QuotesService/R8); el total es una consulta plana sin condición de estado', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.count.mockResolvedValue(0);

          await service.getDashboard(
            { from: '2026-08-01', to: '2026-08-31' },
            asRole(RoleName.ADMIN),
          );

          const calls = prisma.quote.count.mock.calls;
          expect(calls).toHaveLength(6);

          // Llamada 0: total, solo issueDate, sin condición de estado.
          expect(calls[0][0]).toEqual({
            where: {
              issueDate: {
                gte: new Date('2026-08-01T00:00:00.000Z'),
                lte: new Date('2026-08-31T00:00:00.000Z'),
              },
            },
          });

          // Llamada 1 = PENDING (orden del enum): excluye las vencidas.
          const pendingCall = calls[1][0] as { where: { AND: unknown[] } };
          expect(pendingCall.where.AND).toContainEqual({
            status: 'PENDING',
            expirationDate: { gte: new Date('2026-08-23T00:00:00.000Z') },
          });

          // Llamada 4 = EXPIRED (orden del enum): OR crudo EXPIRED ∪ vencidas.
          const expiredCall = calls[4][0] as { where: { AND: unknown[] } };
          expect(expiredCall.where.AND).toContainEqual({
            OR: [
              { status: 'EXPIRED' },
              {
                status: { in: ['PENDING', 'ACCEPTED'] },
                expirationDate: { lt: new Date('2026-08-23T00:00:00.000Z') },
              },
            ],
          });
        } finally {
          jest.useRealTimers();
        }
      });

      it('una cotización vencida baja de su bucket activo crudo y sube en EXPIRED, sin doble conteo: total === sum(byStatus)', async () => {
        // Simula el efecto de una cotización que se venció: antes contaría
        // en PENDING, ahora cuenta en EXPIRED. Los 6 conteos siguen sumando
        // el mismo total (5), nunca 6.
        prisma.quote.count
          .mockResolvedValueOnce(5) // total
          .mockResolvedValueOnce(2) // PENDING (una menos: la vencida ya no cuenta aquí)
          .mockResolvedValueOnce(1) // ACCEPTED
          .mockResolvedValueOnce(0) // REJECTED
          .mockResolvedValueOnce(1) // EXPIRED (la que venció)
          .mockResolvedValueOnce(1); // CONVERTED

        const result = await service.getDashboard({}, asRole(RoleName.ADMIN));

        const byStatus = new Map(
          result.quotes!.byStatus.map((r) => [r.status, r.count]),
        );
        expect(byStatus.get(QuoteStatus.PENDING)).toBe(2);
        expect(byStatus.get(QuoteStatus.EXPIRED)).toBe(1);
        expect(result.quotes!.total).toBe(5);
        const sum = result.quotes!.byStatus.reduce(
          (accumulated, row) => accumulated + row.count,
          0,
        );
        expect(sum).toBe(result.quotes!.total);
        // Cada fila tiene exactamente status+count, sin campo de porcentaje.
        for (const row of result.quotes!.byStatus) {
          expect(Object.keys(row).sort()).toEqual(['count', 'status']);
        }
      });

      it('el período del Dashboard filtra únicamente Quote.issueDate; la vigencia efectiva usa la fecha de negocio ACTUAL, no from/to', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.count.mockResolvedValue(0);

          // from/to muy en el pasado: si la vigencia se evaluara contra
          // `to` en vez de "hoy", la condición usaría 2020-01-31.
          await service.getDashboard(
            { from: '2020-01-01', to: '2020-01-31' },
            asRole(RoleName.ADMIN),
          );

          const expiredCall = prisma.quote.count.mock.calls[4][0] as {
            where: { AND: unknown[] };
          };
          expect(expiredCall.where.AND).toContainEqual({
            OR: [
              { status: 'EXPIRED' },
              {
                status: { in: ['PENDING', 'ACCEPTED'] },
                // Fecha de HOY (2026-08-23), no la de `to` (2020-01-31).
                expirationDate: { lt: new Date('2026-08-23T00:00:00.000Z') },
              },
            ],
          });
        } finally {
          jest.useRealTimers();
        }
      });
    });
  });

  // ==========================================================================
  // Receivables
  // ==========================================================================
  describe('sección receivables', () => {
    it('Sale.status=ACTIVE AND balanceDue>0, SIN filtro de período', async () => {
      await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      const aggCalls = prisma.sale.aggregate.mock.calls as Array<
        [{ where: Record<string, unknown> }]
      >;
      const receivableCall = aggCalls.find(
        ([args]) => args.where.balanceDue !== undefined,
      );
      expect(receivableCall).toBeDefined();
      const [args] = receivableCall!;
      expect(args.where.status).toBe('ACTIVE');
      expect(args.where.balanceDue).toEqual({ gt: 0 });
      expect(args.where.confirmedAt).toBeUndefined();
    });

    it('serializa count/totalBalance, vacío -> 0 / "0.00" / []', async () => {
      const result = await service.getDashboard({}, asRole(RoleName.ADMIN));
      expect(result.receivables).toEqual({
        count: 0,
        totalBalance: '0.00',
        oldest: [],
      });
    });

    it('oldest ordenado confirmedAt ASC, id ASC; daysOutstanding calculado; money fixed2', async () => {
      jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
      try {
        prisma.sale.findMany.mockResolvedValue([
          {
            id: 'sale-1',
            number: 'NV-000001',
            customerId: 'cust-1',
            customerName: 'Cliente Uno',
            confirmedAt: new Date('2026-08-10T15:00:00.000Z'),
            total: new Prisma.Decimal('500'),
            paidAmount: new Prisma.Decimal('200'),
            balanceDue: new Prisma.Decimal('300'),
          },
        ]);
        prisma.sale.aggregate.mockImplementation(
          (args: { where: { balanceDue?: unknown } }) =>
            Promise.resolve(
              args.where.balanceDue !== undefined
                ? {
                    _count: { _all: 1 },
                    _sum: { balanceDue: new Prisma.Decimal('300') },
                  }
                : emptySaleAgg(),
            ),
        );

        const result = await service.getDashboard({}, asRole(RoleName.ADMIN));

        expect(result.receivables).toEqual({
          count: 1,
          totalBalance: '300.00',
          oldest: [
            {
              saleId: 'sale-1',
              saleNumber: 'NV-000001',
              customerId: 'cust-1',
              customerName: 'Cliente Uno',
              confirmedAt: new Date('2026-08-10T15:00:00.000Z'),
              total: '500.00',
              paidAmount: '200.00',
              balanceDue: '300.00',
              daysOutstanding: 13,
            },
          ],
        });

        const findManyArgs = prisma.sale.findMany.mock.calls[0][0] as {
          orderBy: unknown;
          take: number;
        };
        expect(findManyArgs.orderBy).toEqual([
          { confirmedAt: 'asc' },
          { id: 'asc' },
        ]);
        expect(findManyArgs.take).toBe(5);
      } finally {
        jest.useRealTimers();
      }
    });
  });

  // ==========================================================================
  // Matriz de roles y elisión de consultas (invariante crítico del Bloque C)
  // ==========================================================================
  describe('matriz de roles y elisión de consultas ocultas', () => {
    it('ADMIN: las 5 secciones no-null, las 5 familias de consulta se ejecutan', async () => {
      const result = await service.getDashboard({}, asRole(RoleName.ADMIN));
      expect(result.sales).not.toBeNull();
      expect(result.collections).not.toBeNull();
      expect(result.lowStock).not.toBeNull();
      expect(result.quotes).not.toBeNull();
      expect(result.receivables).not.toBeNull();
      expect(prisma.sale.aggregate).toHaveBeenCalled();
      expect(prisma.payment.aggregate).toHaveBeenCalled();
      expect(prisma.$queryRaw).toHaveBeenCalled();
      expect(prisma.quote.count).toHaveBeenCalled();
      expect(prisma.sale.findMany).toHaveBeenCalled();
    });

    it('MANAGEMENT: idéntico a ADMIN (las 5 no-null)', async () => {
      const result = await service.getDashboard(
        {},
        asRole(RoleName.MANAGEMENT),
      );
      expect(result.sales).not.toBeNull();
      expect(result.collections).not.toBeNull();
      expect(result.lowStock).not.toBeNull();
      expect(result.quotes).not.toBeNull();
      expect(result.receivables).not.toBeNull();
    });

    it('SELLER: lowStock=null y CERO consultas $queryRaw; el resto no-null', async () => {
      const result = await service.getDashboard({}, asRole(RoleName.SELLER));
      expect(result.lowStock).toBeNull();
      expect(result.sales).not.toBeNull();
      expect(result.collections).not.toBeNull();
      expect(result.quotes).not.toBeNull();
      expect(result.receivables).not.toBeNull();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: únicamente lowStock no-null; CERO consultas de sales/collections/quotes/receivables', async () => {
      const result = await service.getDashboard({}, asRole(RoleName.WAREHOUSE));
      expect(result.lowStock).not.toBeNull();
      expect(result.sales).toBeNull();
      expect(result.collections).toBeNull();
      expect(result.quotes).toBeNull();
      expect(result.receivables).toBeNull();
      expect(prisma.sale.aggregate).not.toHaveBeenCalled();
      expect(prisma.payment.aggregate).not.toHaveBeenCalled();
      expect(prisma.quote.count).not.toHaveBeenCalled();
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
    });

    it('rol desconocido: las 5 secciones null, CERO consultas de ninguna sección', async () => {
      const result = await service.getDashboard(
        {},
        asRole('NOT_A_ROLE' as RoleName),
      );
      expect(result.sales).toBeNull();
      expect(result.collections).toBeNull();
      expect(result.lowStock).toBeNull();
      expect(result.quotes).toBeNull();
      expect(result.receivables).toBeNull();
      expect(prisma.sale.aggregate).not.toHaveBeenCalled();
      expect(prisma.payment.aggregate).not.toHaveBeenCalled();
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
      expect(prisma.quote.count).not.toHaveBeenCalled();
      expect(prisma.sale.findMany).not.toHaveBeenCalled();
    });

    it('el período resuelto siempre está presente, incluso cuando las 5 secciones son null', async () => {
      const result = await service.getDashboard(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole('NOT_A_ROLE' as RoleName),
      );
      expect(result.period).toEqual({ from: '2026-08-01', to: '2026-08-31' });
    });
  });

  // ==========================================================================
  // P6-E2 — permisos por vendedor
  // ==========================================================================
  describe('permisos por vendedor (P6-E2)', () => {
    const OWN_SELLER_ID = 'seller-own';

    describe('sales', () => {
      it('1/2/20. SELLER: Sale.sellerId se agrega al WHERE del propio aggregate, antes de calcularlo (nunca un total global filtrado después)', async () => {
        await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.sale.aggregate.mock.calls[0][0] as {
          where: { status: string; sellerId?: string };
        };
        expect(args.where.sellerId).toBe(OWN_SELLER_ID);
      });

      it('13/14. ADMIN y MANAGEMENT: sin condición de propiedad en sales', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.sale.aggregate.mockClear();
          prisma.sale.aggregate.mockResolvedValue(emptySaleAgg());

          await service.getDashboard(
            { from: '2026-08-01', to: '2026-08-31' },
            asRole(role, OWN_SELLER_ID),
          );

          const args = prisma.sale.aggregate.mock.calls[0][0] as {
            where: { sellerId?: string };
          };
          expect(args.where.sellerId).toBeUndefined();
        }
      });

      it('12. SELLER sin ventas propias en el período: count 0, total "0.00" (contrato vigente, nunca cifras ajenas)', async () => {
        prisma.sale.aggregate.mockResolvedValue(emptySaleAgg());
        const result = await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(result.sales).toEqual({ count: 0, total: '0.00' });
      });
    });

    describe('collections', () => {
      it('3/4/20. SELLER: el alcance es Payment -> Sale.sellerId (nunca Payment.createdByUserId), agregado ANTES del aggregate', async () => {
        await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.payment.aggregate.mock.calls[0][0] as {
          where: { sale?: { sellerId: string }; createdByUserId?: unknown };
        };
        expect(args.where.sale).toEqual({ sellerId: OWN_SELLER_ID });
        expect(args.where.createdByUserId).toBeUndefined();
        expect(JSON.stringify(args.where)).not.toContain('createdByUserId');
      });

      it('5. un cobro histórico del propio SELLER sobre una venta ajena no se incluye: la condición es sobre la VENTA, no sobre quien cobró', async () => {
        await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.payment.aggregate.mock.calls[0][0] as {
          where: { sale?: { sellerId: string } };
        };
        // La restricción exige sale.sellerId = OWN_SELLER_ID sin importar
        // quién registró el pago: un Payment con createdByUserId distinto
        // (p. ej. un ADMIN) satisface igual esta condición mientras la
        // venta sea del SELLER; uno sobre una venta ajena, nunca.
        expect(args.where.sale).toEqual({ sellerId: OWN_SELLER_ID });
      });

      it('13/14. ADMIN y MANAGEMENT: sin condición de venta en collections', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.payment.aggregate.mockClear();
          prisma.payment.aggregate.mockResolvedValue(emptyPaymentAgg());

          await service.getDashboard(
            { from: '2026-08-01', to: '2026-08-31' },
            asRole(role, OWN_SELLER_ID),
          );

          const args = prisma.payment.aggregate.mock.calls[0][0] as {
            where: { sale?: unknown };
          };
          expect(args.where.sale).toBeUndefined();
        }
      });

      it('12. SELLER sin cobros propios en el período: count 0, total "0.00"', async () => {
        prisma.payment.aggregate.mockResolvedValue(emptyPaymentAgg());
        const result = await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(result.collections).toEqual({ count: 0, total: '0.00' });
      });
    });

    describe('quotes', () => {
      it('6/7/20. SELLER: Quote.sellerId se agrega a baseWhere UNA sola vez — llega a los 6 conteos (total + 5 estados), nunca solo al total', async () => {
        prisma.quote.count.mockResolvedValue(0);
        await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        expect(prisma.quote.count).toHaveBeenCalledTimes(6);
        const calls = prisma.quote.count.mock.calls as Array<
          [{ where: { sellerId?: string; AND?: unknown[] } }]
        >;
        // Llamada 0: total, condición plana (sellerId junto a issueDate).
        expect(calls[0][0].where.sellerId).toBe(OWN_SELLER_ID);
        // Llamadas 1-5 (por estado): sellerId viaje dentro del AND junto
        // con issueDate (mismo baseWhere reutilizado), no se pierde.
        for (let i = 1; i <= 5; i++) {
          const where = calls[i][0].where;
          expect(JSON.stringify(where)).toContain(OWN_SELLER_ID);
        }
      });

      it('13/14. ADMIN y MANAGEMENT: sin condición de propiedad en quotes', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.quote.count.mockClear();
          prisma.quote.count.mockResolvedValue(0);

          await service.getDashboard(
            { from: '2026-08-01', to: '2026-08-31' },
            asRole(role, OWN_SELLER_ID),
          );

          const firstCall = prisma.quote.count.mock.calls[0][0] as {
            where: { sellerId?: string };
          };
          expect(firstCall.where.sellerId).toBeUndefined();
        }
      });

      it('12. SELLER sin cotizaciones propias en el período: total 0, los 5 estados en 0 (nunca cifras ajenas)', async () => {
        prisma.quote.count.mockResolvedValue(0);
        const result = await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(result.quotes?.total).toBe(0);
        expect(result.quotes?.byStatus.every((row) => row.count === 0)).toBe(
          true,
        );
      });
    });

    describe('receivables', () => {
      it('8/9/20. SELLER: Sale.sellerId se agrega al MISMO where que alimenta aggregate() y findMany()', async () => {
        await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const aggCalls = prisma.sale.aggregate.mock.calls as Array<
          [{ where: Record<string, unknown> }]
        >;
        const receivableAggArgs = aggCalls.find(
          ([args]) => args.where.balanceDue !== undefined,
        )![0];
        expect(receivableAggArgs.where.sellerId).toBe(OWN_SELLER_ID);

        const findManyArgs = prisma.sale.findMany.mock.calls[0][0] as {
          where: Record<string, unknown>;
        };
        expect(findManyArgs.where.sellerId).toBe(OWN_SELLER_ID);
        expect(findManyArgs.where.balanceDue).toEqual({ gt: 0 });
      });

      it('10/11. el top 5 se construye con el where YA restringido (antes de take:5): nunca nombres ni saldos de ventas ajenas', async () => {
        prisma.sale.findMany.mockResolvedValue([
          {
            id: 'sale-own',
            number: 'NV-000099',
            customerId: 'cust-own',
            customerName: 'Cliente Propio',
            confirmedAt: new Date('2026-08-10T15:00:00.000Z'),
            total: new Prisma.Decimal('500'),
            paidAmount: new Prisma.Decimal('200'),
            balanceDue: new Prisma.Decimal('300'),
          },
        ]);
        prisma.sale.aggregate.mockImplementation(
          (args: { where: { balanceDue?: unknown } }) =>
            Promise.resolve(
              args.where.balanceDue !== undefined
                ? {
                    _count: { _all: 1 },
                    _sum: { balanceDue: new Prisma.Decimal('300') },
                  }
                : emptySaleAgg(),
            ),
        );

        const result = await service.getDashboard(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        expect(result.receivables?.oldest).toHaveLength(1);
        expect(result.receivables?.oldest[0].customerName).toBe(
          'Cliente Propio',
        );
        const findManyArgs = prisma.sale.findMany.mock.calls[0][0] as {
          where: { sellerId?: string };
          take: number;
        };
        // La restricción por propietario está en el MISMO where que ya
        // lleva `take: 5` — no es un post-filtrado tras recibir más filas.
        expect(findManyArgs.where.sellerId).toBe(OWN_SELLER_ID);
        expect(findManyArgs.take).toBe(5);
      });

      it('13/14. ADMIN y MANAGEMENT: sin condición de propiedad en receivables', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.sale.aggregate.mockClear();
          prisma.sale.findMany.mockClear();
          prisma.sale.aggregate.mockResolvedValue(emptySaleAgg());
          prisma.sale.findMany.mockResolvedValue([]);

          await service.getDashboard({}, asRole(role, OWN_SELLER_ID));

          const findManyArgs = prisma.sale.findMany.mock.calls[0][0] as {
            where: { sellerId?: string };
          };
          expect(findManyArgs.where.sellerId).toBeUndefined();
        }
      });

      it('12. SELLER sin cuentas por cobrar propias: count 0, totalBalance "0.00", oldest []', async () => {
        prisma.sale.aggregate.mockResolvedValue(emptySaleAgg());
        prisma.sale.findMany.mockResolvedValue([]);
        const result = await service.getDashboard(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(result.receivables).toEqual({
          count: 0,
          totalBalance: '0.00',
          oldest: [],
        });
      });
    });

    describe('lowStock y matriz general', () => {
      it('16. SELLER sigue sin lowStock (ya oculto por rol, sin relación con la propiedad); el resto no-null', async () => {
        const result = await service.getDashboard(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(result.lowStock).toBeNull();
        expect(result.sales).not.toBeNull();
        expect(result.collections).not.toBeNull();
        expect(result.quotes).not.toBeNull();
        expect(result.receivables).not.toBeNull();
      });

      it('15. WAREHOUSE conserva únicamente lowStock; cero consultas de sales/collections/quotes/receivables, igual que antes de P6-E2', async () => {
        const result = await service.getDashboard(
          {},
          asRole(RoleName.WAREHOUSE, OWN_SELLER_ID),
        );
        expect(result.lowStock).not.toBeNull();
        expect(result.sales).toBeNull();
        expect(result.collections).toBeNull();
        expect(result.quotes).toBeNull();
        expect(result.receivables).toBeNull();
        expect(prisma.sale.aggregate).not.toHaveBeenCalled();
        expect(prisma.payment.aggregate).not.toHaveBeenCalled();
        expect(prisma.quote.count).not.toHaveBeenCalled();
        expect(prisma.sale.findMany).not.toHaveBeenCalled();
      });

      it('17. cambio de rol activo: mismo id, distinto rol -> distinto alcance (SELLER acotado, luego ADMIN global)', async () => {
        await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        const sellerArgs = prisma.sale.aggregate.mock.calls[0][0] as {
          where: { sellerId?: string };
        };
        expect(sellerArgs.where.sellerId).toBe(OWN_SELLER_ID);

        prisma.sale.aggregate.mockClear();
        prisma.sale.aggregate.mockResolvedValue(emptySaleAgg());

        await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.ADMIN, OWN_SELLER_ID),
        );
        const adminArgs = prisma.sale.aggregate.mock.calls[0][0] as {
          where: { sellerId?: string };
        };
        expect(adminArgs.where.sellerId).toBeUndefined();
      });

      it('19. la forma JSON de la respuesta no cambia (mismas 5 claves, mismos tipos)', async () => {
        const result = await service.getDashboard(
          { from: '2026-08-01', to: '2026-08-31' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );
        expect(Object.keys(result).sort()).toEqual(
          [
            'collections',
            'lowStock',
            'period',
            'quotes',
            'receivables',
            'sales',
          ].sort(),
        );
        expect(result.sales).toEqual(
          expect.objectContaining({
            count: expect.any(Number) as number,
            total: expect.any(String) as string,
          }),
        );
      });
    });
  });
});
