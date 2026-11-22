import { INestApplication } from '@nestjs/common';
import {
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
import {
  createProductRow,
  deleteProductRows,
  getDefaultLocationId,
} from './helpers/stock-fixtures';

/**
 * R2-B1b — movimientos manuales de inventario por ubicación, trazabilidad de
 * ubicación en el kardex y stock por ubicación. Todo contra PostgreSQL real
 * descartable (la guardia E2E valida el destino antes de arrancar).
 */

const RUN = Date.now() % 100000000;
let counter = 0;
const nextCode = (prefix: string): string => `${prefix}${RUN}${(counter += 1)}`;
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

const WAREHOUSE_USERNAME = 'e2e_warehouse_invloc';
const WAREHOUSE_PASSWORD = 'WarehouseInvLoc123';
const MANAGEMENT_USERNAME = 'e2e_management_invloc';
const MANAGEMENT_PASSWORD = 'ManagementInvLoc123';
const SELLER_USERNAME = 'e2e_seller_invloc';
const SELLER_PASSWORD = 'SellerInvLoc123';

interface LocationSummary {
  id: string;
  code: string;
  name: string;
  warehouse: { id: string; code: string };
}
interface MovementBody {
  id: string;
  product: { id: string };
  movementType: InventoryMovementType;
  origin: InventoryMovementOrigin;
  quantity: string;
  previousStock: string;
  newStock: string;
  location: LocationSummary | null;
  createdAt: string;
}
interface Paginated<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}
interface StockByLocationBody {
  productId: string;
  sku: string;
  name: string;
  stockCurrent: string;
  unitAbbreviation: string;
  allowDecimal: boolean;
  locations: { location: LocationSummary; quantity: string }[];
}
interface IdBody {
  id: string;
}

