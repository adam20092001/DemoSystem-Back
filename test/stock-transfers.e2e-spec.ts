import { INestApplication } from '@nestjs/common';
import {
  CustomerStage,
  CustomerStatus,
  DocumentType,
  InventoryMovementOrigin,
  InventoryMovementType,
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
 * R2-C — transferencias de stock entre ubicaciones. HTTP real y PostgreSQL
 * real (descartable, verificado por la guardia E2E). Suite dedicada: usuarios,
 * productos, almacenes y documentos propios, retirados en afterAll. Nunca
 * altera restricciones del esquema: los CHECK nuevos se prueban intentando
 * una inserción inválida (que debe ser rechazada), no desactivándolos.
 */

interface LocationBody {
  id: string;
  code: string;
  name: string;
  warehouse: { id: string; code: string };
}

interface TransferBody {
  id: string;
  product: { id: string; sku: string; name: string };
  sourceLocation: LocationBody;
  destinationLocation: LocationBody;
  quantity: string;
  reason: string;
  notes: string | null;
  idempotencyKey: string | null;
  createdBy: { id: string; username: string };
  exitMovementId: string;
  entryMovementId: string;
  createdAt: string;
}

interface Paginated<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface MovementBody {
  id: string;
  origin: string;
  movementType: string;
  quantity: string;
  location: LocationBody | null;
  transferId: string | null;
}

describe('Stock transfers (e2e) — R2-C', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  const WAREHOUSE_USERNAME = 'e2e_warehouse_r2c';
  const WAREHOUSE_PASSWORD = 'WarehouseR2CFixture123';
  const MANAGEMENT_USERNAME = 'e2e_management_r2c';
  const MANAGEMENT_PASSWORD = 'ManagementR2CFixture123';
  const SELLER_USERNAME = 'e2e_seller_r2c';
  const SELLER_PASSWORD = 'SellerR2CFixture123';
  const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

  let adminCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let categoryId: string;
  let unitId: string;
  let customerId: string;
  let adminId: string;
  let warehouseA: string;
  let warehouseB: string;
  let locA1: string;
  let locA2: string;
  let locB1: string;

  const productIds: string[] = [];
  const saleIds: string[] = [];
  const warehouseIds: string[] = [];
  const customerIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  const nextSuffix = (): string => {
    counter += 1;
    return `${RUN_ID}${counter}`;
  };
  const http = () => request(app.getHttpServer());

  async function createTracked(): Promise<string> {
    const suffix = nextSuffix();
    const row = await createProductRow(prisma, {
      data: {
        sku: `R2C-${suffix}`,
        name: `Producto e2e R2-C ${suffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('10.00'),
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
        sku: `R2C-S-${suffix}`,
        name: `Servicio e2e R2-C ${suffix}`,
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

  async function addStock(
    productId: string,
    locationId: string,
    quantity: string,
  ): Promise<void> {
    const res = await http()
      .post('/api/v1/inventory/entries')
      .set('Cookie', adminCookie)
      .send({ productId, quantity, reason: 'Carga e2e R2-C', locationId });
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
      .send({ code: `CW${suffix}`.slice(0, 20), name: 'Almacén e2e R2-C' });
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
        .send({ code: `CL${i}${suffix}`.slice(0, 20), name: `Ubic ${i}` });
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
  const stockCurrent = async (productId: string): Promise<string> =>
    (
      await prisma.product.findUniqueOrThrow({ where: { id: productId } })
    ).stockCurrent.toFixed(3);

  function transfer(
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return http()
      .post('/api/v1/inventory/transfers')
      .set('Cookie', cookie)
      .send(body);
  }

  const body = (
    productId: string,
    source: string,
    destination: string,
    quantity: string,
    extra: Record<string, unknown> = {},
  ): Record<string, unknown> => ({
    productId,
    sourceLocationId: source,
    destinationLocationId: destination,
    quantity,
    reason: 'Transferencia e2e R2-C',
    ...extra,
  });

  async function expectNoEffects(
    productId: string,
    before: { movements: number; transfers: number },
  ): Promise<void> {
    expect(await prisma.inventoryMovement.count({ where: { productId } })).toBe(
      before.movements,
    );
    expect(await prisma.stockTransfer.count({ where: { productId } })).toBe(
      before.transfers,
    );
  }
  const snapshot = async (productId: string) => ({
    movements: await prisma.inventoryMovement.count({ where: { productId } }),
    transfers: await prisma.stockTransfer.count({ where: { productId } }),
  });

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_r2c@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_r2c@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_r2c@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
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
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    adminId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      })
    ).id;

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

    categoryId = (
      await prisma.category.findFirstOrThrow({ where: { code: 'SERVICIOS' } })
    ).id;
    unitId = (await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } }))
      .id;

    const customer = await prisma.customer.create({
      data: {
        code: `R2C-C-${nextSuffix()}`.slice(0, 20),
        name: 'Cliente e2e R2-C',
        isGeneric: false,
        customerType: 'PERSON',
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        creditEnabled: true,
      },
    });
    customerId = customer.id;
    customerIds.push(customerId);

    const a = await createWarehouseWithLocations(2);
    warehouseA = a.warehouseId;
    [locA1, locA2] = a.locationIds;
    const b = await createWarehouseWithLocations(1);
    warehouseB = b.warehouseId;
    [locB1] = b.locationIds;
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
      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.SALE },
      });
      if (productIds.length > 0) {
        const transfers = await prisma.stockTransfer.findMany({
          where: { productId: { in: productIds } },
          select: { id: true },
        });
        const transferIds = transfers.map((t) => t.id);
        await prisma.stockTransfer.deleteMany({
          where: { productId: { in: productIds } },
        });
        const movementIds = (
          await prisma.inventoryMovement.findMany({
            where: { productId: { in: productIds } },
            select: { id: true },
          })
        ).map((m) => m.id);
        await prisma.auditLog.deleteMany({
          where: {
            entityId: { in: [...movementIds, ...productIds, ...transferIds] },
          },
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
      const usernames = [
        WAREHOUSE_USERNAME,
        MANAGEMENT_USERNAME,
        SELLER_USERNAME,
      ];
      await prisma.userRole.deleteMany({
        where: { user: { username: { in: usernames } } },
      });
      await prisma.user.deleteMany({ where: { username: { in: usernames } } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 120000);

  // ==================================================================
  // Camino feliz
  // ==================================================================

  it('1. dentro de un almacén: mueve el stock, conserva el consolidado y vincula documento y movimientos', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '20.000');
    await addStock(p, locA2, '5.000');
    const res = await transfer(body(p, locA1, locA2, '10'));
    expect(res.status).toBe(201);
    const t = res.body as TransferBody;
    expect(t.quantity).toBe('10.000');
    expect(t.sourceLocation.id).toBe(locA1);
    expect(t.destinationLocation.id).toBe(locA2);
    expect(t.createdBy.id).toBe(adminId);

    const map = await balances(p);
    expect(qty(map, locA1)).toBe('10.000');
    expect(qty(map, locA2)).toBe('15.000');
    expect(await stockCurrent(p)).toBe('25.000');

    const exit = await prisma.inventoryMovement.findUniqueOrThrow({
      where: { id: t.exitMovementId },
    });
    const entry = await prisma.inventoryMovement.findUniqueOrThrow({
      where: { id: t.entryMovementId },
    });
    expect(exit).toMatchObject({
      origin: InventoryMovementOrigin.TRANSFER,
      movementType: InventoryMovementType.EXIT,
      locationId: locA1,
      referenceType: 'StockTransfer',
      referenceId: t.id,
    });
    expect(entry).toMatchObject({
      origin: InventoryMovementOrigin.TRANSFER,
      movementType: InventoryMovementType.ENTRY,
      locationId: locA2,
      referenceType: 'StockTransfer',
      referenceId: t.id,
    });
    // previous/newStock siguen siendo del consolidado: baja y vuelve a subir.
    expect(exit.previousStock.toFixed(3)).toBe('25.000');
    expect(exit.newStock.toFixed(3)).toBe('15.000');
    expect(entry.newStock.toFixed(3)).toBe('25.000');
  });

  it('2. entre almacenes distintos usa el mismo flujo', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '8.000');
    const res = await transfer(body(p, locA1, locB1, '3'));
    expect(res.status).toBe(201);
    const t = res.body as TransferBody;
    expect(t.sourceLocation.warehouse.id).toBe(warehouseA);
    expect(t.destinationLocation.warehouse.id).toBe(warehouseB);
    const map = await balances(p);
    expect(qty(map, locA1)).toBe('5.000');
    expect(qty(map, locB1)).toBe('3.000');
    expect(await stockCurrent(p)).toBe('8.000');
  });

  it('3. transferir todo el saldo del origen deja el origen en 0 y no falla', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '4.000');
    const res = await transfer(body(p, locA1, locA2, '4'));
    expect(res.status).toBe(201);
    const map = await balances(p);
    expect(qty(map, locA1)).toBe('0.000');
    expect(qty(map, locA2)).toBe('4.000');
  });

  // ==================================================================
  // Validaciones
  // ==================================================================

  describe('validaciones (sin efectos)', () => {
    it.each([
      ['origen igual a destino', (a: string) => body('P', a, a, '1')],
      ['cantidad cero', (a: string, b: string) => body('P', a, b, '0')],
      ['cantidad negativa', (a: string, b: string) => body('P', a, b, '-1')],
      [
        'más de 3 decimales',
        (a: string, b: string) => body('P', a, b, '1.2345'),
      ],
      ['cantidad no numérica', (a: string, b: string) => body('P', a, b, 'x')],
    ])('4. %s → 400', async (_name, build) => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const before = await snapshot(p);
      const payload = build(locA1, locA2);
      payload.productId = p;
      const res = await transfer(payload);
      expect(res.status).toBe(400);
      await expectNoEffects(p, before);
      expect(qty(await balances(p), locA1)).toBe('5.000');
    });

    it('5. UUID malformado y campos no permitidos → 400', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const before = await snapshot(p);
      for (const payload of [
        body(p, 'no-uuid', locA2, '1'),
        body(p, locA1, 'no-uuid', '1'),
        body('no-uuid', locA1, locA2, '1'),
        body(p, locA1, locA2, '1', { origin: 'MANUAL' }),
        body(p, locA1, locA2, '1', { warehouseId: warehouseA }),
      ]) {
        expect((await transfer(payload)).status).toBe(400);
      }
      await expectNoEffects(p, before);
    });

    it('6. stock insuficiente en el origen, aunque otra ubicación tenga de sobra → 409 sin efectos', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '2.000');
      await addStock(p, locA2, '50.000');
      const before = await snapshot(p);
      const res = await transfer(body(p, locA1, locB1, '5'));
      expect(res.status).toBe(409);
      await expectNoEffects(p, before);
      const map = await balances(p);
      expect(qty(map, locA1)).toBe('2.000');
      expect(qty(map, locA2)).toBe('50.000');
    });

    it('7. producto inexistente → 404; ubicación inexistente → 404', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const before = await snapshot(p);
      expect(
        (await transfer(body(NON_EXISTENT_UUID, locA1, locA2, '1'))).status,
      ).toBe(404);
      expect(
        (await transfer(body(p, NON_EXISTENT_UUID, locA2, '1'))).status,
      ).toBe(404);
      expect(
        (await transfer(body(p, locA1, NON_EXISTENT_UUID, '1'))).status,
      ).toBe(404);
      await expectNoEffects(p, before);
    });

    it('8. ubicación inactiva (origen o destino) y almacén inactivo → 409; el origen no pierde stock', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const inactiveLoc = await createWarehouseWithLocations(1);
      await prisma.warehouseLocation.update({
        where: { id: inactiveLoc.locationIds[0] },
        data: { status: WarehouseStatus.INACTIVE },
      });
      const inactiveWh = await createWarehouseWithLocations(1);
      await prisma.warehouse.update({
        where: { id: inactiveWh.warehouseId },
        data: { status: WarehouseStatus.INACTIVE },
      });
      const before = await snapshot(p);
      for (const payload of [
        body(p, locA1, inactiveLoc.locationIds[0], '1'),
        body(p, locA1, inactiveWh.locationIds[0], '1'),
        body(p, inactiveLoc.locationIds[0], locA1, '1'),
        body(p, inactiveWh.locationIds[0], locA1, '1'),
      ]) {
        expect((await transfer(payload)).status).toBe(409);
      }
      await expectNoEffects(p, before);
      expect(qty(await balances(p), locA1)).toBe('5.000');
    });

    it('9. un servicio / producto no inventariable → 400 y un producto inactivo → 409, sin efectos', async () => {
      const svc = await createService();
      const res = await transfer(body(svc, locA1, locA2, '1'));
      expect(res.status).toBe(400);
      expect(
        await prisma.stockTransfer.count({ where: { productId: svc } }),
      ).toBe(0);

      const inactive = await createTracked();
      await addStock(inactive, locA1, '3.000');
      await prisma.product.update({
        where: { id: inactive },
        data: { status: ProductStatus.INACTIVE },
      });
      const before = await snapshot(inactive);
      expect((await transfer(body(inactive, locA1, locA2, '1'))).status).toBe(
        409,
      );
      await expectNoEffects(inactive, before);
    });

    it('10. rollback: si el destino falla, el EXIT del origen también se revierte', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const wh = await createWarehouseWithLocations(1);
      await prisma.warehouseLocation.update({
        where: { id: wh.locationIds[0] },
        data: { status: WarehouseStatus.INACTIVE },
      });
      const before = await snapshot(p);
      const res = await transfer(body(p, locA1, wh.locationIds[0], '2'));
      expect(res.status).toBe(409);
      // Ni saldo, ni consolidado, ni movimientos, ni documento, ni auditoría.
      expect(qty(await balances(p), locA1)).toBe('5.000');
      expect(await stockCurrent(p)).toBe('5.000');
      await expectNoEffects(p, before);
      expect(
        await prisma.auditLog.count({
          where: { action: 'INVENTORY_TRANSFER_CREATED', entityId: p },
        }),
      ).toBe(0);
    });
  });

  // ==================================================================
  // Idempotencia
  // ==================================================================

  describe('idempotencia', () => {
    it('11. misma clave y mismo contenido devuelve la original; el stock se mueve una sola vez', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '10.000');
      const key = `idem-${nextSuffix()}`;
      const first = await transfer(
        body(p, locA1, locA2, '4', { idempotencyKey: key }),
      );
      const second = await transfer(
        body(p, locA1, locA2, '4.000', {
          idempotencyKey: key,
          reason: '  Transferencia e2e R2-C  ',
        }),
      );
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      expect((second.body as TransferBody).id).toBe(
        (first.body as TransferBody).id,
      );
      expect(
        await prisma.stockTransfer.count({ where: { productId: p } }),
      ).toBe(1);
      expect(
        await prisma.inventoryMovement.count({
          where: { productId: p, origin: 'TRANSFER' },
        }),
      ).toBe(2);
      const map = await balances(p);
      expect(qty(map, locA1)).toBe('6.000');
      expect(qty(map, locA2)).toBe('4.000');
    });

    it('12. misma clave con contenido distinto → 409 sin mover stock', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '10.000');
      const key = `idem-${nextSuffix()}`;
      expect(
        (await transfer(body(p, locA1, locA2, '4', { idempotencyKey: key })))
          .status,
      ).toBe(201);
      for (const payload of [
        body(p, locA1, locA2, '5', { idempotencyKey: key }),
        body(p, locA1, locB1, '4', { idempotencyKey: key }),
        body(p, locA1, locA2, '4', { idempotencyKey: key, notes: 'otra' }),
      ]) {
        expect((await transfer(payload)).status).toBe(409);
      }
      expect(
        await prisma.stockTransfer.count({ where: { productId: p } }),
      ).toBe(1);
      expect(qty(await balances(p), locA1)).toBe('6.000');
    });

    it('13. la clave es por usuario: otro usuario con la misma clave crea su propia transferencia', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '10.000');
      const key = `idem-${nextSuffix()}`;
      const a = await transfer(
        body(p, locA1, locA2, '1', { idempotencyKey: key }),
      );
      const w = await transfer(
        body(p, locA1, locA2, '1', { idempotencyKey: key }),
        warehouseCookie,
      );
      expect(a.status).toBe(201);
      expect(w.status).toBe(201);
      expect((w.body as TransferBody).id).not.toBe((a.body as TransferBody).id);
      expect(qty(await balances(p), locA2)).toBe('2.000');
    });

    it('14. sin clave no hay deduplicación: dos solicitudes iguales crean dos transferencias', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '10.000');
      await transfer(body(p, locA1, locA2, '2'));
      await transfer(body(p, locA1, locA2, '2'));
      expect(
        await prisma.stockTransfer.count({ where: { productId: p } }),
      ).toBe(2);
      expect(qty(await balances(p), locA2)).toBe('4.000');
    });

    it('15. concurrente con la misma clave: como máximo una transferencia, ambas respuestas son la misma', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '10.000');
      const key = `idem-${nextSuffix()}`;
      const results = await Promise.all(
        [1, 2, 3, 4].map(() =>
          transfer(body(p, locA1, locA2, '3', { idempotencyKey: key })),
        ),
      );
      for (const r of results) expect(r.status).toBe(201);
      const ids = new Set(results.map((r) => (r.body as TransferBody).id));
      expect(ids.size).toBe(1);
      expect(
        await prisma.stockTransfer.count({ where: { productId: p } }),
      ).toBe(1);
      const map = await balances(p);
      expect(qty(map, locA1)).toBe('7.000');
      expect(qty(map, locA2)).toBe('3.000');
    });
  });

  // ==================================================================
  // Concurrencia
  // ==================================================================

  describe('concurrencia', () => {
    it('16. transferencias opuestas del mismo producto: ambas terminan y el consolidado no cambia', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '10.000');
      await addStock(p, locA2, '10.000');
      const [r1, r2] = await Promise.all([
        transfer(body(p, locA1, locA2, '3')),
        transfer(body(p, locA2, locA1, '4')),
      ]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      const map = await balances(p);
      expect(qty(map, locA1)).toBe('11.000');
      expect(qty(map, locA2)).toBe('9.000');
      expect(await stockCurrent(p)).toBe('20.000');
    });

    it('17. varias transferencias desde el mismo origen con saldo para una sola: nunca saldo negativo', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const results = await Promise.all(
        [locA2, locB1, locA2, locB1].map((dest) =>
          transfer(body(p, locA1, dest, '4')),
        ),
      );
      const ok = results.filter((r) => r.status === 201).length;
      const conflict = results.filter((r) => r.status === 409).length;
      expect(ok).toBe(1);
      expect(conflict).toBe(3);
      expect(qty(await balances(p), locA1)).toBe('1.000');
      expect(await stockCurrent(p)).toBe('5.000');
    });

    it('18. transferencia contra salida manual por las últimas unidades del origen: solo una gana', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const [t, exit] = await Promise.all([
        transfer(body(p, locA1, locA2, '5')),
        http().post('/api/v1/inventory/exits').set('Cookie', adminCookie).send({
          productId: p,
          quantity: '5',
          reason: 'Salida concurrente e2e',
          locationId: locA1,
        }),
      ]);
      expect(
        [t.status === 201, exit.status === 201].filter(Boolean),
      ).toHaveLength(1);
      expect(qty(await balances(p), locA1)).toBe('0.000');
    });

    it('19. transferencia contra venta por las últimas unidades del origen: solo una gana', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const [t, sale] = await Promise.all([
        transfer(body(p, locA1, locA2, '5')),
        http()
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send({
            customerId,
            items: [{ productId: p, quantity: '5', locationId: locA1 }],
          }),
      ]);
      if (sale.status === 201) saleIds.push((sale.body as { id: string }).id);
      expect(
        [t.status === 201, sale.status === 201].filter(Boolean),
      ).toHaveLength(1);
      expect(qty(await balances(p), locA1)).toBe('0.000');
    });

    it('20. transferencia contra una entrada manual (análoga a una recepción) en el destino: ambas terminan y concilian', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '5.000');
      const [t, entry] = await Promise.all([
        transfer(body(p, locA1, locA2, '5')),
        http()
          .post('/api/v1/inventory/entries')
          .set('Cookie', adminCookie)
          .send({
            productId: p,
            quantity: '3',
            reason: 'Entrada concurrente e2e',
            locationId: locA2,
          }),
      ]);
      expect(t.status).toBe(201);
      expect(entry.status).toBe(201);
      const map = await balances(p);
      expect(qty(map, locA1)).toBe('0.000');
      expect(qty(map, locA2)).toBe('8.000');
    });

    it('21. dos productos con transferencias cruzadas y origen/destino invertidos: sin deadlock', async () => {
      const p1 = await createTracked();
      const p2 = await createTracked();
      for (const p of [p1, p2]) {
        await addStock(p, locA1, '10.000');
        await addStock(p, locB1, '10.000');
      }
      const results = await Promise.all([
        transfer(body(p1, locA1, locB1, '1')),
        transfer(body(p2, locB1, locA1, '2')),
        transfer(body(p1, locB1, locA1, '3')),
        transfer(body(p2, locA1, locB1, '4')),
      ]);
      for (const r of results) expect(r.status).toBe(201);
      const m1 = await balances(p1);
      const m2 = await balances(p2);
      expect(qty(m1, locA1)).toBe('12.000');
      expect(qty(m1, locB1)).toBe('8.000');
      expect(qty(m2, locA1)).toBe('8.000');
      expect(qty(m2, locB1)).toBe('12.000');
    });
  });

  // ==================================================================
  // Permisos, consultas y kardex
  // ==================================================================

  it('22. permisos: ADMIN y WAREHOUSE crean; MANAGEMENT solo consulta; SELLER nada', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '10.000');
    const adminRes = await transfer(body(p, locA1, locA2, '1'));
    const whRes = await transfer(body(p, locA1, locA2, '1'), warehouseCookie);
    expect(adminRes.status).toBe(201);
    expect(whRes.status).toBe(201);
    expect((whRes.body as TransferBody).createdBy.username).toBe(
      WAREHOUSE_USERNAME,
    );
    expect(
      (await transfer(body(p, locA1, locA2, '1'), managementCookie)).status,
    ).toBe(403);
    expect(
      (await transfer(body(p, locA1, locA2, '1'), sellerCookie)).status,
    ).toBe(403);

    const id = (adminRes.body as TransferBody).id;
    for (const cookie of [adminCookie, warehouseCookie, managementCookie]) {
      expect(
        (
          await http()
            .get(`/api/v1/inventory/transfers/${id}`)
            .set('Cookie', cookie)
        ).status,
      ).toBe(200);
      expect(
        (await http().get('/api/v1/inventory/transfers').set('Cookie', cookie))
          .status,
      ).toBe(200);
    }
    expect(
      (
        await http()
          .get(`/api/v1/inventory/transfers/${id}`)
          .set('Cookie', sellerCookie)
      ).status,
    ).toBe(403);
    expect(
      (
        await http()
          .get(`/api/v1/inventory/transfers/${NON_EXISTENT_UUID}`)
          .set('Cookie', adminCookie)
      ).status,
    ).toBe(404);
    // Sin anulación ni edición: esas rutas no existen.
    expect(
      (
        await http()
          .post(`/api/v1/inventory/transfers/${id}/cancel`)
          .set('Cookie', adminCookie)
          .send({})
      ).status,
    ).toBe(404);
    expect(
      (
        await http()
          .delete(`/api/v1/inventory/transfers/${id}`)
          .set('Cookie', adminCookie)
      ).status,
    ).toBe(404);
  });

  it('23. listado: filtros por producto, ubicación, almacén (origen o destino) y fechas; orden y paginación', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '20.000');
    const t1 = (await transfer(body(p, locA1, locA2, '1')))
      .body as TransferBody;
    const t2 = (await transfer(body(p, locA1, locB1, '2')))
      .body as TransferBody;
    const get = async (query: string): Promise<Paginated<TransferBody>> =>
      (
        await http()
          .get(`/api/v1/inventory/transfers?${query}`)
          .set('Cookie', adminCookie)
      ).body as Paginated<TransferBody>;

    const byProduct = await get(`productId=${p}`);
    expect(byProduct.total).toBe(2);
    expect(byProduct.data.map((t) => t.id)).toEqual([t2.id, t1.id]); // createdAt DESC
    expect(
      (await get(`productId=${p}&destinationLocationId=${locB1}`)).total,
    ).toBe(1);
    expect((await get(`productId=${p}&sourceLocationId=${locA2}`)).total).toBe(
      0,
    );
    // El almacén B es solo destino de t2: el filtro cubre origen O destino.
    const byWarehouse = await get(`productId=${p}&warehouseId=${warehouseB}`);
    expect(byWarehouse.data.map((t) => t.id)).toEqual([t2.id]);
    expect((await get(`productId=${p}&warehouseId=${warehouseA}`)).total).toBe(
      2,
    );
    expect((await get(`productId=${p}&dateFrom=2999-01-01`)).total).toBe(0);
    expect((await get(`productId=${p}&dateTo=2000-01-01`)).total).toBe(0);
    const page = await get(`productId=${p}&limit=1&page=2`);
    expect(page.data).toHaveLength(1);
    expect(page.total).toBe(2);
    expect(page.totalPages).toBe(2);
    expect(
      (
        await http()
          .get(
            '/api/v1/inventory/transfers?dateFrom=2026-12-01&dateTo=2026-11-01',
          )
          .set('Cookie', adminCookie)
      ).status,
    ).toBe(400);
  });

  it('24. kardex: ambos movimientos salen con origin=TRANSFER, su ubicación y transferId; los demás, transferId null', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '10.000');
    const t = (await transfer(body(p, locA1, locA2, '4'))).body as TransferBody;
    const res = await http()
      .get(`/api/v1/inventory/products/${p}/movements?limit=50`)
      .set('Cookie', adminCookie);
    expect(res.status).toBe(200);
    const movements = (res.body as Paginated<MovementBody>).data;
    const transferMovements = movements.filter((m) => m.origin === 'TRANSFER');
    expect(transferMovements).toHaveLength(2);
    for (const m of transferMovements) expect(m.transferId).toBe(t.id);
    expect(
      transferMovements.find((m) => m.movementType === 'EXIT')?.location?.id,
    ).toBe(locA1);
    expect(
      transferMovements.find((m) => m.movementType === 'ENTRY')?.location?.id,
    ).toBe(locA2);
    const manual = movements.find((m) => m.origin === 'MANUAL');
    expect(manual?.transferId).toBeNull();

    const filtered = await http()
      .get(`/api/v1/inventory/movements?productId=${p}&origin=TRANSFER`)
      .set('Cookie', adminCookie);
    expect((filtered.body as Paginated<MovementBody>).total).toBe(2);
    const detail = await http()
      .get(`/api/v1/inventory/movements/${t.exitMovementId}`)
      .set('Cookie', adminCookie);
    expect((detail.body as MovementBody).transferId).toBe(t.id);
  });

  it('25. auditoría: documento y ambos movimientos quedan auditados con el usuario real', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '10.000');
    const t = (await transfer(body(p, locA1, locA2, '2'), warehouseCookie))
      .body as TransferBody;
    const docAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: 'INVENTORY_TRANSFER_CREATED', entityId: t.id },
    });
    expect(docAudit.userId).toBe(t.createdBy.id);
    expect(docAudit.entityType).toBe('StockTransfer');
    expect(docAudit.metadata).toMatchObject({
      transferId: t.id,
      productId: p,
      quantity: '2.000',
      sourceLocationId: locA1,
      destinationLocationId: locA2,
      exitMovementId: t.exitMovementId,
      entryMovementId: t.entryMovementId,
    });
    expect(
      await prisma.auditLog.count({
        where: {
          action: { in: ['INVENTORY_EXIT_CREATED', 'INVENTORY_ENTRY_CREATED'] },
          entityId: { in: [t.exitMovementId, t.entryMovementId] },
        },
      }),
    ).toBe(2);
  });

  it('26. una transferencia no genera valorización, COGS ni asientos contables', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '10.000');
    const before = {
      valuations: await prisma.inventoryValuation.count(),
      entries: await prisma.accountingEntry.count(),
      payments: await prisma.payment.count(),
    };
    expect((await transfer(body(p, locA1, locB1, '6'))).status).toBe(201);
    expect(await prisma.inventoryValuation.count()).toBe(before.valuations);
    expect(await prisma.accountingEntry.count()).toBe(before.entries);
    expect(await prisma.payment.count()).toBe(before.payments);
  });

  it('27. después de transferir, el stock queda vendible desde el destino (stock por ubicación y venta)', async () => {
    const p = await createTracked();
    await addStock(p, locA1, '10.000');
    expect((await transfer(body(p, locA1, locA2, '6'))).status).toBe(201);
    const stock = await http()
      .get(`/api/v1/inventory/products/${p}/stock-by-location`)
      .set('Cookie', adminCookie);
    const byLocation = new Map(
      (
        stock.body as {
          locations: { location: { id: string }; quantity: string }[];
        }
      ).locations.map((l) => [l.location.id, l.quantity]),
    );
    expect(byLocation.get(locA1)).toBe('4.000');
    expect(byLocation.get(locA2)).toBe('6.000');
    const sale = await http()
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send({
        customerId,
        items: [{ productId: p, quantity: '6', locationId: locA2 }],
      });
    expect(sale.status).toBe(201);
    saleIds.push((sale.body as { id: string }).id);
    expect(qty(await balances(p), locA2)).toBe('0.000');
  });

  // ==================================================================
  // Restricciones de base de datos (sin desactivarlas)
  // ==================================================================

  describe('restricciones nuevas (se prueban intentando violarlas)', () => {
    it('28. la base rechaza un movimiento TRANSFER que sea ajuste o no referencie a su documento', async () => {
      const p = await createTracked();
      const base = {
        productId: p,
        origin: InventoryMovementOrigin.TRANSFER,
        quantity: new Prisma.Decimal('1'),
        previousStock: new Prisma.Decimal('0'),
        newStock: new Prisma.Decimal('1'),
        reason: 'Intento inválido',
        createdByUserId: adminId,
        locationId: locA1,
        locationPreviousStock: new Prisma.Decimal('0'),
        locationNewStock: new Prisma.Decimal('1'),
      };
      // Ajuste con origen TRANSFER.
      await expect(
        prisma.inventoryMovement.create({
          data: {
            ...base,
            movementType: InventoryMovementType.ADJUSTMENT_IN,
            referenceType: 'StockTransfer',
            referenceId: 'x',
          },
        }),
      ).rejects.toThrow(/inventory_movements_transfer_consistency/);
      // ENTRY sin referencia al documento.
      await expect(
        prisma.inventoryMovement.create({
          data: { ...base, movementType: InventoryMovementType.ENTRY },
        }),
      ).rejects.toThrow(/inventory_movements_transfer_consistency/);
      // ENTRY con otro tipo de referencia.
      await expect(
        prisma.inventoryMovement.create({
          data: {
            ...base,
            movementType: InventoryMovementType.ENTRY,
            referenceType: 'Sale',
            referenceId: 'x',
          },
        }),
      ).rejects.toThrow(/inventory_movements_transfer_consistency/);
      expect(
        await prisma.inventoryMovement.count({ where: { productId: p } }),
      ).toBe(0);
    });

    it('29. la base rechaza una transferencia con origen igual a destino, cantidad no positiva o clave en blanco', async () => {
      const p = await createTracked();
      await addStock(p, locA1, '10.000');
      const t = (await transfer(body(p, locA1, locA2, '1')))
        .body as TransferBody;
      const dup = {
        productId: p,
        sourceLocationId: locA1,
        destinationLocationId: locA2,
        quantity: new Prisma.Decimal('1'),
        reason: 'Intento inválido',
        createdByUserId: adminId,
        exitMovementId: t.exitMovementId,
        entryMovementId: t.entryMovementId,
      };
      await expect(
        prisma.stockTransfer.create({
          data: { ...dup, destinationLocationId: locA1 },
        }),
      ).rejects.toThrow(/stock_transfers_locations_differ/);
      await expect(
        prisma.stockTransfer.create({
          data: { ...dup, quantity: new Prisma.Decimal('0') },
        }),
      ).rejects.toThrow(/stock_transfers_quantity_positive/);
      await expect(
        prisma.stockTransfer.create({
          data: { ...dup, idempotencyKey: '   ' },
        }),
      ).rejects.toThrow(/stock_transfers_idempotency_key_not_blank/);
      expect(
        await prisma.stockTransfer.count({ where: { productId: p } }),
      ).toBe(1);
    });
  });
});
