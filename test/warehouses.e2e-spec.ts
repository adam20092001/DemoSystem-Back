import { INestApplication } from '@nestjs/common';
import {
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  PrismaClient,
  RoleName,
  WarehouseStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
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
  setProductLocationBalances,
} from './helpers/stock-fixtures';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const ROLE_FIXTURES = [
  [RoleName.WAREHOUSE, 'e2e_wh_cat_warehouse', 'WarehouseCat12345'],
  [RoleName.PURCHASING, 'e2e_wh_cat_purchasing', 'PurchasingCat12345'],
  [RoleName.MANAGEMENT, 'e2e_wh_cat_management', 'ManagementCat12345'],
  [RoleName.SELLER, 'e2e_wh_cat_seller', 'SellerCat12345'],
  [RoleName.ACCOUNTANT, 'e2e_wh_cat_accountant', 'AccountantCat12345'],
] as const;

interface WarehouseBody {
  id: string;
  code: string;
  name: string;
  description: string | null;
  status: WarehouseStatus;
  isDefault: boolean;
  createdAt: string;
  updatedAt: string;
}
interface LocationBody extends Omit<WarehouseBody, 'createdAt'> {
  warehouseId: string;
  createdAt: string;
}
interface Paginated<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

/** Hash de la foto de inventario: cantidades, movimientos y saldos. */
async function inventorySnapshot(prisma: PrismaClient): Promise<string> {
  const rows = await prisma.$queryRaw<{ h: string }[]>(Prisma.sql`
    SELECT md5(
      COALESCE((SELECT string_agg(id::text || stock_current::text, ',' ORDER BY id) FROM products), '') ||
      '|' ||
      COALESCE((SELECT string_agg(id::text || previous_stock::text || new_stock::text || quantity::text, ',' ORDER BY id) FROM inventory_movements), '') ||
      '|' ||
      (SELECT count(*)::text FROM stock_balances)
    ) AS h`);
  return rows[0].h;
}