describe('R2-B1b — inventario manual por ubicación (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let categoryId: string;
  let unitId: string;
  let defaultLocationId: string;
  let warehouseId: string; // almacén activo propio con 3 ubicaciones
  let locA: string;
  let locB: string;
  let locC: string;
  let inactiveLocationId: string;
  let inactiveWarehouseLocationId: string;
  const productIds: string[] = [];
  const warehouseIds: string[] = [];

  const http = () => request(app.getHttpServer());

  async function post(
    path: string,
    body: Record<string, unknown>,
    cookie = adminCookie,
  ): Promise<request.Response> {
    return http()
      .post(`/api/v1/inventory/${path}`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function createProduct(
    overrides: Partial<Prisma.ProductUncheckedCreateInput> = {},
  ): Promise<string> {
    const row = await createProductRow(prisma, {
      data: {
        sku: nextCode('INVLOC-'),
        name: 'Producto e2e ubicaciones',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '10.00',
        isInventoryTracked: true,
        status: ProductStatus.ACTIVE,
        ...overrides,
      },
      select: { id: true },
    });
    productIds.push(row.id);
    return row.id;
  }

  async function createWarehouseWithLocations(
    count: number,
  ): Promise<{ warehouseId: string; locationIds: string[] }> {
    const created = await http()
      .post('/api/v1/warehouses')
      .set('Cookie', adminCookie)
      .send({ code: nextCode('W'), name: 'Almacén e2e ubicaciones' });
    if (created.status !== 201) {
      throw new Error(`fixture almacén: ${JSON.stringify(created.body)}`);
    }
    const id = (created.body as IdBody).id;
    warehouseIds.push(id);
    const locationIds: string[] = [];
    for (let i = 0; i < count; i += 1) {
      const loc = await http()
        .post(`/api/v1/warehouses/${id}/locations`)
        .set('Cookie', adminCookie)
        .send({ code: nextCode('L'), name: `Ubicación ${i}` });
      if (loc.status !== 201) {
        throw new Error(`fixture ubicación: ${JSON.stringify(loc.body)}`);
      }
      locationIds.push((loc.body as IdBody).id);
    }
    return { warehouseId: id, locationIds };
  }

  /** Cantidades por ubicación + consolidado; verifica la conciliación y que no haya negativos. */
  async function expectReconciled(
    productId: string,
  ): Promise<Map<string, string>> {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    const balances = await prisma.stockBalance.findMany({
      where: { productId },
    });
    const sum = balances.reduce(
      (acc, b) => acc.plus(b.quantity),
      new Prisma.Decimal(0),
    );
    expect(sum.toFixed(3)).toBe(product.stockCurrent.toFixed(3));
    for (const b of balances) {
      expect(b.quantity.greaterThanOrEqualTo(0)).toBe(true);
    }
    expect(product.stockCurrent.greaterThanOrEqualTo(0)).toBe(true);
    return new Map(balances.map((b) => [b.locationId, b.quantity.toFixed(3)]));
  }

  async function movementCount(productId: string): Promise<number> {
    return prisma.inventoryMovement.count({ where: { productId } });
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_invloc@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_invloc@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_invloc@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    const server = app.getHttpServer();
    adminCookie = (
      await login(server, E2E_ADMIN_USERNAME, E2E_ADMIN_ACTIVE_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(server, WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(server, MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    sellerCookie = (await login(server, SELLER_USERNAME, SELLER_PASSWORD))
      .cookie;

    const category = await prisma.category.upsert({
      where: { code: 'E2E_INVLOCCAT' },
      update: {},
      create: { code: 'E2E_INVLOCCAT', name: 'Categoria e2e inv-ubicaciones' },
    });
    categoryId = category.id;
    const unit = await prisma.unit.upsert({
      where: { code: 'E2EINVLOCU' },
      update: { allowDecimal: true },
      create: {
        code: 'E2EINVLOCU',
        name: 'Unidad e2e inv-ubicaciones',
        abbreviation: 'eil',
        allowDecimal: true,
      },
    });
    unitId = unit.id;
    defaultLocationId = await getDefaultLocationId(prisma);

    const main = await createWarehouseWithLocations(3);
    warehouseId = main.warehouseId;
    [locA, locB, locC] = main.locationIds;

    const withInactiveLocation = await createWarehouseWithLocations(1);
    inactiveLocationId = withInactiveLocation.locationIds[0];
    await prisma.warehouseLocation.update({
      where: { id: inactiveLocationId },
      data: { status: WarehouseStatus.INACTIVE },
    });

    const withInactiveWarehouse = await createWarehouseWithLocations(1);
    inactiveWarehouseLocationId = withInactiveWarehouse.locationIds[0];
    await prisma.warehouse.update({
      where: { id: withInactiveWarehouse.warehouseId },
      data: { status: WarehouseStatus.INACTIVE },
    });
  }, 90000);

  afterAll(async () => {
    try {
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
  });

  describe('compatibilidad: solicitudes sin locationId (1, 2, 13)', () => {
    it('sin locationId el movimiento cae en MAIN/DEFAULT y la respuesta lo muestra', async () => {
      const productId = await createProduct();

      const res = await post('entries', {
        productId,
        quantity: '5.000',
        reason: 'Entrada sin ubicación',
      });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.location?.id).toBe(defaultLocationId);
      expect(body.location?.code).toBe('DEFAULT');
      expect(body.location?.warehouse.code).toBe('MAIN');
      expect(body.newStock).toBe('5.000');
      const balances = await expectReconciled(productId);
      expect(balances.get(defaultLocationId)).toBe('5.000');
      const stored = await prisma.inventoryMovement.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(stored.locationId).toBe(defaultLocationId);
    });

    it('DEFAULT explícito equivale a omitirlo', async () => {
      const productId = await createProduct();
      await post('entries', { productId, quantity: '4.000', reason: 'a' });

      const res = await post('exits', {
        productId,
        quantity: '1.500',
        reason: 'Salida DEFAULT explícita',
        locationId: defaultLocationId,
      });

      expect(res.status).toBe(201);
      expect((res.body as MovementBody).location?.id).toBe(defaultLocationId);
      const balances = await expectReconciled(productId);
      expect(balances.get(defaultLocationId)).toBe('2.500');
    });

    it('un campo no permitido sigue rechazado con 400 (whitelist)', async () => {
      const productId = await createProduct();
      const res = await post('entries', {
        productId,
        quantity: '1.000',
        reason: 'x',
        warehouseId,
      });
      expect(res.status).toBe(400);
      expect(await movementCount(productId)).toBe(0);
    });
  });

  describe('movimientos en una ubicación distinta de DEFAULT (3, 4, 5, 6)', () => {
    it('entrada, salida y ajustes ± por ubicación; DEFAULT no se toca', async () => {
      const productId = await createProduct();
      await post('entries', { productId, quantity: '10.000', reason: 'base' });

      const entry = await post('entries', {
        productId,
        quantity: '6.000',
        reason: 'Entrada en A',
        locationId: locA,
      });
      expect(entry.status).toBe(201);
      expect((entry.body as MovementBody).location?.id).toBe(locA);
      // previous/new siguen siendo CONSOLIDADOS (contrato histórico).
      expect((entry.body as MovementBody).previousStock).toBe('10.000');
      expect((entry.body as MovementBody).newStock).toBe('16.000');
      await expectReconciled(productId);

      const exit = await post('exits', {
        productId,
        quantity: '2.000',
        reason: 'Salida de A',
        locationId: locA,
      });
      expect(exit.status).toBe(201);
      await expectReconciled(productId);

      const adjIn = await post('adjustments/in', {
        productId,
        quantity: '1.250',
        reason: 'Ajuste + en A',
        locationId: locA,
      });
      expect(adjIn.status).toBe(201);
      await expectReconciled(productId);

      const adjOut = await post('adjustments/out', {
        productId,
        quantity: '0.250',
        reason: 'Ajuste - en A',
        locationId: locA,
      });
      expect(adjOut.status).toBe(201);

      const balances = await expectReconciled(productId);
      expect(balances.get(locA)).toBe('5.000');
      expect(balances.get(defaultLocationId)).toBe('10.000');
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('15.000');
    });

    it('dos ubicaciones del mismo producto: cada una lleva su saldo y el consolidado suma ambas', async () => {
      const productId = await createProduct();
      await post('entries', {
        productId,
        quantity: '3.000',
        reason: 'A',
        locationId: locA,
      });
      await post('entries', {
        productId,
        quantity: '4.000',
        reason: 'B',
        locationId: locB,
      });
      await post('exits', {
        productId,
        quantity: '1.000',
        reason: 'A',
        locationId: locA,
      });

      const balances = await expectReconciled(productId);
      expect(balances.get(locA)).toBe('2.000');
      expect(balances.get(locB)).toBe('4.000');
      expect(balances.has(defaultLocationId)).toBe(false);
    });

    it('el movimiento persiste locationPreviousStock/locationNewStock de su ubicación', async () => {
      const productId = await createProduct();
      await post('entries', { productId, quantity: '9.000', reason: 'base' });
      const res = await post('entries', {
        productId,
        quantity: '2.000',
        reason: 'A',
        locationId: locA,
      });
      const stored = await prisma.inventoryMovement.findUniqueOrThrow({
        where: { id: (res.body as MovementBody).id },
      });
      expect(stored.locationPreviousStock?.toFixed(3)).toBe('0.000');
      expect(stored.locationNewStock?.toFixed(3)).toBe('2.000');
      expect(stored.previousStock.toFixed(3)).toBe('9.000');
      expect(stored.newStock.toFixed(3)).toBe('11.000');
    });

    it('la auditoría registra locationId del movimiento', async () => {
      const productId = await createProduct();
      const res = await post('entries', {
        productId,
        quantity: '1.000',
        reason: 'auditoría',
        locationId: locB,
      });
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          entityType: 'InventoryMovement',
          entityId: (res.body as MovementBody).id,
        },
      });
      expect((audit.metadata as Record<string, unknown>).locationId).toBe(locB);
    });
  });

  describe('insuficiencia y ubicaciones inválidas (7–11)', () => {
    it('7. salida mayor al saldo de la ubicación aunque el consolidado alcance → 409 sin efectos', async () => {
      const productId = await createProduct();
      await post('entries', { productId, quantity: '5.000', reason: 'D' });
      await post('entries', {
        productId,
        quantity: '5.000',
        reason: 'A',
        locationId: locA,
      });
      const before = await movementCount(productId);

      for (const path of ['exits', 'adjustments/out']) {
        const res = await post(path, {
          productId,
          quantity: '7.000',
          reason: 'demasiado',
          locationId: locA,
        });
        expect(res.status).toBe(409);
      }

      expect(await movementCount(productId)).toBe(before);
      const balances = await expectReconciled(productId);
      expect(balances.get(locA)).toBe('5.000');
      expect(balances.get(defaultLocationId)).toBe('5.000');
    });

    it.each(['entries', 'exits', 'adjustments/in', 'adjustments/out'])(
      '8. %s con ubicación inexistente → 404 sin efectos',
      async (path) => {
        const productId = await createProduct();
        await post('entries', { productId, quantity: '5.000', reason: 'D' });
        const before = await movementCount(productId);

        const res = await post(path, {
          productId,
          quantity: '1.000',
          reason: 'x',
          locationId: NON_EXISTENT_UUID,
        });

        expect(res.status).toBe(404);
        expect(await movementCount(productId)).toBe(before);
        await expectReconciled(productId);
      },
    );

    it('8b. saldo inicial con ubicación inexistente → 404 y el producto sigue sin movimientos', async () => {
      const productId = await createProduct();
      const res = await post('initial-balances', {
        productId,
        quantity: '5.000',
        reason: 'x',
        locationId: NON_EXISTENT_UUID,
      });
      expect(res.status).toBe(404);
      expect(await movementCount(productId)).toBe(0);
    });

    it('9. identificador malformado → 400 en las 5 rutas', async () => {
      const productId = await createProduct();
      for (const path of [
        'initial-balances',
        'entries',
        'exits',
        'adjustments/in',
        'adjustments/out',
      ]) {
        const res = await post(path, {
          productId,
          quantity: '1.000',
          reason: 'x',
          locationId: 'no-es-uuid',
        });
        expect(res.status).toBe(400);
      }
      expect(await movementCount(productId)).toBe(0);
    });

    it('10. ubicación inactiva → 409 sin efectos', async () => {
      const productId = await createProduct();
      const res = await post('entries', {
        productId,
        quantity: '1.000',
        reason: 'x',
        locationId: inactiveLocationId,
      });
      expect(res.status).toBe(409);
      expect(await movementCount(productId)).toBe(0);
      expect(await prisma.stockBalance.count({ where: { productId } })).toBe(0);
    });

    it('11. almacén inactivo (ubicación activa) → 409 sin efectos', async () => {
      const productId = await createProduct();
      const res = await post('entries', {
        productId,
        quantity: '1.000',
        reason: 'x',
        locationId: inactiveWarehouseLocationId,
      });
      expect(res.status).toBe(409);
      expect(await movementCount(productId)).toBe(0);
    });
  });

  describe('saldo inicial único por producto (12)', () => {
    it('el saldo inicial se registra en la ubicación indicada', async () => {
      const productId = await createProduct();

      const res = await post('initial-balances', {
        productId,
        quantity: '8.000',
        reason: 'Saldo inicial en A',
        locationId: locA,
      });

      expect(res.status).toBe(201);
      const body = res.body as MovementBody;
      expect(body.origin).toBe(InventoryMovementOrigin.INITIAL_BALANCE);
      expect(body.location?.id).toBe(locA);
      const balances = await expectReconciled(productId);
      expect(balances.get(locA)).toBe('8.000');
      expect(balances.has(defaultLocationId)).toBe(false);
    });

    it('un segundo saldo inicial (en otra ubicación, o en la misma) → 409; la segunda carga es una entrada', async () => {
      const productId = await createProduct();
      await post('initial-balances', {
        productId,
        quantity: '8.000',
        reason: 'primero',
        locationId: locA,
      });
      const before = await movementCount(productId);

      const other = await post('initial-balances', {
        productId,
        quantity: '3.000',
        reason: 'segundo en B',
        locationId: locB,
      });
      const same = await post('initial-balances', {
        productId,
        quantity: '3.000',
        reason: 'segundo en A',
        locationId: locA,
      });
      const entry = await post('entries', {
        productId,
        quantity: '3.000',
        reason: 'entrada normal en B',
        locationId: locB,
      });

      expect(other.status).toBe(409);
      expect(same.status).toBe(409);
      expect(entry.status).toBe(201);
      expect(await movementCount(productId)).toBe(before + 1);
      const balances = await expectReconciled(productId);
      expect(balances.get(locA)).toBe('8.000');
      expect(balances.get(locB)).toBe('3.000');
    });
  });

  describe('permisos actuales de escritura (14)', () => {
    it('ADMIN y WAREHOUSE pueden operar con locationId', async () => {
      const productId = await createProduct();
      for (const cookie of [adminCookie, warehouseCookie]) {
        const res = await post(
          'entries',
          { productId, quantity: '1.000', reason: 'rol', locationId: locC },
          cookie,
        );
        expect(res.status).toBe(201);
      }
      const balances = await expectReconciled(productId);
      expect(balances.get(locC)).toBe('2.000');
    });

    it.each([
      ['MANAGEMENT', () => managementCookie],
      ['SELLER', () => sellerCookie],
    ])(
      '%s no puede escribir (403), con o sin locationId',
      async (_n, cookie) => {
        const productId = await createProduct();
        for (const body of [
          { productId, quantity: '1.000', reason: 'x' },
          { productId, quantity: '1.000', reason: 'x', locationId: locA },
        ]) {
          const res = await post('entries', body, cookie());
          expect(res.status).toBe(403);
        }
        expect(await movementCount(productId)).toBe(0);
      },
    );

    it('sin sesión → 401', async () => {
      const res = await http()
        .post('/api/v1/inventory/entries')
        .send({ productId: NON_EXISTENT_UUID, quantity: '1.000', reason: 'x' });
      expect(res.status).toBe(401);
    });
  });

  describe('trazabilidad: kardex, filtro y paginación (15, 16, 17)', () => {
    let productId: string;

    beforeAll(async () => {
      productId = await createProduct();
      await post('entries', { productId, quantity: '20.000', reason: 'D' });
      for (let i = 0; i < 3; i += 1) {
        await post('entries', {
          productId,
          quantity: '1.000',
          reason: `A${i}`,
          locationId: locA,
        });
      }
      await post('entries', {
        productId,
        quantity: '1.000',
        reason: 'B0',
        locationId: locB,
      });
    });

    it('15. el filtro locationId devuelve solo esa ubicación y conserva paginación y orden', async () => {
      const page1 = await http()
        .get(
          `/api/v1/inventory/movements?productId=${productId}&locationId=${locA}&limit=2&page=1`,
        )
        .set('Cookie', adminCookie);
      const page2 = await http()
        .get(
          `/api/v1/inventory/movements?productId=${productId}&locationId=${locA}&limit=2&page=2`,
        )
        .set('Cookie', adminCookie);

      expect(page1.status).toBe(200);
      const p1 = page1.body as Paginated<MovementBody>;
      const p2 = page2.body as Paginated<MovementBody>;
      expect(p1.total).toBe(3);
      expect(p1.totalPages).toBe(2);
      expect(p1.data).toHaveLength(2);
      expect(p2.data).toHaveLength(1);
      for (const m of [...p1.data, ...p2.data]) {
        expect(m.location?.id).toBe(locA);
      }
      const dates = [...p1.data, ...p2.data].map((m) => m.createdAt);
      expect([...dates].sort().reverse()).toEqual(dates);
    });

    it('sin el filtro se listan todas las ubicaciones; otros filtros se combinan con AND', async () => {
      const all = await http()
        .get(`/api/v1/inventory/movements?productId=${productId}&limit=100`)
        .set('Cookie', adminCookie);
      expect((all.body as Paginated<MovementBody>).total).toBe(5);

      const combined = await http()
        .get(
          `/api/v1/inventory/movements?productId=${productId}&locationId=${locB}&movementType=ENTRY&origin=MANUAL`,
        )
        .set('Cookie', adminCookie);
      expect((combined.body as Paginated<MovementBody>).total).toBe(1);

      const none = await http()
        .get(
          `/api/v1/inventory/movements?productId=${productId}&locationId=${locA}&movementType=EXIT`,
        )
        .set('Cookie', adminCookie);
      expect((none.body as Paginated<MovementBody>).total).toBe(0);
    });

    it('filtro malformado → 400; ubicación inexistente → lista vacía', async () => {
      const bad = await http()
        .get('/api/v1/inventory/movements?locationId=xx')
        .set('Cookie', adminCookie);
      expect(bad.status).toBe(400);
      const none = await http()
        .get(`/api/v1/inventory/movements?locationId=${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie);
      expect(none.status).toBe(200);
      expect((none.body as Paginated<MovementBody>).total).toBe(0);
    });

    it('16. el kardex por producto muestra la ubicación y admite el filtro', async () => {
      const res = await http()
        .get(
          `/api/v1/inventory/products/${productId}/movements?locationId=${locB}`,
        )
        .set('Cookie', warehouseCookie);
      expect(res.status).toBe(200);
      const body = res.body as Paginated<MovementBody>;
      expect(body.total).toBe(1);
      expect(body.data[0].location).toEqual({
        id: locB,
        code: expect.any(String) as string,
        name: expect.any(String) as string,
        warehouse: { id: warehouseId, code: expect.any(String) as string },
      });
      const byId = await http()
        .get(`/api/v1/inventory/movements/${body.data[0].id}`)
        .set('Cookie', managementCookie);
      expect((byId.body as MovementBody).location?.id).toBe(locB);
    });

    it('MANAGEMENT lee con filtro; SELLER no lee movimientos (403)', async () => {
      const ok = await http()
        .get(`/api/v1/inventory/movements?locationId=${locA}`)
        .set('Cookie', managementCookie);
      expect(ok.status).toBe(200);
      const denied = await http()
        .get(`/api/v1/inventory/movements?locationId=${locA}`)
        .set('Cookie', sellerCookie);
      expect(denied.status).toBe(403);
    });

    it('se puede consultar una ubicación inactiva con movimientos históricos', async () => {
      const { locationIds } = await createWarehouseWithLocations(1);
      const [later] = locationIds;
      const pid = await createProduct();
      await post('entries', {
        productId: pid,
        quantity: '1.000',
        reason: 'antes de desactivar',
        locationId: later,
      });
      await prisma.warehouseLocation.update({
        where: { id: later },
        data: { status: WarehouseStatus.INACTIVE },
      });

      const res = await http()
        .get(`/api/v1/inventory/movements?locationId=${later}`)
        .set('Cookie', adminCookie);

      expect(res.status).toBe(200);
      const body = res.body as Paginated<MovementBody>;
      expect(body.total).toBe(1);
      expect(body.data[0].location?.id).toBe(later);
    });

    // 17. El caso «movimiento histórico sin ubicación → location: null» se cubre
    // en pruebas unitarias (inventory.service.spec.ts, listMovements) y en el
    // procedimiento manual reproducible test/manual-r2-act/. No se simula aquí
    // porque exigiría alterar el CHECK del esquema en una base ya activada.
  });

  describe('GET /inventory/products/:productId/stock-by-location (18)', () => {
    const get = (id: string, cookie = adminCookie) =>
      http()
        .get(`/api/v1/inventory/products/${id}/stock-by-location`)
        .set('Cookie', cookie);

    it('devuelve el consolidado y el desglose (suma igual al consolidado), con contrato mínimo', async () => {
      const productId = await createProduct({ stockMinimum: '2.000' });
      await post('entries', { productId, quantity: '3.500', reason: 'D' });
      await post('entries', {
        productId,
        quantity: '2.000',
        reason: 'B',
        locationId: locB,
      });
      await post('entries', {
        productId,
        quantity: '1.250',
        reason: 'A',
        locationId: locA,
      });

      const res = await get(productId);

      expect(res.status).toBe(200);
      const body = res.body as StockByLocationBody;
      expect(Object.keys(body).sort()).toEqual(
        [
          'allowDecimal',
          'locations',
          'name',
          'productId',
          'sku',
          'stockCurrent',
          'unitAbbreviation',
        ].sort(),
      );
      expect(body.productId).toBe(productId);
      expect(body.stockCurrent).toBe('6.750');
      expect(body.unitAbbreviation).toBe('eil');
      expect(body.allowDecimal).toBe(true);
      expect(body.locations).toHaveLength(3);
      const sum = body.locations.reduce(
        (acc, row) => acc.plus(row.quantity),
        new Prisma.Decimal(0),
      );
      expect(sum.toFixed(3)).toBe(body.stockCurrent);
      for (const row of body.locations) {
        expect(Object.keys(row).sort()).toEqual(['location', 'quantity']);
        expect(Object.keys(row.location).sort()).toEqual(
          ['code', 'id', 'name', 'warehouse'].sort(),
        );
        expect(Object.keys(row.location.warehouse).sort()).toEqual([
          'code',
          'id',
        ]);
      }
      // Orden estable: por código de almacén y luego de ubicación.
      const keys = body.locations.map(
        (r) => `${r.location.warehouse.code}|${r.location.code}`,
      );
      expect([...keys].sort()).toEqual(keys);
    });

    it('omite las ubicaciones sin existencias (también las que quedaron en 0)', async () => {
      const productId = await createProduct();
      await post('entries', {
        productId,
        quantity: '2.000',
        reason: 'A',
        locationId: locA,
      });
      await post('exits', {
        productId,
        quantity: '2.000',
        reason: 'vaciar A',
        locationId: locA,
      });
      await post('entries', {
        productId,
        quantity: '1.000',
        reason: 'B',
        locationId: locB,
      });

      const body = (await get(productId)).body as StockByLocationBody;

      expect(body.stockCurrent).toBe('1.000');
      expect(body.locations.map((r) => r.location.id)).toEqual([locB]);
      // La fila en 0 sigue existiendo en la base: el endpoint solo la omite.
      expect(
        await prisma.stockBalance.count({
          where: { productId, locationId: locA },
        }),
      ).toBe(1);
    });

    it('producto sin existencias → consolidado 0 y desglose vacío; no crea saldos', async () => {
      const productId = await createProduct();

      const res = await get(productId);

      expect(res.status).toBe(200);
      const body = res.body as StockByLocationBody;
      expect(body.stockCurrent).toBe('0.000');
      expect(body.locations).toEqual([]);
      expect(await prisma.stockBalance.count({ where: { productId } })).toBe(0);
      expect(await movementCount(productId)).toBe(0);
    });

    it('permisos: ADMIN/WAREHOUSE/MANAGEMENT/SELLER leen; sin sesión 401', async () => {
      const productId = await createProduct();
      for (const cookie of [
        adminCookie,
        warehouseCookie,
        managementCookie,
        sellerCookie,
      ]) {
        expect((await get(productId, cookie)).status).toBe(200);
      }
      const anon = await http().get(
        `/api/v1/inventory/products/${productId}/stock-by-location`,
      );
      expect(anon.status).toBe(401);
    });

    it('errores: inexistente 404, id malformado 400, servicio/no inventariable 400, SELLER con producto inactivo 404', async () => {
      expect((await get(NON_EXISTENT_UUID)).status).toBe(404);
      expect((await get('xx')).status).toBe(400);
      const service = await createProduct({
        productType: ProductType.SERVICE,
        isInventoryTracked: false,
      });
      expect((await get(service)).status).toBe(400);
      const untracked = await createProduct({ isInventoryTracked: false });
      expect((await get(untracked)).status).toBe(400);
      const inactive = await createProduct({ status: ProductStatus.INACTIVE });
      expect((await get(inactive, sellerCookie)).status).toBe(404);
      expect((await get(inactive, adminCookie)).status).toBe(200);
    });
  });

  describe('concurrencia (19, 20)', () => {
    it('19. lecturas concurrentes con escrituras: el desglose siempre suma el consolidado', async () => {
      const productId = await createProduct();
      await post('entries', {
        productId,
        quantity: '1000.000',
        reason: 'base',
        locationId: locA,
      });
      await post('entries', {
        productId,
        quantity: '1000.000',
        reason: 'base',
        locationId: locB,
      });

      const writes: Promise<request.Response>[] = [];
      const reads: Promise<request.Response>[] = [];
      for (let i = 0; i < 12; i += 1) {
        const loc = i % 2 === 0 ? locA : locB;
        writes.push(
          post(i % 3 === 0 ? 'exits' : 'entries', {
            productId,
            quantity: '1.500',
            reason: `ronda ${i}`,
            locationId: loc,
          }),
        );
        reads.push(
          http()
            .get(`/api/v1/inventory/products/${productId}/stock-by-location`)
            .set('Cookie', adminCookie),
        );
      }
      const [written, read] = await Promise.all([
        Promise.all(writes),
        Promise.all(reads),
      ]);

      for (const res of written) expect(res.status).toBe(201);
      for (const res of read) {
        expect(res.status).toBe(200);
        const body = res.body as StockByLocationBody;
        const sum = body.locations.reduce(
          (acc, row) => acc.plus(row.quantity),
          new Prisma.Decimal(0),
        );
        expect(sum.toFixed(3)).toBe(body.stockCurrent);
      }
      await expectReconciled(productId);
    }, 60000);

    it('20. salidas simultáneas sobre una misma ubicación: nunca saldo negativo ni operaciones parciales', async () => {
      const productId = await createProduct();
      await post('entries', {
        productId,
        quantity: '10.000',
        reason: 'base A',
        locationId: locA,
      });
      await post('entries', {
        productId,
        quantity: '50.000',
        reason: 'base D (el consolidado alcanzaría)',
      });
      const before = await movementCount(productId);

      const results = await Promise.all(
        Array.from({ length: 6 }, (_, i) =>
          post(i % 2 === 0 ? 'exits' : 'adjustments/out', {
            productId,
            quantity: '3.000',
            reason: `simultánea ${i}`,
            locationId: locA,
          }),
        ),
      );

      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 201, 201, 409, 409, 409]);
      expect(await movementCount(productId)).toBe(before + 3);
      const balances = await expectReconciled(productId);
      expect(balances.get(locA)).toBe('1.000');
      expect(balances.get(defaultLocationId)).toBe('50.000');
    }, 60000);

    it('20b. entradas simultáneas sobre una misma ubicación no pierden actualizaciones', async () => {
      const productId = await createProduct();

      const results = await Promise.all(
        Array.from({ length: 8 }, (_, i) =>
          post('entries', {
            productId,
            quantity: '1.000',
            reason: `entrada ${i}`,
            locationId: locC,
          }),
        ),
      );

      for (const r of results) expect(r.status).toBe(201);
      const balances = await expectReconciled(productId);
      expect(balances.get(locC)).toBe('8.000');
    }, 60000);
  });
});
