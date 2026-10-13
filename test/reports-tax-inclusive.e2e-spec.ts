import { INestApplication } from '@nestjs/common';
import {
  CustomerStage,
  CustomerStatus,
  CustomerType,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * R2-B6 — Ventas por producto con semántica de precios mezclada. Inserta
 * directamente (mismo patrón que sales.e2e-spec.ts/payments.e2e-spec.ts)
 * ventas NUEVAS (pricesIncludeTax=true) e HISTÓRICAS (false, con y sin IGV,
 * con distintas tasas congeladas) en pos_db_test y verifica la agregación
 * SQL REAL de GET /reports/sales-by-product: totalSold = Σ importe de línea
 * al cliente antes del descuento de documento, derivando el bruto de las
 * líneas históricas con IGV con la tasa CONGELADA de cada venta.
 */
describe('Reports — ventas por producto con precios finales e históricos (e2e) — R2-B6', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let adminId: string;

  let categoryId: string;
  let unitId: string;
  let customerId: string;
  let productA: { id: string; sku: string };
  let productB: { id: string; sku: string };
  let cashMethodId: string;

  const ownedSaleIds: string[] = [];
  const ownedPaymentIds: string[] = [];
  const RUN_ID = Date.now();
  let counter = 0;
  const suffix = () => `${RUN_ID}-${(counter += 1)}`;

  interface SaleFixture {
    product: { id: string; sku: string };
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    subtotal: string;
    discountAmount?: string;
    taxAmount: string;
    total: string;
    taxEnabled: boolean;
    taxRate: string;
    pricesIncludeTax: boolean;
    status?: SaleStatus;
    confirmedAt?: Date;
  }

  async function insertSale(fixture: SaleFixture): Promise<string> {
    const cancelled = fixture.status === SaleStatus.CANCELLED;
    const total = new Prisma.Decimal(fixture.total);
    const row = await prisma.sale.create({
      data: {
        number: `NV-R2B6-${suffix()}`,
        status: fixture.status ?? SaleStatus.ACTIVE,
        paymentStatus: total.isZero()
          ? SalePaymentStatus.PAID
          : SalePaymentStatus.UNPAID,
        deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
        customerId,
        customerIsGeneric: false,
        customerType: CustomerType.PERSON,
        customerName: 'Cliente R2-B6',
        sellerId: adminId,
        subtotal: new Prisma.Decimal(fixture.subtotal),
        discountAmount: new Prisma.Decimal(fixture.discountAmount ?? '0.00'),
        taxAmount: new Prisma.Decimal(fixture.taxAmount),
        total,
        currencyCode: 'PEN',
        taxEnabled: fixture.taxEnabled,
        taxRate: new Prisma.Decimal(fixture.taxRate),
        pricesIncludeTax: fixture.pricesIncludeTax,
        paidAmount: new Prisma.Decimal('0.00'),
        balanceDue: total,
        confirmedAt: fixture.confirmedAt ?? new Date(),
        cancelledAt: cancelled ? new Date() : null,
        cancellationReason: cancelled ? 'R2-B6 anulada' : null,
        cancelledByUserId: cancelled ? adminId : null,
        items: {
          create: [
            {
              productId: fixture.product.id,
              productSku: fixture.product.sku,
              productName: 'Producto R2-B6',
              unitCode: 'R2B6U',
              unitName: 'Unidad R2-B6',
              unitAbbreviation: 'r2u',
              quantity: new Prisma.Decimal(fixture.quantity),
              unitPrice: new Prisma.Decimal(fixture.unitPrice),
              lineTotal: new Prisma.Decimal(fixture.lineTotal),
            },
          ],
        },
      },
    });
    ownedSaleIds.push(row.id);
    return row.id;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(
        `No se pudo autenticar al admin de prueba: ${JSON.stringify(adminLogin.body)}`,
      );
    }
    adminCookie = adminLogin.cookie;
    adminId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
        select: { id: true },
      })
    ).id;

    const category = await prisma.category.create({
      data: { code: `R2B6C${RUN_ID}`, name: 'Categoría R2-B6' },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `R2U${String(RUN_ID).slice(-10)}`,
        name: 'Unidad R2-B6',
        abbreviation: 'r2u',
        allowDecimal: true,
        status: UnitStatus.ACTIVE,
      },
    });
    unitId = unit.id;
    const customer = await prisma.customer.create({
      data: {
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        name: 'Cliente R2-B6',
      },
    });
    customerId = customer.id;

    for (const [label, target] of [
      ['A', 'productA'],
      ['B', 'productB'],
    ] as const) {
      const product = await prisma.product.create({
        data: {
          sku: `R2B6-${label}-${RUN_ID}`,
          name: `Producto R2-B6 ${label}`,
          productType: ProductType.SERVICE,
          categoryId,
          unitId,
          salePrice: new Prisma.Decimal('118.00'),
          isInventoryTracked: false,
          status: ProductStatus.ACTIVE,
        },
      });
      if (target === 'productA') {
        productA = { id: product.id, sku: product.sku };
      } else {
        productB = { id: product.id, sku: product.sku };
      }
    }

    cashMethodId = (
      await prisma.paymentMethod.findUniqueOrThrow({
        where: { code: 'CASH' },
        select: { id: true },
      })
    ).id;
  }, 120000);

  afterAll(async () => {
    try {
      if (ownedPaymentIds.length > 0) {
        await prisma.payment.deleteMany({
          where: { id: { in: ownedPaymentIds } },
        });
      }
      if (ownedSaleIds.length > 0) {
        await prisma.sale.deleteMany({ where: { id: { in: ownedSaleIds } } });
      }
      const productIds = [productA?.id, productB?.id].filter(
        (id): id is string => id !== undefined,
      );
      if (productIds.length > 0) {
        await prisma.product.deleteMany({ where: { id: { in: productIds } } });
      }
      if (unitId) {
        await prisma.unit.deleteMany({ where: { id: unitId } });
      }
      if (categoryId) {
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }
      if (customerId) {
        await prisma.customer.deleteMany({ where: { id: customerId } });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  function salesByProduct(query: Record<string, string>) {
    return request(app.getHttpServer())
      .get('/api/v1/reports/sales-by-product')
      .query(query)
      .set('Cookie', adminCookie);
  }

  it('mezcla nuevas e históricas: totalSold = Σ importe de línea al cliente antes del descuento, con la tasa CONGELADA de cada venta; sin doble IGV ni inflado por pagos', async () => {
    // A1 — nueva con IGV incluido: 118.00 -> 118.00.
    const newSaleId = await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '118.00',
      lineTotal: '118.00',
      subtotal: '100.00',
      taxAmount: '18.00',
      total: '118.00',
      taxEnabled: true,
      taxRate: '18.00',
      pricesIncludeTax: true,
    });
    // A2 — histórica con IGV 18% (configuración vigente de pruebas: IGV
    // desactivado): 100.00 antes de impuesto -> 118.00.
    await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '100.00',
      lineTotal: '100.00',
      subtotal: '100.00',
      taxAmount: '18.00',
      total: '118.00',
      taxEnabled: true,
      taxRate: '18.00',
      pricesIncludeTax: false,
    });
    // A3 — histórica sin IGV: 50.00 -> 50.00.
    await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '50.00',
      lineTotal: '50.00',
      subtotal: '50.00',
      taxAmount: '0.00',
      total: '50.00',
      taxEnabled: false,
      taxRate: '18.00',
      pricesIncludeTax: false,
    });
    // A4 — histórica al 10%: 100.00 -> 110.00.
    await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '100.00',
      lineTotal: '100.00',
      subtotal: '100.00',
      taxAmount: '10.00',
      total: '110.00',
      taxEnabled: true,
      taxRate: '10.00',
      pricesIncludeTax: false,
    });
    // A5 — histórica al 12.5% con cantidad fraccionaria: 0.333 × 10.00 =
    // 3.33 -> ROUND(3.33 × 1.125) = ROUND(3.74625) = 3.75.
    await insertSale({
      product: productA,
      quantity: '0.333',
      unitPrice: '10.00',
      lineTotal: '3.33',
      subtotal: '3.33',
      taxAmount: '0.42',
      total: '3.75',
      taxEnabled: true,
      taxRate: '12.50',
      pricesIncludeTax: false,
    });
    // A6 — nueva con descuento de documento 11.80: aporta 118.00 (antes del
    // descuento), no el total 106.20.
    await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '118.00',
      lineTotal: '118.00',
      subtotal: '100.00',
      discountAmount: '10.00',
      taxAmount: '16.20',
      total: '106.20',
      taxEnabled: true,
      taxRate: '18.00',
      pricesIncludeTax: true,
    });
    // A7 — histórica al 18% en la frontera de redondeo: 0.75 × 1.18 = 0.885
    // -> HALF_UP 0.89 (HALF_EVEN daría 0.88).
    await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '0.75',
      lineTotal: '0.75',
      subtotal: '0.75',
      taxAmount: '0.14',
      total: '0.89',
      taxEnabled: true,
      taxRate: '18.00',
      pricesIncludeTax: false,
    });
    // Excluidas por las reglas existentes: ANULADA y fuera de rango.
    await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '100.00',
      lineTotal: '100.00',
      subtotal: '100.00',
      taxAmount: '18.00',
      total: '118.00',
      taxEnabled: true,
      taxRate: '18.00',
      pricesIncludeTax: false,
      status: SaleStatus.CANCELLED,
    });
    await insertSale({
      product: productA,
      quantity: '1',
      unitPrice: '1000.00',
      lineTotal: '1000.00',
      subtotal: '847.46',
      taxAmount: '152.54',
      total: '1000.00',
      taxEnabled: true,
      taxRate: '18.00',
      pricesIncludeTax: true,
      confirmedAt: new Date('2000-01-15T12:00:00.000Z'),
    });
    // B — nueva con IGV incluido: 200.00.
    await insertSale({
      product: productB,
      quantity: '2',
      unitPrice: '100.00',
      lineTotal: '200.00',
      subtotal: '169.49',
      taxAmount: '30.51',
      total: '200.00',
      taxEnabled: true,
      taxRate: '18.00',
      pricesIncludeTax: true,
    });

    // Pagos múltiples sobre A1 (100 + 10 + 8 = 118): nunca inflan totalSold.
    for (const amount of ['100.00', '10.00', '8.00']) {
      const payment = await prisma.payment.create({
        data: {
          saleId: newSaleId,
          amount: new Prisma.Decimal(amount),
          status: PaymentStatus.ACTIVE,
          paidAt: new Date(),
          createdByUserId: adminId,
          paymentMethodId: cashMethodId,
          paymentMethodCode: 'CASH',
          paymentMethodName: 'Efectivo',
          paymentMethodAffectsCashDrawer: true,
        },
      });
      ownedPaymentIds.push(payment.id);
    }
    await prisma.sale.update({
      where: { id: newSaleId },
      data: {
        paidAmount: new Prisma.Decimal('118.00'),
        balanceDue: new Prisma.Decimal('0.00'),
        paymentStatus: SalePaymentStatus.PAID,
      },
    });

    const salesBefore = await prisma.sale.findMany({
      where: { id: { in: ownedSaleIds } },
      include: { items: true },
      orderBy: { id: 'asc' },
    });

    const response = await salesByProduct({
      categoryId,
      from: '2001-01-01',
    });
    expect(response.status).toBe(200);
    const body = response.body as {
      data: {
        productId: string;
        quantitySold: string;
        totalSold: string;
      }[];
      total: number;
    };

    expect(body.total).toBe(2);
    // Ranking existente: totalSold DESC.
    expect(body.data.map((row) => row.productId)).toEqual([
      productA.id,
      productB.id,
    ]);
    // 118.00 + 118.00 + 50.00 + 110.00 + 3.75 + 118.00 + 0.89 = 518.64.
    expect(body.data[0]).toMatchObject({
      quantitySold: '6.333',
      totalSold: '518.64',
    });
    expect(body.data[1]).toMatchObject({
      quantitySold: '2.000',
      totalSold: '200.00',
    });

    // Filtro de fechas existente: solo la venta del año 2000.
    const old = await salesByProduct({
      categoryId,
      from: '2000-01-01',
      to: '2000-12-31',
    });
    expect((old.body as { data: { totalSold: string }[] }).data).toEqual([
      expect.objectContaining({ productId: productA.id, totalSold: '1000.00' }),
    ]);

    // Ningún registro histórico (ni nuevo) fue modificado por el reporte.
    const salesAfter = await prisma.sale.findMany({
      where: { id: { in: ownedSaleIds } },
      include: { items: true },
      orderBy: { id: 'asc' },
    });
    expect(JSON.stringify(salesAfter)).toBe(JSON.stringify(salesBefore));
  });

  it('reportes por cliente y por vendedor siguen usando el total a pagar persistido (sin IGV adicional)', async () => {
    const byCustomer = await request(app.getHttpServer())
      .get('/api/v1/reports/sales-by-customer')
      .query({ customerId, from: '2001-01-01' })
      .set('Cookie', adminCookie);
    expect(byCustomer.status).toBe(200);
    const row = (
      byCustomer.body as {
        data: { customerId: string; totalSold: string; totalPaid: string }[];
      }
    ).data.find((item) => item.customerId === customerId);
    // Σ total de las ventas ACTIVE en rango del cliente:
    // 118 + 118 + 50 + 110 + 3.75 + 106.20 + 0.89 + 200 = 706.84.
    expect(row?.totalSold).toBe('706.84');
    expect(row?.totalPaid).toBe('118.00');
  });
});