describe('Almacenes y ubicaciones — R2-A1 (catálogo) y R2-ACT (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  const cookies = new Map<RoleName, string>();
  const createdWarehouseIds: string[] = [];
  const createdProductIds: string[] = [];
  let mainId: string;
  let mainDefaultLocationId: string;

  const RUN = Date.now().toString(36).toUpperCase().slice(-6);
  let counter = 0;
  const nextCode = (prefix = 'W'): string => {
    counter += 1;
    return `${prefix}${RUN}${counter}`;
  };

  const http = () => request(app.getHttpServer());

  async function createWarehouse(
    body: Record<string, unknown> = {},
  ): Promise<WarehouseBody> {
    const response = await http()
      .post('/api/v1/warehouses')
      .set('Cookie', adminCookie)
      .send({ code: nextCode(), name: 'Almacén e2e', ...body });
    if (response.status !== 201) {
      throw new Error(`fixture almacén: ${JSON.stringify(response.body)}`);
    }
    const created = response.body as WarehouseBody;
    createdWarehouseIds.push(created.id);
    return created;
  }

  async function createLocation(
    warehouseId: string,
    body: Record<string, unknown> = {},
  ): Promise<LocationBody> {
    const response = await http()
      .post(`/api/v1/warehouses/${warehouseId}/locations`)
      .set('Cookie', adminCookie)
      .send({ code: nextCode('L'), name: 'Ubicación e2e', ...body });
    if (response.status !== 201) {
      throw new Error(`fixture ubicación: ${JSON.stringify(response.body)}`);
    }
    return response.body as LocationBody;
  }

  async function createProductFixture(stock = '0.000'): Promise<string> {
    const category = await prisma.category.upsert({
      where: { code: 'E2E_WHCAT' },
      update: {},
      create: { code: 'E2E_WHCAT', name: 'Categoria e2e almacenes' },
    });
    const unit = await prisma.unit.upsert({
      where: { code: 'E2EWHUNIT' },
      update: {},
      create: {
        code: 'E2EWHUNIT',
        name: 'Unidad e2e almacenes',
        abbreviation: 'ewu',
        allowDecimal: true,
      },
    });
    const product = await createProductRow(prisma, {
      data: {
        sku: `E2E-WH-${RUN}-${(counter += 1)}`,
        name: 'Producto e2e almacenes',
        productType: 'PRODUCT',
        categoryId: category.id,
        unitId: unit.id,
        salePrice: '10.00',
        isInventoryTracked: true,
        stockCurrent: stock,
      },
    });
    createdProductIds.push(product.id);
    return product.id;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    for (const [roleName, username, password] of ROLE_FIXTURES) {
      await upsertFixtureUser(prisma, {
        username,
        email: `${username}@demosystem.test`,
        password,
        roleName,
      });
    }
    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(`admin login: ${JSON.stringify(adminLogin.body)}`);
    }
    adminCookie = adminLogin.cookie;
    for (const [roleName, username, password] of ROLE_FIXTURES) {
      cookies.set(
        roleName,
        (await login(app.getHttpServer(), username, password)).cookie,
      );
    }

    const main = await prisma.warehouse.findUniqueOrThrow({
      where: { code: 'MAIN' },
    });
    mainId = main.id;
    mainDefaultLocationId = (
      await prisma.warehouseLocation.findFirstOrThrow({
        where: { warehouseId: main.id, code: 'DEFAULT' },
      })
    ).id;
  }, 60000);

  afterAll(async () => {
    try {
      if (createdProductIds.length > 0) {
        // Los saldos se eliminan junto con el producto (deleteProductRows):
        // borrar solo los saldos rompería stockCurrent = Σ saldos.
        await prisma.inventoryMovement.deleteMany({
          where: { productId: { in: createdProductIds } },
        });
        await prisma.auditLog.deleteMany({
          where: { entityId: { in: createdProductIds } },
        });
        await deleteProductRows(prisma, {
          where: { id: { in: createdProductIds } },
        });
      }
      if (createdWarehouseIds.length > 0) {
        const locations = await prisma.warehouseLocation.findMany({
          where: { warehouseId: { in: createdWarehouseIds } },
          select: { id: true },
        });
        const entityIds = [
          ...createdWarehouseIds,
          ...locations.map((location) => location.id),
        ];
        await prisma.auditLog.deleteMany({
          where: { entityId: { in: entityIds } },
        });
        await prisma.warehouseLocation.deleteMany({
          where: { warehouseId: { in: createdWarehouseIds } },
        });
        await prisma.warehouse.deleteMany({
          where: { id: { in: createdWarehouseIds } },
        });
      }
      const usernames = ROLE_FIXTURES.map(([, username]) => username);
      await prisma.userRole.deleteMany({
        where: { user: { username: { in: usernames } } },
      });
      await prisma.user.deleteMany({ where: { username: { in: usernames } } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  // ==========================================================================
  // Estado inicial tras la migración
  // ==========================================================================
  describe('MAIN y DEFAULT (datos de catálogo de la migración)', () => {
    it('existe el almacén principal MAIN, ACTIVE y predeterminado', async () => {
      const response = await http()
        .get(`/api/v1/warehouses/${mainId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        code: 'MAIN',
        status: 'ACTIVE',
        isDefault: true,
      });
    });

    it('MAIN tiene su ubicación técnica DEFAULT, ACTIVE y predeterminada', async () => {
      const response = await http()
        .get(`/api/v1/warehouses/${mainId}/locations`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as Paginated<LocationBody>;
      const def = body.data.find((row) => row.code === 'DEFAULT');
      expect(def).toMatchObject({
        id: mainDefaultLocationId,
        warehouseId: mainId,
        status: 'ACTIVE',
        isDefault: true,
      });
    });

    it('el listado devuelve el almacén principal primero', async () => {
      const response = await http()
        .get('/api/v1/warehouses?limit=100')
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as Paginated<WarehouseBody>;
      expect(body.data[0].code).toBe('MAIN');
      expect(body.data.filter((row) => row.isDefault)).toHaveLength(1);
    });

    it('R2-ACT: el consolidado de cada producto coincide con la suma de sus saldos por ubicación', async () => {
      const mismatches = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
        SELECT p.id FROM products p
        WHERE p.stock_current <> COALESCE(
          (SELECT SUM(b.quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)`);
      expect(mismatches).toHaveLength(0);
    });
  });

  // ==========================================================================
  // Autorización
  // ==========================================================================
  describe('autorización (RBAC)', () => {
    it('sin cookie: lectura y escritura responden 401', async () => {
      expect((await http().get('/api/v1/warehouses')).status).toBe(401);
      expect(
        (await http().post('/api/v1/warehouses').send({ code: 'X', name: 'x' }))
          .status,
      ).toBe(401);
    });

    it.each([RoleName.WAREHOUSE, RoleName.MANAGEMENT, RoleName.SELLER])(
      '%s lee el catálogo (200) pero no lo administra (403)',
      async (role) => {
        const cookie = cookies.get(role) as string;
        expect(
          (await http().get('/api/v1/warehouses').set('Cookie', cookie)).status,
        ).toBe(200);
        expect(
          (
            await http()
              .get(`/api/v1/warehouses/${mainId}`)
              .set('Cookie', cookie)
          ).status,
        ).toBe(200);
        expect(
          (
            await http()
              .get(`/api/v1/warehouses/${mainId}/locations`)
              .set('Cookie', cookie)
          ).status,
        ).toBe(200);
        expect(
          (
            await http()
              .get(
                `/api/v1/warehouses/${mainId}/locations/${mainDefaultLocationId}`,
              )
              .set('Cookie', cookie)
          ).status,
        ).toBe(200);

        const before = await prisma.warehouse.count();
        const writes = [
          http()
            .post('/api/v1/warehouses')
            .set('Cookie', cookie)
            .send({ code: nextCode(), name: 'x' }),
          http()
            .patch(`/api/v1/warehouses/${mainId}`)
            .set('Cookie', cookie)
            .send({ name: 'hack' }),
          http()
            .post(`/api/v1/warehouses/${mainId}/deactivate`)
            .set('Cookie', cookie),
          http()
            .post(`/api/v1/warehouses/${mainId}/activate`)
            .set('Cookie', cookie),
          http()
            .post(`/api/v1/warehouses/${mainId}/locations`)
            .set('Cookie', cookie)
            .send({ code: nextCode('L'), name: 'x' }),
          http()
            .patch(
              `/api/v1/warehouses/${mainId}/locations/${mainDefaultLocationId}`,
            )
            .set('Cookie', cookie)
            .send({ name: 'hack' }),
          http()
            .post(
              `/api/v1/warehouses/${mainId}/locations/${mainDefaultLocationId}/deactivate`,
            )
            .set('Cookie', cookie),
          http()
            .post(
              `/api/v1/warehouses/${mainId}/locations/${mainDefaultLocationId}/activate`,
            )
            .set('Cookie', cookie),
        ];
        for (const response of await Promise.all(writes)) {
          expect(response.status).toBe(403);
        }
        expect(await prisma.warehouse.count()).toBe(before);
        const main = await prisma.warehouse.findUniqueOrThrow({
          where: { id: mainId },
        });
        expect(main.name).not.toBe('hack');
      },
    );

    it.each([RoleName.ACCOUNTANT])(
      '%s no tiene ningún acceso al catálogo (403 en lectura y escritura)',
      async (role) => {
        const cookie = cookies.get(role) as string;
        const responses = await Promise.all([
          http().get('/api/v1/warehouses').set('Cookie', cookie),
          http().get(`/api/v1/warehouses/${mainId}`).set('Cookie', cookie),
          http()
            .get(`/api/v1/warehouses/${mainId}/locations`)
            .set('Cookie', cookie),
          http()
            .post('/api/v1/warehouses')
            .set('Cookie', cookie)
            .send({ code: nextCode(), name: 'x' }),
          http()
            .post(`/api/v1/warehouses/${mainId}/locations`)
            .set('Cookie', cookie)
            .send({ code: nextCode('L'), name: 'x' }),
        ]);
        for (const response of responses) {
          expect(response.status).toBe(403);
        }
      },
    );

    it('ADMIN administra el catálogo', async () => {
      const created = await createWarehouse();
      expect(created.status).toBe('ACTIVE');
    });
  });

  // ==========================================================================
  // Almacenes
  // ==========================================================================
  describe('almacenes', () => {
    it('crea un almacén ACTIVE, no predeterminado, con su ubicación DEFAULT', async () => {
      const code = nextCode();
      const created = await createWarehouse({
        code: ` ${code.toLowerCase()} `,
        name: '  Almacén Sur  ',
        description: '  Zona sur ',
      });
      expect(created).toMatchObject({
        code,
        name: 'Almacén Sur',
        description: 'Zona sur',
        status: 'ACTIVE',
        isDefault: false,
      });

      const locations = await http()
        .get(`/api/v1/warehouses/${created.id}/locations`)
        .set('Cookie', adminCookie);
      const body = locations.body as Paginated<LocationBody>;
      expect(body.total).toBe(1);
      expect(body.data[0]).toMatchObject({
        code: 'DEFAULT',
        isDefault: true,
        status: 'ACTIVE',
        warehouseId: created.id,
      });
    });

    it('rechaza códigos duplicados con 409, insensible a mayúsculas y espacios', async () => {
      const created = await createWarehouse();
      for (const variant of [
        created.code,
        created.code.toLowerCase(),
        `  ${created.code.toLowerCase()}  `,
      ]) {
        const response = await http()
          .post('/api/v1/warehouses')
          .set('Cookie', adminCookie)
          .send({ code: variant, name: 'dup' });
        expect(response.status).toBe(409);
      }
      const main = await http()
        .post('/api/v1/warehouses')
        .set('Cookie', adminCookie)
        .send({ code: 'main', name: 'dup' });
      expect(main.status).toBe(409);
    });

    it('un 409 no deja filas huérfanas (rollback)', async () => {
      const created = await createWarehouse();
      const before = await prisma.warehouseLocation.count();
      await http()
        .post('/api/v1/warehouses')
        .set('Cookie', adminCookie)
        .send({ code: created.code, name: 'dup' });
      expect(await prisma.warehouseLocation.count()).toBe(before);
    });

    it('dos POST concurrentes con el mismo código: exactamente uno gana', async () => {
      const code = nextCode();
      const [a, b] = await Promise.all([
        http()
          .post('/api/v1/warehouses')
          .set('Cookie', adminCookie)
          .send({ code, name: 'A' }),
        http()
          .post('/api/v1/warehouses')
          .set('Cookie', adminCookie)
          .send({ code, name: 'B' }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const winner = (a.status === 201 ? a : b).body as WarehouseBody;
      createdWarehouseIds.push(winner.id);
      expect(await prisma.warehouse.count({ where: { code } })).toBe(1);
      expect(
        await prisma.warehouseLocation.count({
          where: { warehouseId: winner.id, code: 'DEFAULT' },
        }),
      ).toBe(1);
    });

    it.each([
      [{ code: '', name: 'x' }],
      [{ code: 'A B', name: 'x' }],
      [{ code: '-X', name: 'x' }],
      [{ code: 'X'.repeat(21), name: 'x' }],
      [{ code: 'OK1', name: '   ' }],
      [{ code: 'OK1' }],
      [{ code: 'OK1', name: 'x', status: 'INACTIVE' }],
      [{ code: 'OK1', name: 'x', isDefault: true }],
    ])('valida el payload inválido %j con 400', async (payload) => {
      const response = await http()
        .post('/api/v1/warehouses')
        .set('Cookie', adminCookie)
        .send(payload);
      expect(response.status).toBe(400);
    });

    it('PATCH edita solo nombre y descripción', async () => {
      const created = await createWarehouse();
      const response = await http()
        .patch(`/api/v1/warehouses/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ name: ' Nuevo nombre ', description: 'desc' });
      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({
        code: created.code,
        name: 'Nuevo nombre',
        description: 'desc',
        isDefault: false,
        status: 'ACTIVE',
      });
      const cleared = await http()
        .patch(`/api/v1/warehouses/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ description: null });
      expect((cleared.body as WarehouseBody).description).toBeNull();
    });

    it.each(['code', 'status', 'isDefault', 'id'])(
      'PATCH rechaza el campo inmutable %s con 400 y no cambia nada',
      async (field) => {
        const created = await createWarehouse();
        const response = await http()
          .patch(`/api/v1/warehouses/${created.id}`)
          .set('Cookie', adminCookie)
          .send({
            name: 'cambio',
            [field]: field === 'isDefault' ? true : 'X',
          });
        expect(response.status).toBe(400);
        const row = await prisma.warehouse.findUniqueOrThrow({
          where: { id: created.id },
        });
        expect(row.name).toBe('Almacén e2e');
        expect(row.code).toBe(created.code);
      },
    );

    it('PATCH vacío -> 400; inexistente -> 404; id mal formado -> 400', async () => {
      const created = await createWarehouse();
      expect(
        (
          await http()
            .patch(`/api/v1/warehouses/${created.id}`)
            .set('Cookie', adminCookie)
            .send({})
        ).status,
      ).toBe(400);
      expect(
        (
          await http()
            .patch(`/api/v1/warehouses/${NON_EXISTENT_UUID}`)
            .set('Cookie', adminCookie)
            .send({ name: 'x' })
        ).status,
      ).toBe(404);
      expect(
        (
          await http()
            .get('/api/v1/warehouses/no-es-uuid')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(400);
    });

    it('no existe DELETE de almacenes ni de ubicaciones', async () => {
      const created = await createWarehouse();
      expect(
        (
          await http()
            .delete(`/api/v1/warehouses/${created.id}`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(404);
      expect(
        (
          await http()
            .delete(
              `/api/v1/warehouses/${created.id}/locations/${NON_EXISTENT_UUID}`,
            )
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(404);
    });

    it('filtra por estado y búsqueda', async () => {
      const created = await createWarehouse({ name: `Buscable ${RUN}` });
      const response = await http()
        .get(`/api/v1/warehouses?search=${created.code}&status=ACTIVE`)
        .set('Cookie', adminCookie);
      const body = response.body as Paginated<WarehouseBody>;
      expect(body.data.map((row) => row.id)).toEqual([created.id]);
      const inactive = await http()
        .get(`/api/v1/warehouses?search=${created.code}&status=INACTIVE`)
        .set('Cookie', adminCookie);
      expect((inactive.body as Paginated<WarehouseBody>).total).toBe(0);
    });
  });

  // ==========================================================================
  // Ubicaciones
  // ==========================================================================
  describe('ubicaciones', () => {
    it('crea una ubicación ACTIVE no predeterminada en un almacén activo', async () => {
      const warehouse = await createWarehouse();
      const created = await createLocation(warehouse.id, {
        code: ' a-01 ',
        name: ' Pasillo A ',
      });
      expect(created).toMatchObject({
        warehouseId: warehouse.id,
        code: 'A-01',
        name: 'Pasillo A',
        status: 'ACTIVE',
        isDefault: false,
      });
    });

    it('el código es único dentro del almacén pero reutilizable en otro', async () => {
      const a = await createWarehouse();
      const b = await createWarehouse();
      await createLocation(a.id, { code: 'PASILLO-1' });
      for (const variant of ['PASILLO-1', 'pasillo-1', ' pasillo-1 ']) {
        const dup = await http()
          .post(`/api/v1/warehouses/${a.id}/locations`)
          .set('Cookie', adminCookie)
          .send({ code: variant, name: 'dup' });
        expect(dup.status).toBe(409);
      }
      const other = await http()
        .post(`/api/v1/warehouses/${b.id}/locations`)
        .set('Cookie', adminCookie)
        .send({ code: 'PASILLO-1', name: 'ok en otro almacén' });
      expect(other.status).toBe(201);
    });

    it.each(['DEFAULT', 'default', ' Default '])(
      'el código reservado %p responde 409',
      async (code) => {
        const warehouse = await createWarehouse();
        const response = await http()
          .post(`/api/v1/warehouses/${warehouse.id}/locations`)
          .set('Cookie', adminCookie)
          .send({ code, name: 'x' });
        expect(response.status).toBe(409);
        expect(
          await prisma.warehouseLocation.count({
            where: { warehouseId: warehouse.id },
          }),
        ).toBe(1);
      },
    );

    it.each([
      [{ code: '', name: 'x' }],
      [{ code: 'A B', name: 'x' }],
      [{ code: 'X'.repeat(31), name: 'x' }],
      [{ code: 'OK', name: '' }],
      [{ code: 'OK', name: 'x', isDefault: true }],
      [{ code: 'OK', name: 'x', warehouseId: NON_EXISTENT_UUID }],
    ])('valida el payload inválido %j con 400', async (payload) => {
      const response = await http()
        .post(`/api/v1/warehouses/${mainId}/locations`)
        .set('Cookie', adminCookie)
        .send(payload);
      expect(response.status).toBe(400);
    });

    it('almacén inexistente -> 404 en todas las operaciones; sin filas nuevas', async () => {
      const before = await prisma.warehouseLocation.count();
      const responses = await Promise.all([
        http()
          .get(`/api/v1/warehouses/${NON_EXISTENT_UUID}/locations`)
          .set('Cookie', adminCookie),
        http()
          .post(`/api/v1/warehouses/${NON_EXISTENT_UUID}/locations`)
          .set('Cookie', adminCookie)
          .send({ code: 'ZZ', name: 'x' }),
        http()
          .patch(
            `/api/v1/warehouses/${NON_EXISTENT_UUID}/locations/${NON_EXISTENT_UUID}`,
          )
          .set('Cookie', adminCookie)
          .send({ name: 'x' }),
        http()
          .post(
            `/api/v1/warehouses/${NON_EXISTENT_UUID}/locations/${NON_EXISTENT_UUID}/deactivate`,
          )
          .set('Cookie', adminCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
      }
      expect(await prisma.warehouseLocation.count()).toBe(before);
    });

    it('no pueden crearse ubicaciones en un almacén inactivo (409)', async () => {
      const warehouse = await createWarehouse();
      expect(
        (
          await http()
            .post(`/api/v1/warehouses/${warehouse.id}/deactivate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      const response = await http()
        .post(`/api/v1/warehouses/${warehouse.id}/locations`)
        .set('Cookie', adminCookie)
        .send({ code: 'NUEVA', name: 'x' });
      expect(response.status).toBe(409);
      expect(
        await prisma.warehouseLocation.count({
          where: { warehouseId: warehouse.id },
        }),
      ).toBe(1);
    });

    it('PATCH edita solo nombre y descripción; rechaza code/status/isDefault', async () => {
      const warehouse = await createWarehouse();
      const location = await createLocation(warehouse.id);
      const ok = await http()
        .patch(`/api/v1/warehouses/${warehouse.id}/locations/${location.id}`)
        .set('Cookie', adminCookie)
        .send({ name: 'Renombrada', description: 'd' });
      expect(ok.status).toBe(200);
      expect(ok.body).toMatchObject({
        code: location.code,
        name: 'Renombrada',
        description: 'd',
      });
      for (const field of ['code', 'status', 'isDefault']) {
        const bad = await http()
          .patch(`/api/v1/warehouses/${warehouse.id}/locations/${location.id}`)
          .set('Cookie', adminCookie)
          .send({ name: 'x', [field]: field === 'isDefault' ? true : 'ZZ' });
        expect(bad.status).toBe(400);
      }
    });

    it('la ubicación DEFAULT no cambia de código ni se desactiva por separado', async () => {
      const warehouse = await createWarehouse();
      const def = (
        (
          await http()
            .get(`/api/v1/warehouses/${warehouse.id}/locations`)
            .set('Cookie', adminCookie)
        ).body as Paginated<LocationBody>
      ).data[0];
      expect(def.code).toBe('DEFAULT');
      expect(
        (
          await http()
            .patch(`/api/v1/warehouses/${warehouse.id}/locations/${def.id}`)
            .set('Cookie', adminCookie)
            .send({ code: 'OTRO' })
        ).status,
      ).toBe(400);
      const deactivate = await http()
        .post(
          `/api/v1/warehouses/${warehouse.id}/locations/${def.id}/deactivate`,
        )
        .set('Cookie', adminCookie);
      expect(deactivate.status).toBe(409);
      const row = await prisma.warehouseLocation.findUniqueOrThrow({
        where: { id: def.id },
      });
      expect(row).toMatchObject({
        code: 'DEFAULT',
        status: 'ACTIVE',
        isDefault: true,
      });
    });

    it('desactiva y reactiva una ubicación limpia; repetirlo da 409', async () => {
      const warehouse = await createWarehouse();
      const location = await createLocation(warehouse.id);
      const path = `/api/v1/warehouses/${warehouse.id}/locations/${location.id}`;
      expect(
        (await http().post(`${path}/activate`).set('Cookie', adminCookie))
          .status,
      ).toBe(409);
      const off = await http()
        .post(`${path}/deactivate`)
        .set('Cookie', adminCookie);
      expect(off.status).toBe(200);
      expect((off.body as LocationBody).status).toBe('INACTIVE');
      expect(
        (await http().post(`${path}/deactivate`).set('Cookie', adminCookie))
          .status,
      ).toBe(409);
      const on = await http()
        .post(`${path}/activate`)
        .set('Cookie', adminCookie);
      expect(on.status).toBe(200);
      expect((on.body as LocationBody).status).toBe('ACTIVE');
    });

    it('no se activa una ubicación de un almacén inactivo (409)', async () => {
      const warehouse = await createWarehouse();
      const location = await createLocation(warehouse.id);
      const path = `/api/v1/warehouses/${warehouse.id}/locations/${location.id}`;
      await http().post(`${path}/deactivate`).set('Cookie', adminCookie);
      await http()
        .post(`/api/v1/warehouses/${warehouse.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(
        (await http().post(`${path}/activate`).set('Cookie', adminCookie))
          .status,
      ).toBe(409);
    });

    it('no pueden manipularse ubicaciones a través de otro almacén (404, sin cambios)', async () => {
      const a = await createWarehouse();
      const b = await createWarehouse();
      const locationOfB = await createLocation(b.id);
      const viaA = `/api/v1/warehouses/${a.id}/locations/${locationOfB.id}`;

      const responses = await Promise.all([
        http().get(viaA).set('Cookie', adminCookie),
        http().patch(viaA).set('Cookie', adminCookie).send({ name: 'hack' }),
        http().post(`${viaA}/deactivate`).set('Cookie', adminCookie),
        http().post(`${viaA}/activate`).set('Cookie', adminCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
      }
      const row = await prisma.warehouseLocation.findUniqueOrThrow({
        where: { id: locationOfB.id },
      });
      expect(row).toMatchObject({
        warehouseId: b.id,
        name: locationOfB.name,
        status: 'ACTIVE',
      });
      const list = await http()
        .get(`/api/v1/warehouses/${a.id}/locations`)
        .set('Cookie', adminCookie);
      expect(
        (list.body as Paginated<LocationBody>).data.map((row) => row.id),
      ).not.toContain(locationOfB.id);
    });
  });

  // ==========================================================================
  // Desactivación: protecciones
  // ==========================================================================
  describe('desactivación y dependencias', () => {
    it('el almacén principal MAIN no puede desactivarse (409)', async () => {
      const response = await http()
        .post(`/api/v1/warehouses/${mainId}/deactivate`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);
      const main = await prisma.warehouse.findUniqueOrThrow({
        where: { id: mainId },
      });
      expect(main.status).toBe('ACTIVE');
    });

    it('un almacén limpio se desactiva y reactiva; repetirlo da 409', async () => {
      const warehouse = await createWarehouse();
      const path = `/api/v1/warehouses/${warehouse.id}`;
      expect(
        (await http().post(`${path}/activate`).set('Cookie', adminCookie))
          .status,
      ).toBe(409);
      expect(
        (await http().post(`${path}/deactivate`).set('Cookie', adminCookie))
          .status,
      ).toBe(200);
      expect(
        (await http().post(`${path}/deactivate`).set('Cookie', adminCookie))
          .status,
      ).toBe(409);
      const on = await http()
        .post(`${path}/activate`)
        .set('Cookie', adminCookie);
      expect(on.status).toBe(200);
      expect((on.body as WarehouseBody).status).toBe('ACTIVE');
    });

    it('bloquea desactivar ubicación y almacén con un saldo distinto de cero', async () => {
      const warehouse = await createWarehouse();
      const location = await createLocation(warehouse.id);
      const productId = await createProductFixture();
      await setProductLocationBalances(prisma, productId, [
        { locationId: location.id, quantity: '2.000' },
      ]);

      expect(
        (
          await http()
            .post(
              `/api/v1/warehouses/${warehouse.id}/locations/${location.id}/deactivate`,
            )
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(409);
      expect(
        (
          await http()
            .post(`/api/v1/warehouses/${warehouse.id}/deactivate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(409);
      const still = await prisma.warehouse.findUniqueOrThrow({
        where: { id: warehouse.id },
      });
      expect(still.status).toBe('ACTIVE');

      // Un saldo en cero no es stock: deja de bloquear.
      await setProductLocationBalances(prisma, productId, [
        { locationId: location.id, quantity: '0.000' },
      ]);
      expect(
        (
          await http()
            .post(
              `/api/v1/warehouses/${warehouse.id}/locations/${location.id}/deactivate`,
            )
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
    });

    it('bloquea desactivar si algún movimiento referencia la ubicación', async () => {
      const warehouse = await createWarehouse();
      const location = await createLocation(warehouse.id);
      const productId = await createProductFixture('5.000');
      const admin = await prisma.user.findFirstOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      });
      await prisma.inventoryMovement.create({
        data: {
          productId,
          movementType: InventoryMovementType.ENTRY,
          origin: InventoryMovementOrigin.MANUAL,
          quantity: '1.000',
          previousStock: '4.000',
          newStock: '5.000',
          locationId: location.id,
          locationPreviousStock: '0.000',
          locationNewStock: '1.000',
          reason: 'fixture e2e',
          createdByUserId: admin.id,
        },
      });
      expect(
        (
          await http()
            .post(
              `/api/v1/warehouses/${warehouse.id}/locations/${location.id}/deactivate`,
            )
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(409);
      expect(
        (
          await http()
            .post(`/api/v1/warehouses/${warehouse.id}/deactivate`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(409);
    });

    it('creación de ubicación y desactivación del almacén en paralelo: sin errores 5xx y estado coherente', async () => {
      const warehouse = await createWarehouse();
      const [create, deactivate] = await Promise.all([
        http()
          .post(`/api/v1/warehouses/${warehouse.id}/locations`)
          .set('Cookie', adminCookie)
          .send({ code: nextCode('L'), name: 'carrera' }),
        http()
          .post(`/api/v1/warehouses/${warehouse.id}/deactivate`)
          .set('Cookie', adminCookie),
      ]);
      expect([201, 409]).toContain(create.status);
      expect(deactivate.status).toBe(200);
      const row = await prisma.warehouse.findUniqueOrThrow({
        where: { id: warehouse.id },
      });
      expect(row.status).toBe('INACTIVE');
    });
  });

  // ==========================================================================
  // Integridad a nivel de base de datos
  // ==========================================================================
  describe('restricciones de base de datos', () => {
    it('rechaza un segundo almacén predeterminado y un código sin normalizar', async () => {
      await expect(
        prisma.warehouse.create({
          data: { code: nextCode(), name: 'x', isDefault: true },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.warehouse.create({ data: { code: 'minus', name: 'x' } }),
      ).rejects.toThrow();
    });

    it('rechaza ubicaciones huérfanas, una segunda DEFAULT y DEFAULT mal marcada', async () => {
      await expect(
        prisma.warehouseLocation.create({
          data: { warehouseId: NON_EXISTENT_UUID, code: 'ORF', name: 'x' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.warehouseLocation.create({
          data: {
            warehouseId: mainId,
            code: 'OTRA',
            name: 'x',
            isDefault: true,
          },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.warehouseLocation.create({
          data: { warehouseId: mainId, code: 'DEFAULT', name: 'x' },
        }),
      ).rejects.toThrow();
    });

    it('no permite borrar un almacén con ubicaciones ni una ubicación referenciada', async () => {
      await expect(
        prisma.warehouse.delete({ where: { id: mainId } }),
      ).rejects.toThrow();
      const warehouse = await createWarehouse();
      const location = await createLocation(warehouse.id);
      const productId = await createProductFixture();
      await prisma.stockBalance.create({
        data: { productId, locationId: location.id, quantity: '0.000' },
      });
      await expect(
        prisma.warehouseLocation.delete({ where: { id: location.id } }),
      ).rejects.toThrow();
    });

    it('un saldo negativo o duplicado por (producto, ubicación) es imposible', async () => {
      const productId = await createProductFixture();
      await expect(
        prisma.stockBalance.create({
          data: {
            productId,
            locationId: mainDefaultLocationId,
            quantity: '-1.000',
          },
        }),
      ).rejects.toThrow();
      await prisma.stockBalance.create({
        data: { productId, locationId: mainDefaultLocationId, quantity: '0' },
      });
      await expect(
        prisma.stockBalance.create({
          data: { productId, locationId: mainDefaultLocationId, quantity: '0' },
        }),
      ).rejects.toThrow();
    });

    it('las columnas de ubicación del movimiento son todo-o-nada', async () => {
      const productId = await createProductFixture('1.000');
      const admin = await prisma.user.findFirstOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      });
      await expect(
        prisma.inventoryMovement.create({
          data: {
            productId,
            movementType: InventoryMovementType.ENTRY,
            origin: InventoryMovementOrigin.MANUAL,
            quantity: '1.000',
            previousStock: '0.000',
            newStock: '1.000',
            locationId: mainDefaultLocationId,
            reason: 'parcial',
            createdByUserId: admin.id,
          },
        }),
      ).rejects.toThrow();
    });
  });

  // ==========================================================================
  // Auditoría
  // ==========================================================================
  describe('auditoría', () => {
    it('registra cada acción del catálogo con metadatos estructurales y sin secretos', async () => {
      const warehouse = await createWarehouse({
        name: 'Nombre secreto de negocio',
      });
      const location = await createLocation(warehouse.id);
      const base = `/api/v1/warehouses/${warehouse.id}`;
      await http()
        .patch(base)
        .set('Cookie', adminCookie)
        .send({ name: 'Otro nombre de negocio' });
      await http()
        .patch(`${base}/locations/${location.id}`)
        .set('Cookie', adminCookie)
        .send({ description: 'texto libre' });
      await http()
        .post(`${base}/locations/${location.id}/deactivate`)
        .set('Cookie', adminCookie);
      await http()
        .post(`${base}/locations/${location.id}/activate`)
        .set('Cookie', adminCookie);
      await http().post(`${base}/deactivate`).set('Cookie', adminCookie);
      await http().post(`${base}/activate`).set('Cookie', adminCookie);

      const rows = await prisma.auditLog.findMany({
        where: { entityId: { in: [warehouse.id, location.id] } },
      });
      const actions = rows.map((row) => row.action).sort();
      expect(actions).toEqual(
        [
          AuditAction.WAREHOUSE_CREATED,
          AuditAction.WAREHOUSE_UPDATED,
          AuditAction.WAREHOUSE_DEACTIVATED,
          AuditAction.WAREHOUSE_ACTIVATED,
          AuditAction.LOCATION_CREATED,
          AuditAction.LOCATION_UPDATED,
          AuditAction.LOCATION_DEACTIVATED,
          AuditAction.LOCATION_ACTIVATED,
        ].sort(),
      );
      for (const row of rows) {
        assertAuditRowHasNoSecrets(row);
        const serialized = JSON.stringify(row);
        expect(serialized).not.toContain('Nombre secreto de negocio');
        expect(serialized).not.toContain('Otro nombre de negocio');
        expect(serialized).not.toContain('texto libre');
        expect(row.module).toBe('WAREHOUSES');
      }
      const created = rows.find(
        (row) => row.action === String(AuditAction.WAREHOUSE_CREATED),
      );
      expect(created?.metadata).toMatchObject({ code: warehouse.code });
    });

    it('una operación rechazada no genera auditoría de éxito', async () => {
      const before = await prisma.auditLog.count({
        where: { module: 'WAREHOUSES' },
      });
      await http()
        .post(`/api/v1/warehouses/${mainId}/deactivate`)
        .set('Cookie', adminCookie);
      await http()
        .post('/api/v1/warehouses')
        .set('Cookie', cookies.get(RoleName.WAREHOUSE) as string)
        .send({ code: nextCode(), name: 'x' });
      expect(
        await prisma.auditLog.count({ where: { module: 'WAREHOUSES' } }),
      ).toBe(before);
    });
  });

  // ==========================================================================
  // R2-ACT: el inventario opera por ubicación (sobre MAIN/DEFAULT)
  // ==========================================================================
  describe('el inventario por ubicación (R2-ACT)', () => {
    it('crear/editar/desactivar catálogo no cambia cantidades, movimientos ni saldos', async () => {
      await createProductFixture('7.000');
      const before = await inventorySnapshot(prisma);

      const warehouse = await createWarehouse();
      const location = await createLocation(warehouse.id);
      const base = `/api/v1/warehouses/${warehouse.id}`;
      await http()
        .patch(base)
        .set('Cookie', adminCookie)
        .send({ name: 'renombrado' });
      await http()
        .post(`${base}/locations/${location.id}/deactivate`)
        .set('Cookie', adminCookie);
      await http().post(`${base}/deactivate`).set('Cookie', adminCookie);
      await http().post(`${base}/activate`).set('Cookie', adminCookie);

      expect(await inventorySnapshot(prisma)).toBe(before);
    });

    it('las operaciones de inventario registran MAIN/DEFAULT, mantienen el saldo por ubicación y NO cambian el contrato de respuesta', async () => {
      const productId = await createProductFixture();

      const initial = await http()
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId, quantity: '10.000', reason: 'Saldo e2e almacenes' });
      expect(initial.status).toBe(201);
      const entry = await http()
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId, quantity: '5.000', reason: 'Entrada e2e' });
      expect(entry.status).toBe(201);
      const exit = await http()
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId, quantity: '3.000', reason: 'Salida e2e' });
      expect(exit.status).toBe(201);
      const tooMuch = await http()
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId, quantity: '999.000', reason: 'No hay stock' });
      expect(tooMuch.status).toBe(409);

      // D3: la respuesta de movimientos NO expone campos de ubicación.
      for (const response of [initial, entry, exit]) {
        const body = response.body as Record<string, unknown>;
        expect(body).not.toHaveProperty('locationId');
        expect(body).not.toHaveProperty('locationPreviousStock');
        expect(body).not.toHaveProperty('locationNewStock');
      }

      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('12.000');

      const movements = await prisma.inventoryMovement.findMany({
        where: { productId },
        orderBy: { createdAt: 'asc' },
      });
      expect(movements).toHaveLength(3);
      const expected: [string, string][] = [
        ['0.000', '10.000'],
        ['10.000', '15.000'],
        ['15.000', '12.000'],
      ];
      movements.forEach((movement, index) => {
        expect(movement.locationId).toBe(mainDefaultLocationId);
        expect(movement.locationPreviousStock?.toFixed(3)).toBe(
          expected[index][0],
        );
        expect(movement.locationNewStock?.toFixed(3)).toBe(expected[index][1]);
      });

      const balances = await prisma.stockBalance.findMany({
        where: { productId },
      });
      expect(balances).toHaveLength(1);
      expect(balances[0].locationId).toBe(mainDefaultLocationId);
      expect(balances[0].quantity.toFixed(3)).toBe('12.000');

      const stock = await http()
        .get(`/api/v1/inventory/products/${productId}/stock`)
        .set('Cookie', adminCookie);
      expect(stock.status).toBe(200);
    });

    it('la insuficiencia se evalúa POR UBICACIÓN: el consolidado alcanza pero el saldo de MAIN/DEFAULT no → 409, sin escrituras', async () => {
      const productId = await createProductFixture();
      const warehouse = await createWarehouse();
      const other = await createLocation(warehouse.id);
      // Coherente (consolidado 10 = 5 + 5), repartido en dos ubicaciones.
      await setProductLocationBalances(prisma, productId, [
        { locationId: mainDefaultLocationId, quantity: '5.000' },
        { locationId: other.id, quantity: '5.000' },
      ]);

      const tooMuchForLocation = await http()
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId, quantity: '7.000', reason: 'Excede la ubicación' });
      expect(tooMuchForLocation.status).toBe(409);
      expect(
        (
          await prisma.product.findUniqueOrThrow({ where: { id: productId } })
        ).stockCurrent.toFixed(3),
      ).toBe('10.000');

      const fits = await http()
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId, quantity: '5.000', reason: 'Cabe en la ubicación' });
      expect(fits.status).toBe(201);
      const balances = await prisma.stockBalance.findMany({
        where: { productId },
        orderBy: { quantity: 'asc' },
      });
      expect(balances.map((b) => b.quantity.toFixed(3))).toEqual([
        '0.000',
        '5.000',
      ]);
      expect(
        (
          await prisma.product.findUniqueOrThrow({ where: { id: productId } })
        ).stockCurrent.toFixed(3),
      ).toBe('5.000');
    });

    it('una escritura directa que rompe stockCurrent = Σ saldos se rechaza al COMMIT (trigger diferido)', async () => {
      const productId = await createProductFixture('2.000');
      await expect(
        prisma.product.update({
          where: { id: productId },
          data: { stockCurrent: '9.000' },
        }),
      ).rejects.toThrow();
      await expect(
        prisma.stockBalance.updateMany({
          where: { productId },
          data: { quantity: '100.000' },
        }),
      ).rejects.toThrow();
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('2.000');
    });
  });
});
