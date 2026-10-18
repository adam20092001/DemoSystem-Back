import { BadRequestException } from '@nestjs/common';
import { Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { SaleAccessRequester } from '../sales/sale-access.policy';
import { ReportsService } from './reports.service';

const ACTOR_ID = 'actor-id';

/** Mismo helper que PaymentsService.list()/QuotesService.findOne() (P1-P6). */
function asRole(role: RoleName, id: string = ACTOR_ID): SaleAccessRequester {
  return { id, role };
}

function createPrismaMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
    quote: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    payment: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
  };
}

describe('ReportsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: ReportsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    service = new ReportsService(prisma as unknown as PrismaService);
  });

  // ==========================================================================
  // Defensa en profundidad: rol sin acceso -> página vacía, sin tocar Prisma
  // ==========================================================================
  describe('defensa de rol (fail-closed) — común a los 5 métodos', () => {
    const FORBIDDEN_ROLES = [RoleName.WAREHOUSE];

    it.each(FORBIDDEN_ROLES)(
      'salesByProduct: %s -> página vacía, $queryRaw nunca llamado',
      async (role) => {
        const result = await service.salesByProduct({}, asRole(role));
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      },
    );

    it.each(FORBIDDEN_ROLES)(
      'salesByCustomer: %s -> página vacía, $queryRaw nunca llamado',
      async (role) => {
        const result = await service.salesByCustomer({}, asRole(role));
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      },
    );

    it.each(FORBIDDEN_ROLES)(
      'salesBySeller: %s -> página vacía, $queryRaw nunca llamado',
      async (role) => {
        const result = await service.salesBySeller({}, asRole(role));
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      },
    );

    it.each(FORBIDDEN_ROLES)(
      'quotesByStatus: %s -> página vacía, Prisma.quote nunca llamado',
      async (role) => {
        const result = await service.quotesByStatus({}, asRole(role));
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.quote.findMany).not.toHaveBeenCalled();
        expect(prisma.quote.count).not.toHaveBeenCalled();
      },
    );

    it.each(FORBIDDEN_ROLES)(
      'paymentsByMethod: %s -> página vacía, Prisma.payment nunca llamado',
      async (role) => {
        const result = await service.paymentsByMethod({}, asRole(role));
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.payment.findMany).not.toHaveBeenCalled();
        expect(prisma.payment.count).not.toHaveBeenCalled();
      },
    );

    it('rol desconocido (default del switch) también falla cerrado', async () => {
      const result = await service.salesByProduct(
        {},
        asRole('NOT_A_ROLE' as RoleName),
      );
      expect(result.data).toEqual([]);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // Validación de rango de fechas — revalidada en el servicio para los 5
  // ==========================================================================
  describe('validación de rango from/to', () => {
    it('from posterior a to -> 400, sin tocar Prisma', async () => {
      await expect(
        service.salesByProduct(
          { from: '2026-08-31', to: '2026-08-01' },
          asRole(RoleName.ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });

    it('from con formato inválido -> 400', async () => {
      await expect(
        service.paymentsByMethod(
          { from: '2026/08/01' },
          asRole(RoleName.ADMIN),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });
  });

  // ==========================================================================
  // R2 — salesByProduct
  // ==========================================================================
  describe('salesByProduct (R2)', () => {
    it('filtra siempre por Sale ACTIVE y agrega from/to/categoryId/productId como condiciones parametrizadas', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesByProduct(
        {
          from: '2026-08-01',
          to: '2026-08-31',
          categoryId: 'cat-1',
          productId: 'prod-1',
        },
        asRole(RoleName.ADMIN),
      );

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).toContain("s.status = 'ACTIVE'");
      expect(rowsSql.text).toContain('s.confirmed_at >=');
      expect(rowsSql.text).toContain('s.confirmed_at <');
      expect(rowsSql.text).toContain('p.category_id =');
      expect(rowsSql.text).toContain('si.product_id =');
      expect(rowsSql.values).toEqual(
        expect.arrayContaining(['cat-1', 'prod-1']),
      );
    });

    it('orden fijo totalSold DESC, productId ASC (agregado en PostgreSQL, sin orderBy del cliente)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesByProduct({}, asRole(RoleName.MANAGEMENT));

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      const text = rowsSql.text.replace(/\s+/g, ' ');
      expect(text).toMatch(/ORDER BY SUM\( CASE .* END\) DESC, p\.id ASC/);
      expect(rowsSql.text).toContain(
        'GROUP BY p.id, p.sku, p.name, c.id, c.name',
      );
    });

    it('R2-B6: totalSold usa el importe de línea AL CLIENTE con la tasa CONGELADA de cada venta (mismo CASE en SUM y ORDER BY)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesByProduct({}, asRole(RoleName.ADMIN));

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      const text = rowsSql.text.replace(/\s+/g, ' ');
      const lineExpression =
        'CASE WHEN s.prices_include_tax OR NOT s.tax_enabled THEN si.line_total ELSE ROUND(si.line_total * (1 + s.tax_rate / 100), 2) END';
      expect(text).toContain(`SUM( ${lineExpression}) AS "totalSold"`);
      expect(text).toContain(`ORDER BY SUM( ${lineExpression}) DESC`);
      // Nunca la configuración vigente ni un SUM directo de line_total.
      expect(text).not.toContain('company_settings');
      expect(text).not.toContain('SUM(si.line_total)');
      // quantitySold no cambia.
      expect(text).toContain('SUM(si.quantity) AS "quantitySold"');
      // Sin join a pagos: varios pagos por venta nunca multiplican líneas.
      expect(text).not.toContain('payments');
    });

    it('serializa quantitySold a 3 decimales y totalSold a 2, total como número de grupos', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            productId: 'prod-1',
            sku: 'SKU-1',
            productName: 'Producto uno',
            categoryId: 'cat-1',
            categoryName: 'Categoría uno',
            quantitySold: new Prisma.Decimal('12'),
            totalSold: new Prisma.Decimal('1250.5'),
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const result = await service.salesByProduct({}, asRole(RoleName.SELLER));

      expect(result.data[0].quantitySold).toBe('12.000');
      expect(result.data[0].totalSold).toBe('1250.50');
      expect(result.total).toBe(1);
      expect(typeof result.total).toBe('number');
    });

    it('LIMIT/OFFSET calculados a partir de page/limit', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesByProduct(
        { page: 3, limit: 10 },
        asRole(RoleName.ADMIN),
      );

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.values).toEqual(expect.arrayContaining([10, 20]));
    });

    it('el conteo total es de grupos (productos), no de filas de SaleItem', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 3 }]);

      const result = await service.salesByProduct({}, asRole(RoleName.ADMIN));

      const countSql = prisma.$queryRaw.mock.calls[1][0];
      expect(countSql.text).toContain('GROUP BY si.product_id');
      expect(countSql.text).toContain('COUNT(*)::int');
      expect(result.total).toBe(3);
    });

    describe('permisos por vendedor (P6-E1)', () => {
      const OWN_SELLER_ID = 'seller-own';

      it('1. SELLER: solo agrega SaleItem de sus propias ventas (s.seller_id en el WHERE de ambas consultas)', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesByProduct(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        const countSql = prisma.$queryRaw.mock.calls[1][0];
        expect(rowsSql.text).toContain('s.seller_id =');
        expect(rowsSql.values).toEqual(expect.arrayContaining([OWN_SELLER_ID]));
        expect(countSql.text).toContain('s.seller_id =');
        expect(countSql.values).toEqual(
          expect.arrayContaining([OWN_SELLER_ID]),
        );
      });

      it('ADMIN y MANAGEMENT: sin condición de propiedad en el WHERE', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.$queryRaw.mockClear();
          prisma.$queryRaw
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ total: 0 }]);

          await service.salesByProduct({}, asRole(role));

          const rowsSql = prisma.$queryRaw.mock.calls[0][0];
          expect(rowsSql.text).not.toContain('s.seller_id =');
        }
      });

      it('16/18. WAREHOUSE mantiene el acceso denegado; ADMIN no se ve afectado', async () => {
        const denied = await service.salesByProduct(
          {},
          asRole(RoleName.WAREHOUSE),
        );
        expect(denied).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      });

      it('20. SELLER sin productos propios en el período: página vacía (no error)', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        const result = await service.salesByProduct(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
      });
    });
  });

  // ==========================================================================
  // R3 — salesByCustomer
  // ==========================================================================
  describe('salesByCustomer (R3)', () => {
    it('siempre ACTIVE-only y agrega customerId/customerType como condiciones', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesByCustomer(
        { customerId: 'cust-1', customerType: 'PERSON' },
        asRole(RoleName.ADMIN),
      );

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).toContain("s.status = 'ACTIVE'");
      expect(rowsSql.text).toContain('s.customer_id =');
      expect(rowsSql.text).toContain('c.customer_type =');
      expect(rowsSql.values).toEqual(
        expect.arrayContaining(['cust-1', 'PERSON']),
      );
    });

    it('hechos (totalSold/totalPaid/balance) provienen de Sale, nunca de otra tabla', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesByCustomer({}, asRole(RoleName.MANAGEMENT));

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).toContain('SUM(s.total)');
      expect(rowsSql.text).toContain('SUM(s.paid_amount)');
      expect(rowsSql.text).toContain('SUM(s.balance_due)');
      expect(rowsSql.text).not.toMatch(/payments|accounting_entr/i);
    });

    it('serializa montos a 2 decimales y saleCount como número; Público general es un grupo normal', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            customerId: 'public-general',
            customerName: 'Público general',
            customerDocumentNumber: null,
            customerType: null,
            saleCount: 4,
            totalSold: new Prisma.Decimal('500'),
            totalPaid: new Prisma.Decimal('500'),
            balance: new Prisma.Decimal('0'),
          },
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const result = await service.salesByCustomer({}, asRole(RoleName.SELLER));

      expect(result.data[0]).toEqual({
        customerId: 'public-general',
        customerName: 'Público general',
        customerDocumentNumber: null,
        customerType: null,
        saleCount: 4,
        totalSold: '500.00',
        totalPaid: '500.00',
        balance: '0.00',
      });
    });

    it('orden fijo totalSold DESC, customerId ASC', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesByCustomer({}, asRole(RoleName.ADMIN));

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).toContain('ORDER BY SUM(s.total) DESC, c.id ASC');
    });

    describe('permisos por vendedor (P6-E1)', () => {
      const OWN_SELLER_ID = 'seller-own';

      it('2. SELLER: solo agrega clientes e importes de sus propias ventas (s.seller_id en el WHERE de ambas consultas)', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesByCustomer(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        const countSql = prisma.$queryRaw.mock.calls[1][0];
        expect(rowsSql.text).toContain('s.seller_id =');
        expect(rowsSql.values).toEqual(expect.arrayContaining([OWN_SELLER_ID]));
        expect(countSql.text).toContain('s.seller_id =');
      });

      it('un cliente sin ventas propias del vendedor no aparece: el alcance se aplica antes de SUM/GROUP BY, nunca filtrando después', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        const result = await service.salesByCustomer(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        // El propio mock de PostgreSQL ya refleja el resultado correcto
        // (vacío); lo relevante es que la condición viaja en el WHERE de
        // la consulta agregada, no en un post-filtrado en memoria.
        expect(result.data).toEqual([]);
        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        const text = rowsSql.text.replace(/\s+/g, ' ');
        expect(text).toMatch(/WHERE[^G]*s\.seller_id =[^G]*GROUP BY/);
      });

      it('ADMIN y MANAGEMENT: sin condición de propiedad en el WHERE', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.$queryRaw.mockClear();
          prisma.$queryRaw
            .mockResolvedValueOnce([])
            .mockResolvedValueOnce([{ total: 0 }]);

          await service.salesByCustomer({}, asRole(role));

          const rowsSql = prisma.$queryRaw.mock.calls[0][0];
          expect(rowsSql.text).not.toContain('s.seller_id =');
        }
      });
    });
  });

  // ==========================================================================
  // R4 — salesBySeller (crítico)
  // ==========================================================================
  describe('salesBySeller (R4)', () => {
    it('totalCollected NUNCA filtra por Payment.paidAt (solo por saleId del cohorte y status ACTIVE)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([]) // agregación principal
        .mockResolvedValueOnce([{ total: 0 }]); // total de grupos

      await service.salesBySeller(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      const mainSql = prisma.$queryRaw.mock.calls[0][0];
      expect(mainSql.text).not.toContain('paid_at');
      expect(mainSql.text).toContain(
        'pay.status = \'ACTIVE\'::"PaymentStatus"',
      );
      expect(mainSql.text).toContain(
        'JOIN payments pay ON pay.sale_id = es.id',
      );
    });

    it('el cohorte de Sale (eligible_sales) sí respeta status ACTIVE y el rango confirmedAt/sellerId', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesBySeller(
        { from: '2026-08-01', to: '2026-08-31', sellerId: 'seller-1' },
        asRole(RoleName.ADMIN),
      );

      const mainSql = prisma.$queryRaw.mock.calls[0][0];
      expect(mainSql.text).toContain("s.status = 'ACTIVE'");
      expect(mainSql.text).toContain('s.confirmed_at >=');
      expect(mainSql.text).toContain('s.confirmed_at <');
      expect(mainSql.text).toContain('s.seller_id =');
      expect(mainSql.values).toEqual(expect.arrayContaining(['seller-1']));
    });

    it('sin filas de vendedor: no ejecuta la consulta de convertedQuotes', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([]) // agregación principal: sin vendedores
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesBySeller({}, asRole(RoleName.ADMIN));

      // Solo 2 llamadas: agregación principal + total de grupos.
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    });

    it('con filas de vendedor: consulta convertedQuotes por Quote.issueDate (independiente de Payment) y hace merge por sellerId, con 0 por defecto', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          {
            sellerId: 'seller-1',
            username: 'jdoe',
            firstName: 'Juan',
            lastName: 'Doe',
            saleCount: 2,
            totalSold: new Prisma.Decimal('800'),
            totalCollected: new Prisma.Decimal('300'),
          },
          {
            sellerId: 'seller-2',
            username: 'msmith',
            firstName: 'María',
            lastName: 'Smith',
            saleCount: 1,
            totalSold: new Prisma.Decimal('200'),
            totalCollected: new Prisma.Decimal('0'),
          },
        ])
        .mockResolvedValueOnce([{ total: 2 }])
        .mockResolvedValueOnce([{ sellerId: 'seller-1', convertedQuotes: 3 }]);

      const result = await service.salesBySeller(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
      const quotesSql = prisma.$queryRaw.mock.calls[2][0];
      expect(quotesSql.text).toContain(
        'q.status = \'CONVERTED\'::"QuoteStatus"',
      );
      expect(quotesSql.text).toContain('q.issue_date >=');
      expect(quotesSql.text).toContain('q.issue_date <=');
      expect(quotesSql.text).not.toContain('paid_at');

      expect(result.data).toEqual([
        {
          seller: {
            id: 'seller-1',
            username: 'jdoe',
            firstName: 'Juan',
            lastName: 'Doe',
          },
          saleCount: 2,
          totalSold: '800.00',
          totalCollected: '300.00',
          convertedQuotes: 3,
        },
        {
          seller: {
            id: 'seller-2',
            username: 'msmith',
            firstName: 'María',
            lastName: 'Smith',
          },
          saleCount: 1,
          totalSold: '200.00',
          totalCollected: '0.00',
          convertedQuotes: 0,
        },
      ]);
    });

    it('total es COUNT(DISTINCT seller_id) del cohorte, en una consulta separada', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 7 }]);

      const result = await service.salesBySeller({}, asRole(RoleName.ADMIN));

      const totalSql = prisma.$queryRaw.mock.calls[1][0];
      expect(totalSql.text).toContain('COUNT(DISTINCT s.seller_id)::int');
      expect(result.total).toBe(7);
    });

    it('orden fijo totalSold DESC, sellerId ASC', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.salesBySeller({}, asRole(RoleName.ADMIN));

      const mainSql = prisma.$queryRaw.mock.calls[0][0];
      expect(mainSql.text).toContain(
        'ORDER BY sa.total_sold DESC, sa.seller_id ASC',
      );
    });

    describe('permisos por vendedor (P6-E1)', () => {
      const OWN_SELLER_ID = 'seller-own';
      const OTHER_SELLER_ID = 'seller-other';

      it('3. SELLER sin sellerId: el cohorte (eligible_sales) queda acotado a su propia identidad', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesBySeller({}, asRole(RoleName.SELLER, OWN_SELLER_ID));

        const mainSql = prisma.$queryRaw.mock.calls[0][0];
        expect(mainSql.text).toContain('s.seller_id =');
        expect(mainSql.values).toEqual(expect.arrayContaining([OWN_SELLER_ID]));
      });

      it('4. SELLER con sellerId propio: ambas condiciones (obligatoria y solicitada) coexisten, compatibles', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesBySeller(
          { sellerId: OWN_SELLER_ID },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const mainSql = prisma.$queryRaw.mock.calls[0][0];
        const occurrences = mainSql.values.filter(
          (v: unknown) => v === OWN_SELLER_ID,
        );
        // Una vez por el alcance obligatorio, otra por el filtro solicitado.
        expect(occurrences).toHaveLength(2);
      });

      it('5. SELLER con sellerId ajeno: el alcance obligatorio y el filtro solicitado se combinan con AND, nunca se sustituyen (SQL contradictorio -> 0 filas en PostgreSQL real)', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesBySeller(
          { sellerId: OTHER_SELLER_ID },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const mainSql = prisma.$queryRaw.mock.calls[0][0];
        // Las DOS condiciones conviven en el mismo WHERE (AND): nunca se
        // reemplaza el alcance propio por el sellerId solicitado.
        const sellerIdConditions = (
          mainSql.text.match(/s\.seller_id = \$\d+/g) ?? []
        ).length;
        expect(sellerIdConditions).toBe(2);
        expect(mainSql.values).toEqual(
          expect.arrayContaining([OWN_SELLER_ID, OTHER_SELLER_ID]),
        );
      });

      it('ADMIN sin sellerId: ninguna condición de propiedad forzada en el cohorte', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesBySeller({}, asRole(RoleName.ADMIN));

        const mainSql = prisma.$queryRaw.mock.calls[0][0];
        expect(mainSql.text).not.toContain('s.seller_id =');
      });

      it('MANAGEMENT sin sellerId: ninguna condición de propiedad forzada en el cohorte', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesBySeller({}, asRole(RoleName.MANAGEMENT));

        const mainSql = prisma.$queryRaw.mock.calls[0][0];
        expect(mainSql.text).not.toContain('s.seller_id =');
      });

      it('6. payment_agg nunca agrega pagos de otros vendedores: deriva exclusivamente de eligible_sales, ya acotado en el mismo WHERE', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.salesBySeller({}, asRole(RoleName.SELLER, OWN_SELLER_ID));

        const mainSql = prisma.$queryRaw.mock.calls[0][0];
        const text = mainSql.text.replace(/\s+/g, ' ');
        // eligible_sales es la ÚNICA fuente de sale_agg/payment_agg: basta
        // con que su propio WHERE esté acotado (ya verificado arriba) para
        // que ambas CTE lo hereden sin tocar su JOIN.
        expect(text).toMatch(
          /eligible_sales AS \( SELECT s\.id, s\.seller_id, s\.total FROM sales s WHERE[^)]*s\.seller_id =/,
        );
      });

      it('7. convertedQuotes aplica el alcance comercial correcto mediante Quote.sellerId (defensa en profundidad, además de pageSellerIds)', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([
            {
              sellerId: OWN_SELLER_ID,
              username: 'jdoe',
              firstName: 'Juan',
              lastName: 'Doe',
              saleCount: 1,
              totalSold: new Prisma.Decimal('100'),
              totalCollected: new Prisma.Decimal('0'),
            },
          ])
          .mockResolvedValueOnce([{ total: 1 }])
          .mockResolvedValueOnce([]);

        await service.salesBySeller({}, asRole(RoleName.SELLER, OWN_SELLER_ID));

        expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);
        const quotesSql = prisma.$queryRaw.mock.calls[2][0];
        expect(quotesSql.text).toContain('q.seller_id =');
        expect(quotesSql.values).toEqual(
          expect.arrayContaining([OWN_SELLER_ID]),
        );
      });

      it('9/16/17. ADMIN conserva todos los resultados (comparación global sin restricción)', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([
            {
              sellerId: OTHER_SELLER_ID,
              username: 'msmith',
              firstName: 'María',
              lastName: 'Smith',
              saleCount: 1,
              totalSold: new Prisma.Decimal('200'),
              totalCollected: new Prisma.Decimal('0'),
            },
          ])
          .mockResolvedValueOnce([{ total: 1 }])
          .mockResolvedValueOnce([]);

        const result = await service.salesBySeller({}, asRole(RoleName.ADMIN));

        expect(result.data).toHaveLength(1);
        expect(result.data[0].seller.id).toBe(OTHER_SELLER_ID);
      });

      it('18. WAREHOUSE mantiene el acceso denegado (página vacía, sin tocar Prisma)', async () => {
        const result = await service.salesBySeller(
          {},
          asRole(RoleName.WAREHOUSE),
        );
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      });

      it('20. SELLER sin ventas elegibles en el período: página vacía, sin consultar convertedQuotes', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        const result = await service.salesBySeller(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        expect(result.data).toEqual([]);
        expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      });
    });
  });

  // ==========================================================================
  // R8 — quotesByStatus
  // ==========================================================================
  describe('quotesByStatus (R8)', () => {
    it('filtra Quote.issueDate con gte/lte inclusive (toPrismaDate), sin exclusión implícita de status', async () => {
      prisma.quote.findMany.mockResolvedValue([]);
      prisma.quote.count.mockResolvedValue(0);

      await service.quotesByStatus(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: Array<Record<string, unknown>> };
        orderBy: unknown;
      };
      expect(args.where.AND).toEqual(
        expect.arrayContaining([
          { issueDate: { gte: new Date('2026-08-01T00:00:00.000Z') } },
          { issueDate: { lte: new Date('2026-08-31T00:00:00.000Z') } },
        ]),
      );
      expect(args.orderBy).toEqual([{ issueDate: 'desc' }, { id: 'desc' }]);
    });

    it('resultingSale es null cuando no hay venta asociada, y el objeto completo cuando sí', async () => {
      prisma.quote.findMany.mockResolvedValue([
        {
          id: 'quote-1',
          number: 'COT-000001',
          customerName: 'Cliente Uno',
          total: new Prisma.Decimal('350'),
          status: 'PENDING',
          expirationDate: new Date('2099-01-01T00:00:00.000Z'),
          sale: null,
        },
        {
          id: 'quote-2',
          number: 'COT-000002',
          customerName: 'Cliente Dos',
          total: new Prisma.Decimal('500'),
          status: 'CONVERTED',
          expirationDate: new Date('2020-01-01T00:00:00.000Z'),
          sale: { id: 'sale-1', number: 'NV-000001' },
        },
      ]);
      prisma.quote.count.mockResolvedValue(2);

      const result = await service.quotesByStatus({}, asRole(RoleName.SELLER));

      expect(result.data[0].resultingSale).toBeNull();
      expect(result.data[0].total).toBe('350.00');
      expect(result.data[1].resultingSale).toEqual({
        saleId: 'sale-1',
        saleNumber: 'NV-000001',
      });
    });

    it('sin filtros: where vacío ({}), aún así pagina correctamente', async () => {
      prisma.quote.findMany.mockResolvedValue([]);
      prisma.quote.count.mockResolvedValue(0);

      await service.quotesByStatus({}, asRole(RoleName.ADMIN));

      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: unknown;
      };
      expect(args.where).toEqual({});
    });

    it('status/sellerId/customerId se agregan como condiciones exactas', async () => {
      prisma.quote.findMany.mockResolvedValue([]);
      prisma.quote.count.mockResolvedValue(0);

      await service.quotesByStatus(
        {
          status: 'CONVERTED',
          sellerId: 'seller-1',
          customerId: 'cust-1',
        },
        asRole(RoleName.ADMIN),
      );

      const args = prisma.quote.findMany.mock.calls[0][0] as {
        where: { AND: Array<Record<string, unknown>> };
      };
      expect(args.where.AND).toEqual(
        expect.arrayContaining([
          { status: 'CONVERTED' },
          { sellerId: 'seller-1' },
          { customerId: 'cust-1' },
        ]),
      );
    });

    // ========================================================================
    // Fase 9, remediación EXPIRED (§15): estado EFECTIVO idéntico a
    // GET /quotes, evaluado contra la fecha de negocio America/Lima ACTUAL.
    // ========================================================================
    describe('estado EFECTIVO (EXPIRED derivado, §15)', () => {
      it('A. PENDING vencida (expirationDate < hoy Lima) se muestra como EXPIRED', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.findMany.mockResolvedValue([
            {
              id: 'quote-1',
              number: 'COT-000001',
              customerName: 'Cliente Uno',
              total: new Prisma.Decimal('350'),
              status: 'PENDING',
              expirationDate: new Date('2026-08-01T00:00:00.000Z'),
              sale: null,
            },
          ]);
          prisma.quote.count.mockResolvedValue(1);

          const result = await service.quotesByStatus(
            {},
            asRole(RoleName.ADMIN),
          );

          expect(result.data[0].status).toBe('EXPIRED');
        } finally {
          jest.useRealTimers();
        }
      });

      it('B. ?status=EXPIRED se traduce a la condición OR (status crudo EXPIRED ∪ PENDING/ACCEPTED vencidas)', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.findMany.mockResolvedValue([]);
          prisma.quote.count.mockResolvedValue(0);

          await service.quotesByStatus(
            { status: 'EXPIRED' },
            asRole(RoleName.ADMIN),
          );

          const args = prisma.quote.findMany.mock.calls[0][0] as {
            where: { AND: Array<Record<string, unknown>> };
          };
          expect(args.where.AND).toEqual(
            expect.arrayContaining([
              {
                OR: [
                  { status: 'EXPIRED' },
                  {
                    status: { in: ['PENDING', 'ACCEPTED'] },
                    expirationDate: {
                      lt: new Date('2026-08-23T00:00:00.000Z'),
                    },
                  },
                ],
              },
            ]),
          );
        } finally {
          jest.useRealTimers();
        }
      });

      it('C. ?status=PENDING excluye las vencidas (expirationDate >= hoy Lima): ya pertenecen a EXPIRED', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.findMany.mockResolvedValue([]);
          prisma.quote.count.mockResolvedValue(0);

          await service.quotesByStatus(
            { status: 'PENDING' },
            asRole(RoleName.ADMIN),
          );

          const args = prisma.quote.findMany.mock.calls[0][0] as {
            where: { AND: Array<Record<string, unknown>> };
          };
          expect(args.where.AND).toEqual(
            expect.arrayContaining([
              {
                status: 'PENDING',
                expirationDate: { gte: new Date('2026-08-23T00:00:00.000Z') },
              },
            ]),
          );
        } finally {
          jest.useRealTimers();
        }
      });

      it('D. PENDING con vigencia futura permanece PENDING (no reinterpretada)', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.findMany.mockResolvedValue([
            {
              id: 'quote-1',
              number: 'COT-000001',
              customerName: 'Cliente Uno',
              total: new Prisma.Decimal('350'),
              status: 'PENDING',
              expirationDate: new Date('2099-01-01T00:00:00.000Z'),
              sale: null,
            },
          ]);
          prisma.quote.count.mockResolvedValue(1);

          const result = await service.quotesByStatus(
            {},
            asRole(RoleName.ADMIN),
          );

          expect(result.data[0].status).toBe('PENDING');
        } finally {
          jest.useRealTimers();
        }
      });

      it('E. REJECTED/CONVERTED se muestran tal cual, sin importar expirationDate', async () => {
        prisma.quote.findMany.mockResolvedValue([
          {
            id: 'quote-1',
            number: 'COT-000001',
            customerName: 'Cliente Uno',
            total: new Prisma.Decimal('100'),
            status: 'REJECTED',
            expirationDate: new Date('2020-01-01T00:00:00.000Z'),
            sale: null,
          },
          {
            id: 'quote-2',
            number: 'COT-000002',
            customerName: 'Cliente Dos',
            total: new Prisma.Decimal('200'),
            status: 'CONVERTED',
            expirationDate: new Date('2020-01-01T00:00:00.000Z'),
            sale: { id: 'sale-1', number: 'NV-000001' },
          },
        ]);
        prisma.quote.count.mockResolvedValue(2);

        const result = await service.quotesByStatus({}, asRole(RoleName.ADMIN));

        expect(result.data[0].status).toBe('REJECTED');
        expect(result.data[1].status).toBe('CONVERTED');
      });

      it('F. count() recibe la MISMA condición WHERE que findMany (paginación consistente con el filtro efectivo)', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.findMany.mockResolvedValue([]);
          prisma.quote.count.mockResolvedValue(0);

          await service.quotesByStatus(
            { status: 'EXPIRED' },
            asRole(RoleName.ADMIN),
          );

          const findManyArgs = prisma.quote.findMany.mock.calls[0][0] as {
            where: unknown;
          };
          const countArgs = prisma.quote.count.mock.calls[0][0] as {
            where: unknown;
          };
          expect(countArgs.where).toEqual(findManyArgs.where);
        } finally {
          jest.useRealTimers();
        }
      });

      it('G. la fecha de negocio ACTUAL determina la vigencia, nunca from/to del reporte', async () => {
        jest.useFakeTimers({ now: new Date('2026-08-23T12:00:00.000Z') });
        try {
          prisma.quote.findMany.mockResolvedValue([]);
          prisma.quote.count.mockResolvedValue(0);

          // from/to muy en el pasado: si la vigencia se evaluara contra
          // `to` en vez de "hoy", la condición usaría 2020-01-31.
          await service.quotesByStatus(
            {
              from: '2020-01-01',
              to: '2020-01-31',
              status: 'EXPIRED',
            },
            asRole(RoleName.ADMIN),
          );

          const args = prisma.quote.findMany.mock.calls[0][0] as {
            where: { AND: Array<Record<string, unknown>> };
          };
          expect(args.where.AND).toEqual(
            expect.arrayContaining([
              {
                OR: [
                  { status: 'EXPIRED' },
                  {
                    status: { in: ['PENDING', 'ACCEPTED'] },
                    // Fecha de HOY (2026-08-23), no la de `to` (2020-01-31).
                    expirationDate: {
                      lt: new Date('2026-08-23T00:00:00.000Z'),
                    },
                  },
                ],
              },
            ]),
          );
        } finally {
          jest.useRealTimers();
        }
      });
    });

    describe('permisos por vendedor (P6-E1)', () => {
      const OWN_SELLER_ID = 'seller-own';
      const OTHER_SELLER_ID = 'seller-other';

      it('8. SELLER: solo cotizaciones propias (Quote.sellerId = requester.id)', async () => {
        prisma.quote.findMany.mockResolvedValue([]);
        prisma.quote.count.mockResolvedValue(0);

        await service.quotesByStatus(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.quote.findMany.mock.calls[0][0] as {
          where: { AND: [Record<string, unknown>, unknown] };
        };
        expect(args.where.AND[0]).toEqual({ sellerId: OWN_SELLER_ID });
      });

      it('9. SELLER con sellerId ajeno: resultado vacío — el filtro se combina con AND, nunca reemplaza el alcance', async () => {
        prisma.quote.findMany.mockResolvedValue([]);
        prisma.quote.count.mockResolvedValue(0);

        await service.quotesByStatus(
          { sellerId: OTHER_SELLER_ID },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.quote.findMany.mock.calls[0][0] as {
          where: {
            AND: [Record<string, unknown>, { AND: Record<string, unknown>[] }];
          };
        };
        expect(args.where.AND[0]).toEqual({ sellerId: OWN_SELLER_ID });
        expect(args.where.AND[1]).toEqual({
          AND: [{ sellerId: OTHER_SELLER_ID }],
        });
      });

      it('10. findMany y count usan exactamente el mismo where restringido', async () => {
        prisma.quote.findMany.mockResolvedValue([]);
        prisma.quote.count.mockResolvedValue(0);

        await service.quotesByStatus(
          { status: 'CONVERTED' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const findManyArgs = prisma.quote.findMany.mock.calls[0][0] as {
          where: unknown;
        };
        const countArgs = prisma.quote.count.mock.calls[0][0] as {
          where: unknown;
        };
        expect(countArgs.where).toEqual(findManyArgs.where);
      });

      it('ADMIN y MANAGEMENT: filtros tal cual, sin condición de propiedad', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.quote.findMany.mockClear();
          prisma.quote.findMany.mockResolvedValue([]);
          prisma.quote.count.mockResolvedValue(0);

          await service.quotesByStatus(
            { sellerId: OTHER_SELLER_ID },
            asRole(role, OWN_SELLER_ID),
          );

          const args = prisma.quote.findMany.mock.calls[0][0] as {
            where: { AND: Record<string, unknown>[] };
          };
          expect(args.where.AND).toEqual([{ sellerId: OTHER_SELLER_ID }]);
        }
      });

      it('18. WAREHOUSE mantiene el acceso denegado (página vacía, sin tocar Prisma)', async () => {
        const result = await service.quotesByStatus(
          {},
          asRole(RoleName.WAREHOUSE),
        );
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.quote.findMany).not.toHaveBeenCalled();
      });
    });
  });

  // ==========================================================================
  // R9 — paymentsByMethod
  // ==========================================================================
  describe('paymentsByMethod (R9)', () => {
    it('filtra Payment.paidAt con gte/lt exclusivo (instante real), sin exclusión implícita de status', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.paymentsByMethod(
        { from: '2026-08-01', to: '2026-08-31' },
        asRole(RoleName.ADMIN),
      );

      const args = prisma.payment.findMany.mock.calls[0][0] as {
        where: { AND: Array<Record<string, unknown>> };
        orderBy: unknown;
      };
      expect(args.where.AND).toEqual(
        expect.arrayContaining([
          { paidAt: { gte: new Date('2026-08-01T05:00:00.000Z') } },
          { paidAt: { lt: new Date('2026-09-01T05:00:00.000Z') } },
        ]),
      );
      expect(args.orderBy).toEqual([{ paidAt: 'desc' }, { id: 'desc' }]);
    });

    it('mapea saleNumber/customerName del snapshot de Sale (relación anidada) y expone reference tal cual', async () => {
      prisma.payment.findMany.mockResolvedValue([
        {
          id: 'payment-1',
          paidAt: new Date('2026-08-10T10:00:00.000Z'),
          saleId: 'sale-1',
          paymentMethodCode: 'BANK_TRANSFER',
          paymentMethodName: 'Transferencia bancaria (legacy)',
          reference: 'OP-123456',
          amount: new Prisma.Decimal('500'),
          status: 'ACTIVE',
          sale: { number: 'NV-000001', customerName: 'Cliente Uno' },
          createdBy: {
            id: 'user-1',
            username: 'jdoe',
            firstName: 'Juan',
            lastName: 'Doe',
          },
        },
      ]);
      prisma.payment.count.mockResolvedValue(1);

      const result = await service.paymentsByMethod(
        {},
        asRole(RoleName.SELLER),
      );

      expect(result.data[0]).toEqual({
        paidAt: new Date('2026-08-10T10:00:00.000Z'),
        paymentId: 'payment-1',
        saleId: 'sale-1',
        saleNumber: 'NV-000001',
        customerName: 'Cliente Uno',
        method: 'BANK_TRANSFER',
        methodName: 'Transferencia bancaria (legacy)',
        reference: 'OP-123456',
        amount: '500.00',
        status: 'ACTIVE',
        createdBy: {
          id: 'user-1',
          username: 'jdoe',
          firstName: 'Juan',
          lastName: 'Doe',
        },
      });
    });

    it('todos los estados de Payment son visibles por defecto (sin condición implícita de status)', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.paymentsByMethod({}, asRole(RoleName.ADMIN));

      const args = prisma.payment.findMany.mock.calls[0][0] as {
        where: unknown;
      };
      expect(args.where).toEqual({});
    });

    it('method/status/createdByUserId se agregan como condiciones exactas (method filtra el snapshot paymentMethodCode)', async () => {
      prisma.payment.findMany.mockResolvedValue([]);
      prisma.payment.count.mockResolvedValue(0);

      await service.paymentsByMethod(
        {
          method: 'CASH',
          status: 'CANCELLED',
          createdByUserId: 'user-1',
        },
        asRole(RoleName.ADMIN),
      );

      const args = prisma.payment.findMany.mock.calls[0][0] as {
        where: { AND: Array<Record<string, unknown>> };
      };
      expect(args.where.AND).toEqual(
        expect.arrayContaining([
          { paymentMethodCode: 'CASH' },
          { status: 'CANCELLED' },
          { createdByUserId: 'user-1' },
        ]),
      );
    });

    describe('permisos por vendedor (P6-E1)', () => {
      const OWN_SELLER_ID = 'seller-own';

      it('11. SELLER: AND por la venta asociada (Payment -> Sale.sellerId), nunca por Payment.createdByUserId', async () => {
        prisma.payment.findMany.mockResolvedValue([]);
        prisma.payment.count.mockResolvedValue(0);

        await service.paymentsByMethod(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.payment.findMany.mock.calls[0][0] as {
          where: { AND: [{ sale: Record<string, unknown> }, unknown] };
        };
        expect(args.where.AND[0]).toEqual({
          sale: { sellerId: OWN_SELLER_ID },
        });
        expect(JSON.stringify(args.where)).not.toContain('createdByUserId');
      });

      it('A. un cobro registrado por el ADMIN sobre una venta del SELLER queda DENTRO del alcance (el filtro es la venta, no el cobrador)', async () => {
        prisma.payment.findMany.mockResolvedValue([]);
        prisma.payment.count.mockResolvedValue(0);

        await service.paymentsByMethod(
          {},
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.payment.findMany.mock.calls[0][0] as {
          where: { AND: [{ sale: Record<string, unknown> }, unknown] };
        };
        // La condición es exclusivamente sobre Sale.sellerId: un Payment
        // con createdByUserId distinto de OWN_SELLER_ID (p. ej. el ADMIN)
        // satisface igual esta condición mientras sale.sellerId coincida.
        expect(args.where.AND[0]).toEqual({
          sale: { sellerId: OWN_SELLER_ID },
        });
      });

      it('B/14. C. createdByUserId se combina con AND: solo ve cobros de SUS ventas realizados por ese usuario', async () => {
        prisma.payment.findMany.mockResolvedValue([]);
        prisma.payment.count.mockResolvedValue(0);

        await service.paymentsByMethod(
          { createdByUserId: 'other-user-id' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.payment.findMany.mock.calls[0][0] as {
          where: {
            AND: [
              { sale: Record<string, unknown> },
              { AND: Record<string, unknown>[] },
            ];
          };
        };
        expect(args.where.AND[0]).toEqual({
          sale: { sellerId: OWN_SELLER_ID },
        });
        expect(args.where.AND[1]).toEqual({
          AND: [{ createdByUserId: 'other-user-id' }],
        });
      });

      it('13/B. un cobro histórico del propio SELLER sobre una venta ajena NO aparece: el alcance es la venta, no quien cobró', async () => {
        prisma.payment.findMany.mockResolvedValue([]);
        prisma.payment.count.mockResolvedValue(0);

        await service.paymentsByMethod(
          { createdByUserId: OWN_SELLER_ID },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const args = prisma.payment.findMany.mock.calls[0][0] as {
          where: { AND: [{ sale: Record<string, unknown> }, unknown] };
        };
        // createdByUserId = propio NO sustituye la condición de la venta:
        // sigue exigiéndose sale.sellerId = OWN_SELLER_ID.
        expect(args.where.AND[0]).toEqual({
          sale: { sellerId: OWN_SELLER_ID },
        });
      });

      it('15. findMany y count usan exactamente el mismo where restringido', async () => {
        prisma.payment.findMany.mockResolvedValue([]);
        prisma.payment.count.mockResolvedValue(0);

        await service.paymentsByMethod(
          { method: 'cash' },
          asRole(RoleName.SELLER, OWN_SELLER_ID),
        );

        const findManyArgs = prisma.payment.findMany.mock.calls[0][0] as {
          where: unknown;
        };
        const countArgs = prisma.payment.count.mock.calls[0][0] as {
          where: unknown;
        };
        expect(countArgs.where).toEqual(findManyArgs.where);
      });

      it('ADMIN y MANAGEMENT: filtros tal cual, sin condición de venta', async () => {
        for (const role of [RoleName.ADMIN, RoleName.MANAGEMENT]) {
          prisma.payment.findMany.mockClear();
          prisma.payment.findMany.mockResolvedValue([]);
          prisma.payment.count.mockResolvedValue(0);

          await service.paymentsByMethod(
            { createdByUserId: 'other-user-id' },
            asRole(role, OWN_SELLER_ID),
          );

          const args = prisma.payment.findMany.mock.calls[0][0] as {
            where: { AND: Record<string, unknown>[] };
          };
          expect(args.where.AND).toEqual([
            { createdByUserId: 'other-user-id' },
          ]);
        }
      });

      it('18. WAREHOUSE mantiene el acceso denegado (página vacía, sin tocar Prisma)', async () => {
        const result = await service.paymentsByMethod(
          {},
          asRole(RoleName.WAREHOUSE),
        );
        expect(result).toEqual({
          data: [],
          page: 1,
          limit: 20,
          total: 0,
          totalPages: 0,
        });
        expect(prisma.payment.findMany).not.toHaveBeenCalled();
      });
    });
  });
});
