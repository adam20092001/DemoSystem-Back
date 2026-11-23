import { INestApplication } from '@nestjs/common';
import {
  CustomerStage,
  CustomerStatus,
  DocumentType,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  RoleName,
  WarehouseStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';
import { createProductRow, deleteProductRows } from './helpers/stock-fixtures';

/**
 * R2-B3 — ventas por ubicación de origen. HTTP real y PostgreSQL real
 * (descartable, verificado por la guardia E2E). Suite dedicada: usuarios,
 * productos, clientes, almacenes y documentos propios, retirados en afterAll.
 * Nunca altera restricciones del esquema ni crea históricos artificiales: el
 * caso histórico (SaleItem/movimiento sin ubicación) se cubre con pruebas
 * unitarias.
 */

interface LocationBody {
  id: string;
  code: string;
  name: string;
  warehouse: { id: string; code: string };
}

interface SaleItemBody {
  id: string;
  productId: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  location: LocationBody | null;
}

interface SaleBody {
  id: string;
  number: string;
  status: string;
  total: string;
  items: SaleItemBody[];
}

describe('Sales — ubicación de origen (e2e) — R2-B3', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  const SELLER_USERNAME = 'e2e_seller_r2b3';
  const SELLER_PASSWORD = 'SellerR2B3Fixture123';
  const WAREHOUSE_USERNAME = 'e2e_warehouse_r2b3';
  const WAREHOUSE_PASSWORD = 'WarehouseR2B3Fixture123';
  const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let categoryId: string;
  let unitId: string;
  let customerId: string;
  let defaultLocationId: string;
  let locA: string;
  let locB: string;

  const productIds: string[] = [];
  const saleIds: string[] = [];
  const quoteIds: string[] = [];
  const customerIds: string[] = [];
  const warehouseIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  const nextSuffix = (): string => {
    counter += 1;
    return `${RUN_ID}${counter}`;
  };
  const http = () => request(app.getHttpServer());

  async function createTracked(price = '10.00'): Promise<string> {
    const suffix = nextSuffix();
    const row = await createProductRow(prisma, {
      data: {
        sku: `R2B3-${suffix}`,
        name: `Producto e2e R2-B3 ${suffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal(price),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('0.000'),
        status: ProductStatus.ACTIVE,
      },
      select: { id: true },
    });
    productIds.push(row.id);
    return row.id;
  }

  async function createService(): Promise<string> {
    const suffix = nextSuffix();
    const row = await createProductRow(prisma, {
      data: {
        sku: `R2B3-S-${suffix}`,
        name: `Servicio e2e R2-B3 ${suffix}`,
        productType: ProductType.SERVICE,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('30.00'),
        isInventoryTracked: false,
        status: ProductStatus.ACTIVE,
      },
      select: { id: true },
    });
    productIds.push(row.id);
    return row.id;
  }

  /** Carga stock en una ubicación vía inventario manual (R2-B1b). */
  async function addStock(
    productId: string,
    locationId: string,
    quantity: string,
  ): Promise<void> {
    const res = await http()
      .post('/api/v1/inventory/entries')
      .set('Cookie', adminCookie)
      .send({ productId, quantity, reason: 'Carga e2e R2-B3', locationId });
    if (res.status !== 201) {
      throw new Error(`fixture stock: ${JSON.stringify(res.body)}`);
    }
  }

  async function createWarehouseWithLocations(
    count: number,
  ): Promise<{ warehouseId: string; locationIds: string[] }> {
    const suffix = nextSuffix();
    const created = await http()
      .post('/api/v1/warehouses')
      .set('Cookie', adminCookie)
      .send({ code: `B3W${suffix}`.slice(0, 20), name: 'Almacén e2e B3' });
    if (created.status !== 201) {
      throw new Error(`fixture almacén: ${JSON.stringify(created.body)}`);
    }
    const warehouseId = (created.body as { id: string }).id;
    warehouseIds.push(warehouseId);
    const locationIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const loc = await http()
        .post(`/api/v1/warehouses/${warehouseId}/locations`)
        .set('Cookie', adminCookie)
        .send({ code: `B3L${i}${suffix}`.slice(0, 20), name: `Ubic ${i}` });
      if (loc.status !== 201) {
        throw new Error(`fixture ubicación: ${JSON.stringify(loc.body)}`);
      }
      locationIds.push((loc.body as { id: string }).id);
    }
    return { warehouseId, locationIds };
  }

  async function balances(productId: string): Promise<Map<string, string>> {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    const rows = await prisma.stockBalance.findMany({ where: { productId } });
    const sum = rows.reduce(
      (acc, b) => acc.plus(b.quantity),
      new Prisma.Decimal(0),
    );
    // Conciliación: producto = suma de ubicaciones, sin negativos.
    expect(sum.toFixed(3)).toBe(product.stockCurrent.toFixed(3));
    for (const b of rows) expect(b.quantity.gte(0)).toBe(true);
    return new Map(rows.map((b) => [b.locationId, b.quantity.toFixed(3)]));
  }

  const qty = (m: Map<string, string>, loc: string): string =>
    m.get(loc) ?? '0.000';

  async function postSale(
    items: Record<string, unknown>[],
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    const res = await http()
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send({ customerId, items });
    if (res.status === 201) saleIds.push((res.body as SaleBody).id);
    return res;
  }

  async function cancelSale(id: string): Promise<request.Response> {
    return http()
      .post(`/api/v1/sales/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Anulación e2e R2-B3' });
  }

  async function createQuote(
    items: { productId: string; quantity: string }[],
  ): Promise<string> {
    const res = await http()
      .post('/api/v1/quotes')
      .set('Cookie', adminCookie)
      .send({ customerId, items });
    if (res.status !== 201) {
      throw new Error(`fixture cotización: ${JSON.stringify(res.body)}`);
    }
    const id = (res.body as { id: string }).id;
    quoteIds.push(id);
    return id;
  }

  async function convert(
    quoteId: string,
    body: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const res = await http()
      .post(`/api/v1/sales/from-quote/${quoteId}`)
      .set('Cookie', adminCookie)
      .send(body);
    if (res.status === 201) saleIds.push((res.body as SaleBody).id);
    return res;
  }

  const saleCount = (): Promise<number> =>
    prisma.sale.count({ where: { customerId } });

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_r2b3@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_r2b3@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(`login admin: ${JSON.stringify(adminLogin.body)}`);
    }
    adminCookie = adminLogin.cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;

    await prisma.documentSequence.upsert({
      where: { documentType: DocumentType.SALE },
      update: {},
      create: {
        documentType: DocumentType.SALE,
        prefix: 'NV-',
        currentNumber: 0,
        padding: 6,
      },
    });
    await prisma.documentSequence.upsert({
      where: { documentType: DocumentType.QUOTE },
      update: {},
      create: {
        documentType: DocumentType.QUOTE,
        prefix: 'COT-',
        currentNumber: 0,
        padding: 6,
      },
    });

    categoryId = (
      await prisma.category.findFirstOrThrow({ where: { code: 'SERVICIOS' } })
    ).id;
    unitId = (await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } }))
      .id;

    // Cliente propio con crédito (admite ventas sin pago inicial).
    const customer = await prisma.customer.create({
      data: {
        code: `R2B3-C-${nextSuffix()}`.slice(0, 20),
        name: 'Cliente e2e R2-B3',
        isGeneric: false,
        customerType: 'PERSON',
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        creditEnabled: true,
      },
    });
    customerId = customer.id;
    customerIds.push(customerId);

    defaultLocationId = (
      await prisma.warehouseLocation.findFirstOrThrow({
        where: { isDefault: true, warehouse: { isDefault: true } },
      })
    ).id;
    const wh = await createWarehouseWithLocations(2);
    [locA, locB] = wh.locationIds;
  }, 120000);

  afterAll(async () => {
    try {
      if (saleIds.length > 0) {
        await prisma.accountingEntry.deleteMany({
          where: {
            sourceType: 'SALE',
            sourceId: { in: saleIds },
            eventType: 'REVERSAL',
          },
        });
        await prisma.accountingEntry.deleteMany({
          where: { sourceType: 'SALE', sourceId: { in: saleIds } },
        });
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: saleIds } },
        });
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: saleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
      }
      if (quoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: quoteIds } },
        });
        await prisma.quote.deleteMany({ where: { id: { in: quoteIds } } });
      }
      // Misma convención que las demás suites comerciales: las secuencias NV/COT
      // se retiran al terminar para que sales.e2e-spec.ts parta de 0.
      await prisma.documentSequence.deleteMany({
        where: {
          documentType: { in: [DocumentType.SALE, DocumentType.QUOTE] },
        },
      });
      if (productIds.length > 0) {
        const movementIds = (
          await prisma.inventoryMovement.findMany({
            where: { productId: { in: productIds } },
            select: { id: true },
          })
        ).map((m) => m.id);
        await prisma.auditLog.deleteMany({
          where: { entityId: { in: [...movementIds, ...productIds] } },
        });
        await prisma.inventoryMovement.deleteMany({
          where: { productId: { in: productIds } },
        });
        await deleteProductRows(prisma, { where: { id: { in: productIds } } });
      }
      if (warehouseIds.length > 0) {
        const locations = await prisma.warehouseLocation.findMany({
          where: { warehouseId: { in: warehouseIds } },
          select: { id: true },
        });
        await prisma.auditLog.deleteMany({
          where: {
            entityId: { in: [...warehouseIds, ...locations.map((l) => l.id)] },
          },
        });
        await prisma.warehouseLocation.deleteMany({
          where: { warehouseId: { in: warehouseIds } },
        });
        await prisma.warehouse.deleteMany({
          where: { id: { in: warehouseIds } },
        });
      }
      if (customerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Customer', entityId: { in: customerIds } },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: customerIds } },
        });
      }
      const usernames = [SELLER_USERNAME, WAREHOUSE_USERNAME];
      await prisma.userRole.deleteMany({
        where: { user: { username: { in: usernames } } },
      });
      await prisma.user.deleteMany({
        where: { username: { in: usernames } },
      });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 120000);

  it('1. venta sin locationId: sale de MAIN/DEFAULT y la respuesta lo informa', async () => {
    const p = await createTracked();
    await addStock(p, defaultLocationId, '10.000');
    const res = await postSale([{ productId: p, quantity: '3' }]);
    expect(res.status).toBe(201);
    const body = res.body as SaleBody;
    expect(body.items[0].location?.id).toBe(defaultLocationId);
    expect(body.items[0].location?.code).toBe('DEFAULT');
    expect(body.items[0].location?.warehouse.code).toBe('MAIN');
    expect(qty(await balances(p), defaultLocationId)).toBe('7.000');
  });

  it('2. DEFAULT explícito equivale a omitirlo', async () => {
    const p = await createTracked();
    await addStock(p, defaultLocationId, '10.000');
    const res = await postSale([
      { productId: p, quantity: '2', locationId: defaultLocationId },
    ]);
    expect(res.status).toBe(201);
    expect(qty(await balances(p), defaultLocationId)).toBe('8.000');
  });

  it('3. venta desde otra ubicación: línea, movimiento y saldo en ella; precios intactos', async () => {
    const p = await createTracked('12.50');
    await addStock(p, locA, '10.000');
    const res = await postSale([
      { productId: p, quantity: '4', locationId: locA },
    ]);
    expect(res.status).toBe(201);
    const body = res.body as SaleBody;
    expect(body.items[0].location?.id).toBe(locA);
    expect(body.items[0].unitPrice).toBe('12.50');
    expect(body.items[0].lineTotal).toBe('50.00');
    expect(body.total).toBe('50.00');
    expect(qty(await balances(p), locA)).toBe('6.000');
    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { productId: p, origin: 'SALE' },
    });
    expect(movement.locationId).toBe(locA);
    const item = await prisma.saleItem.findFirstOrThrow({
      where: { saleId: body.id },
    });
    expect(item.locationId).toBe(locA);
  });

  it('4. productos distintos en ubicaciones distintas, enviados en orden inverso al productId', async () => {
    const p1 = await createTracked();
    const p2 = await createTracked();
    const [low, high] = [p1, p2].sort();
    await addStock(low, locA, '5.000');
    await addStock(high, locB, '5.000');
    const res = await postSale([
      { productId: high, quantity: '2', locationId: locB },
      { productId: low, quantity: '1', locationId: locA },
    ]);
    expect(res.status).toBe(201);
    const byProduct = new Map(
      (res.body as SaleBody).items.map((i) => [i.productId, i.location?.id]),
    );
    expect(byProduct.get(high)).toBe(locB);
    expect(byProduct.get(low)).toBe(locA);
    expect(qty(await balances(low), locA)).toBe('4.000');
    expect(qty(await balances(high), locB)).toBe('3.000');
  });

  it('5. servicio junto a productos: sin ubicación; una ubicación explícita en el servicio → 400 sin efectos', async () => {
    const p = await createTracked();
    const s = await createService();
    await addStock(p, locA, '5.000');
    const ok = await postSale([
      { productId: p, quantity: '1', locationId: locA },
      { productId: s, quantity: '1' },
    ]);
    expect(ok.status).toBe(201);
    const items = new Map(
      (ok.body as SaleBody).items.map((i) => [i.productId, i.location]),
    );
    expect(items.get(s)).toBeNull();
    expect(items.get(p)?.id).toBe(locA);

    const before = await saleCount();
    const bad = await postSale([
      { productId: p, quantity: '1', locationId: locA },
      { productId: s, quantity: '1', locationId: locA },
    ]);
    expect(bad.status).toBe(400);
    expect(await saleCount()).toBe(before);
    expect(qty(await balances(p), locA)).toBe('4.000');
  });

  it('6. producto repetido → 400 aunque las ubicaciones difieran', async () => {
    const p = await createTracked();
    await addStock(p, locA, '5.000');
    await addStock(p, locB, '5.000');
    const before = await saleCount();
    const res = await postSale([
      { productId: p, quantity: '1', locationId: locA },
      { productId: p, quantity: '1', locationId: locB },
    ]);
    expect(res.status).toBe(400);
    expect(await saleCount()).toBe(before);
    expect((await balances(p)).size).toBe(2);
  });

  it('7. insuficiencia en la ubicación con consolidado suficiente → 409 con producto y ubicación, sin efectos', async () => {
    const p = await createTracked();
    await addStock(p, locA, '2.000');
    await addStock(p, locB, '10.000');
    const before = await saleCount();
    const res = await postSale([
      { productId: p, quantity: '5', locationId: locA },
    ]);
    expect(res.status).toBe(409);
    expect(JSON.stringify(res.body)).toContain('R2B3-');
    expect(JSON.stringify(res.body)).toContain('/B3L');
    expect(await saleCount()).toBe(before);
    const map = await balances(p);
    expect(qty(map, locA)).toBe('2.000');
    expect(qty(map, locB)).toBe('10.000');
  });

  describe('errores de ubicación (sin efectos)', () => {
    async function expectNoEffects(p: string, before: number): Promise<void> {
      expect(await saleCount()).toBe(before);
      expect(
        await prisma.inventoryMovement.count({
          where: { productId: p, origin: 'SALE' },
        }),
      ).toBe(0);
      expect(qty(await balances(p), defaultLocationId)).toBe('5.000');
    }

    it('8. UUID malformado → 400', async () => {
      const p = await createTracked();
      await addStock(p, defaultLocationId, '5.000');
      const before = await saleCount();
      const res = await postSale([
        { productId: p, quantity: '1', locationId: 'no-es-uuid' },
      ]);
      expect(res.status).toBe(400);
      await expectNoEffects(p, before);
    });

    it('9. ubicación inexistente → 404', async () => {
      const p = await createTracked();
      await addStock(p, defaultLocationId, '5.000');
      const before = await saleCount();
      const res = await postSale([
        { productId: p, quantity: '1', locationId: NON_EXISTENT_UUID },
      ]);
      expect(res.status).toBe(404);
      await expectNoEffects(p, before);
    });

    it('10. ubicación inactiva → 409', async () => {
      const p = await createTracked();
      await addStock(p, defaultLocationId, '5.000');
      const wh = await createWarehouseWithLocations(1);
      await prisma.warehouseLocation.update({
        where: { id: wh.locationIds[0] },
        data: { status: WarehouseStatus.INACTIVE },
      });
      const before = await saleCount();
      const res = await postSale([
        { productId: p, quantity: '1', locationId: wh.locationIds[0] },
      ]);
      expect(res.status).toBe(409);
      await expectNoEffects(p, before);
    });

    it('11. almacén inactivo → 409', async () => {
      const p = await createTracked();
      await addStock(p, defaultLocationId, '5.000');
      const wh = await createWarehouseWithLocations(1);
      await prisma.warehouse.update({
        where: { id: wh.warehouseId },
        data: { status: WarehouseStatus.INACTIVE },
      });
      const before = await saleCount();
      const res = await postSale([
        { productId: p, quantity: '1', locationId: wh.locationIds[0] },
      ]);
      expect(res.status).toBe(409);
      await expectNoEffects(p, before);
    });
  });

  describe('conversión de cotización', () => {
    it('12. conversión antigua sin locations: MAIN/DEFAULT', async () => {
      const p = await createTracked();
      await addStock(p, defaultLocationId, '5.000');
      const quoteId = await createQuote([{ productId: p, quantity: '2' }]);
      const res = await convert(quoteId);
      expect(res.status).toBe(201);
      expect((res.body as SaleBody).items[0].location?.id).toBe(
        defaultLocationId,
      );
      expect(qty(await balances(p), defaultLocationId)).toBe('3.000');
    });

    it('13. conversión con locations: cada producto sale de su ubicación; el omitido, de MAIN/DEFAULT', async () => {
      const p1 = await createTracked();
      const p2 = await createTracked();
      await addStock(p1, defaultLocationId, '5.000');
      await addStock(p2, locB, '5.000');
      const quoteId = await createQuote([
        { productId: p1, quantity: '1' },
        { productId: p2, quantity: '2' },
      ]);
      const res = await convert(quoteId, {
        locations: [{ productId: p2, locationId: locB }],
      });
      expect(res.status).toBe(201);
      const byProduct = new Map(
        (res.body as SaleBody).items.map((i) => [i.productId, i.location?.id]),
      );
      expect(byProduct.get(p1)).toBe(defaultLocationId);
      expect(byProduct.get(p2)).toBe(locB);
      expect(qty(await balances(p1), defaultLocationId)).toBe('4.000');
      expect(qty(await balances(p2), locB)).toBe('3.000');
    });

    it('14. locations con producto ajeno, repetido, servicio, UUID inválido o campo extra → 400 sin convertir', async () => {
      const p = await createTracked();
      const s = await createService();
      const other = await createTracked();
      await addStock(p, locA, '5.000');
      const quoteId = await createQuote([
        { productId: p, quantity: '1' },
        { productId: s, quantity: '1' },
      ]);
      const bodies: Record<string, unknown>[] = [
        { locations: [{ productId: other, locationId: locA }] },
        {
          locations: [
            { productId: p, locationId: locA },
            { productId: p, locationId: locB },
          ],
        },
        { locations: [{ productId: s, locationId: locA }] },
        { locations: [{ productId: p, locationId: 'no-es-uuid' }] },
        { locations: [{ productId: p, locationId: locA, extra: 1 }] },
      ];
      for (const body of bodies) {
        const res = await convert(quoteId, body);
        expect(res.status).toBe(400);
      }
      const quote = await prisma.quote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(quote.status).not.toBe('CONVERTED');
      expect(qty(await balances(p), locA)).toBe('5.000');
      // Y la conversión válida sigue funcionando tras los rechazos.
      const ok = await convert(quoteId, {
        locations: [{ productId: p, locationId: locA }],
      });
      expect(ok.status).toBe(201);
      expect(qty(await balances(p), locA)).toBe('4.000');
    });

    it('15. conversión con ubicación sin stock suficiente → 409 y la cotización sigue convertible', async () => {
      const p = await createTracked();
      await addStock(p, locA, '1.000');
      await addStock(p, locB, '10.000');
      const quoteId = await createQuote([{ productId: p, quantity: '3' }]);
      const res = await convert(quoteId, {
        locations: [{ productId: p, locationId: locA }],
      });
      expect(res.status).toBe(409);
      const quote = await prisma.quote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(quote.status).not.toBe('CONVERTED');
      const retry = await convert(quoteId, {
        locations: [{ productId: p, locationId: locB }],
      });
      expect(retry.status).toBe(201);
    });
  });

  describe('anulación', () => {
    it('16. venta con productos en ubicaciones distintas: cada producto vuelve a SU ubicación; doble anulación 409', async () => {
      const p1 = await createTracked();
      const p2 = await createTracked();
      await addStock(p1, locA, '5.000');
      await addStock(p2, locB, '5.000');
      const sale = await postSale([
        { productId: p1, quantity: '2', locationId: locA },
        { productId: p2, quantity: '3', locationId: locB },
      ]);
      expect(sale.status).toBe(201);
      const id = (sale.body as SaleBody).id;
      expect(qty(await balances(p1), locA)).toBe('3.000');
      expect(qty(await balances(p2), locB)).toBe('2.000');

      const cancelled = await cancelSale(id);
      expect(cancelled.status).toBe(200);
      const body = cancelled.body as SaleBody;
      expect(body.status).toBe('CANCELLED');
      expect(body.items.find((i) => i.productId === p1)?.location?.id).toBe(
        locA,
      );
      const m1 = await balances(p1);
      const m2 = await balances(p2);
      expect(qty(m1, locA)).toBe('5.000');
      expect(qty(m2, locB)).toBe('5.000');
      expect(m1.has(defaultLocationId)).toBe(false);
      expect(m2.has(defaultLocationId)).toBe(false);

      expect((await cancelSale(id)).status).toBe(409);
      expect(qty(await balances(p1), locA)).toBe('5.000');
    });
  });

  it('17. consultas (detalle, listado) e impresión conservan el contrato y exponen la ubicación', async () => {
    const p = await createTracked();
    await addStock(p, locA, '5.000');
    const sale = await postSale([
      { productId: p, quantity: '1', locationId: locA },
    ]);
    const id = (sale.body as SaleBody).id;
    const detail = await http()
      .get(`/api/v1/sales/${id}`)
      .set('Cookie', adminCookie);
    expect(detail.status).toBe(200);
    expect((detail.body as SaleBody).items[0].location?.id).toBe(locA);
    const list = await http()
      .get('/api/v1/sales?limit=5')
      .set('Cookie', adminCookie);
    expect(list.status).toBe(200);
    const print = await http()
      .get(`/api/v1/sales/${id}/print`)
      .set('Cookie', adminCookie);
    expect(print.status).toBe(200);
    expect(JSON.stringify(print.body) + String(print.text)).not.toContain(
      'ESTANTE',
    );
  });

  it('18. permisos: SELLER vende con ubicación; WAREHOUSE no vende (403)', async () => {
    const p = await createTracked();
    await addStock(p, locA, '5.000');
    const ok = await postSale(
      [{ productId: p, quantity: '1', locationId: locA }],
      sellerCookie,
    );
    expect(ok.status).toBe(201);
    const denied = await postSale(
      [{ productId: p, quantity: '1', locationId: locA }],
      warehouseCookie,
    );
    expect(denied.status).toBe(403);
    expect(qty(await balances(p), locA)).toBe('4.000');
  });

  describe('concurrencia', () => {
    it('19. dos ventas del mismo producto y ubicación con stock para una sola: exactamente una 201, la otra 409', async () => {
      const p = await createTracked();
      await addStock(p, locA, '5.000');
      const [r1, r2] = await Promise.all([
        postSale([{ productId: p, quantity: '4', locationId: locA }]),
        postSale([{ productId: p, quantity: '4', locationId: locA }]),
      ]);
      expect([r1.status, r2.status].sort()).toEqual([201, 409]);
      expect(qty(await balances(p), locA)).toBe('1.000');
    });

    it('20. ventas con productos y ubicaciones cruzadas, en orden opuesto: ambas 201 y saldos exactos', async () => {
      const p1 = await createTracked();
      const p2 = await createTracked();
      for (const p of [p1, p2]) {
        await addStock(p, locA, '10.000');
        await addStock(p, locB, '10.000');
      }
      const [r1, r2] = await Promise.all([
        postSale([
          { productId: p1, quantity: '1', locationId: locA },
          { productId: p2, quantity: '2', locationId: locB },
        ]),
        postSale([
          { productId: p2, quantity: '3', locationId: locA },
          { productId: p1, quantity: '4', locationId: locB },
        ]),
      ]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      const m1 = await balances(p1);
      const m2 = await balances(p2);
      expect(qty(m1, locA)).toBe('9.000');
      expect(qty(m1, locB)).toBe('6.000');
      expect(qty(m2, locA)).toBe('7.000');
      expect(qty(m2, locB)).toBe('8.000');
    });

    it('21. venta contra salida manual por las últimas unidades de una ubicación: solo una gana, sin negativos', async () => {
      const p = await createTracked();
      await addStock(p, locA, '5.000');
      const [sale, exit] = await Promise.all([
        postSale([{ productId: p, quantity: '5', locationId: locA }]),
        http().post('/api/v1/inventory/exits').set('Cookie', adminCookie).send({
          productId: p,
          quantity: '5',
          reason: 'Salida concurrente e2e',
          locationId: locA,
        }),
      ]);
      const successes = [sale.status === 201, exit.status === 201].filter(
        Boolean,
      );
      expect(successes).toHaveLength(1);
      expect(qty(await balances(p), locA)).toBe('0.000');
    });

    it('22. venta contra entrada manual (análoga a una recepción) en la misma ubicación: ambas terminan y concilian', async () => {
      const p = await createTracked();
      await addStock(p, locA, '5.000');
      const [sale, entry] = await Promise.all([
        postSale([{ productId: p, quantity: '5', locationId: locA }]),
        http()
          .post('/api/v1/inventory/entries')
          .set('Cookie', adminCookie)
          .send({
            productId: p,
            quantity: '3',
            reason: 'Entrada concurrente e2e',
            locationId: locA,
          }),
      ]);
      expect(sale.status).toBe(201);
      expect(entry.status).toBe(201);
      expect(qty(await balances(p), locA)).toBe('3.000');
    });

    it('23. venta contra anulación de otra venta sobre el mismo producto: ambas terminan y concilian', async () => {
      const p = await createTracked();
      await addStock(p, locA, '5.000');
      const first = await postSale([
        { productId: p, quantity: '5', locationId: locA },
      ]);
      const firstId = (first.body as SaleBody).id;
      const [cancelled, second] = await Promise.all([
        cancelSale(firstId),
        postSale([{ productId: p, quantity: '5', locationId: locA }]),
      ]);
      expect(cancelled.status).toBe(200);
      // La segunda venta solo cabe si la anulación terminó antes: 201 o 409,
      // nunca un estado inconsistente.
      expect([201, 409]).toContain(second.status);
      const expected = second.status === 201 ? '0.000' : '5.000';
      expect(qty(await balances(p), locA)).toBe(expected);
    });
  });
});
