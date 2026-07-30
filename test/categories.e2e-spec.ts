import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  PrismaClient,
  ProductType,
  RoleName,
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

const SELLER_USERNAME = 'e2e_seller_categories';
const SELLER_PASSWORD = 'SellerCategories123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_categories';
const WAREHOUSE_PASSWORD = 'WarehouseCategories123';
const MANAGEMENT_USERNAME = 'e2e_management_categories';
const MANAGEMENT_PASSWORD = 'ManagementCategories123';
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

interface SafeCategoryBody {
  id: string;
  code: string;
  name: string;
  description: string | null;
  parentId: string | null;
  status: CategoryStatus;
  sortOrder: number;
}

describe('Categories (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_categories@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_categories@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_categories@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });

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

    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('autorización', () => {
    it('sin cookie responde 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/categories',
      );
      expect(response.status).toBe(401);
    });

    it('SELLER no puede crear (403)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', sellerCookie)
        .send({ code: `NOPE_${Date.now()}`, name: 'No debería crearse' });

      expect(response.status).toBe(403);
    });
  });

  describe('POST /categories', () => {
    it('ADMIN crea una categoría raíz y normaliza code (trim+upper)', async () => {
      const suffix = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `  cat_raiz_${suffix}  `,
          name: `Categoria Raiz ${suffix}`,
        });

      expect(response.status).toBe(201);
      const body = response.body as SafeCategoryBody;
      expect(body.code).toBe(`CAT_RAIZ_${suffix}`);
      expect(body.status).toBe(CategoryStatus.ACTIVE);
      expect(body.parentId).toBeNull();

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.CATEGORY_CREATED, entityId: body.id },
      });
      expect(rows).toHaveLength(1);
    });

    it('code duplicado responde 409', async () => {
      const suffix = Date.now();
      const code = `CAT_DUP_${suffix}`;
      const first = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code, name: `Primera ${suffix}` });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code, name: `Segunda ${suffix}` });

      expect(second.status).toBe(409);
    });

    it('nombre duplicado en la raíz (insensible a mayúsculas) responde 409', async () => {
      const suffix = Date.now();
      const name = `Nombre Raiz Duplicado ${suffix}`;
      const first = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code: `CAT_A_${suffix}`, name });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code: `CAT_B_${suffix}`, name: name.toUpperCase() });

      expect(second.status).toBe(409);
    });

    it('nombre duplicado dentro del mismo padre responde 409, pero el mismo nombre en padres distintos se permite', async () => {
      const suffix = Date.now();
      const parentA = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code: `PARENT_A_${suffix}`, name: `Padre A ${suffix}` });
      const parentB = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code: `PARENT_B_${suffix}`, name: `Padre B ${suffix}` });
      expect(parentA.status).toBe(201);
      expect(parentB.status).toBe(201);

      const childName = `Hijo Compartido ${suffix}`;
      const firstChild = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `CHILD_A_${suffix}`,
          name: childName,
          parentId: (parentA.body as SafeCategoryBody).id,
        });
      expect(firstChild.status).toBe(201);

      const duplicateChild = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `CHILD_A2_${suffix}`,
          name: childName,
          parentId: (parentA.body as SafeCategoryBody).id,
        });
      expect(duplicateChild.status).toBe(409);

      const childInOtherParent = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `CHILD_B_${suffix}`,
          name: childName,
          parentId: (parentB.body as SafeCategoryBody).id,
        });
      expect(childInOtherParent.status).toBe(201);
    });

    it('parentId inexistente responde 404', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `CAT_NOPARENT_${Date.now()}`,
          name: 'Sin padre válido',
          parentId: NON_EXISTENT_UUID,
        });

      expect(response.status).toBe(404);
    });

    it('parentId INACTIVE responde 409', async () => {
      const suffix = Date.now();
      const parent = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `INACTIVE_PARENT_${suffix}`,
          name: `Padre inactivo ${suffix}`,
        });
      const parentId = (parent.body as SafeCategoryBody).id;

      const deactivated = await request(app.getHttpServer())
        .post(`/api/v1/categories/${parentId}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivated.status).toBe(200);

      const response = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code: `CHILD_INACT_${suffix}`, name: 'Hijo', parentId });

      expect(response.status).toBe(409);
    });
  });

  describe('PATCH /categories/:id', () => {
    it('auto-padre responde 400', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code: `SELF_PARENT_${suffix}`, name: `Auto padre ${suffix}` });
      const id = (created.body as SafeCategoryBody).id;

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/categories/${id}`)
        .set('Cookie', adminCookie)
        .send({ parentId: id });

      expect(response.status).toBe(400);
    });

    it('ciclo indirecto responde 400', async () => {
      const suffix = Date.now();
      const root = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({ code: `CYCLE_ROOT_${suffix}`, name: `Ciclo raíz ${suffix}` });
      const rootId = (root.body as SafeCategoryBody).id;

      const child = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `CYCLE_CHILD_${suffix}`,
          name: `Ciclo hijo ${suffix}`,
          parentId: rootId,
        });
      const childId = (child.body as SafeCategoryBody).id;

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/categories/${rootId}`)
        .set('Cookie', adminCookie)
        .send({ parentId: childId });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /categories', () => {
    it('devuelve un listado paginado', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      const body = response.body as {
        data: unknown[];
        page: number;
        limit: number;
      };
      expect(Array.isArray(body.data)).toBe(true);
      expect(typeof body.page).toBe('number');
      expect(typeof body.limit).toBe('number');
    });

    it('SELLER siempre ve solo ACTIVE aunque pida status=INACTIVE', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `SELLER_FILTER_${suffix}`,
          name: `Filtro seller ${suffix}`,
        });
      const id = (created.body as SafeCategoryBody).id;
      await request(app.getHttpServer())
        .post(`/api/v1/categories/${id}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get('/api/v1/categories')
        .query({ status: CategoryStatus.INACTIVE })
        .set('Cookie', sellerCookie);

      expect(response.status).toBe(200);
      const body = response.body as { data: SafeCategoryBody[] };
      expect(body.data.find((c) => c.id === id)).toBeUndefined();
    });
  });

  describe('GET /categories/:id', () => {
    it('SELLER recibe 404 para una categoría INACTIVE', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `SELLER_HIDDEN_${suffix}`,
          name: `Oculta a seller ${suffix}`,
        });
      const id = (created.body as SafeCategoryBody).id;
      await request(app.getHttpServer())
        .post(`/api/v1/categories/${id}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get(`/api/v1/categories/${id}`)
        .set('Cookie', sellerCookie);

      expect(response.status).toBe(404);
    });

    it.each([
      ['WAREHOUSE', () => warehouseCookie],
      ['MANAGEMENT', () => managementCookie],
    ])(
      '%s sí puede consultar una categoría INACTIVE',
      async (_label, getCookie) => {
        const suffix = Date.now();
        const created = await request(app.getHttpServer())
          .post('/api/v1/categories')
          .set('Cookie', adminCookie)
          .send({ code: `ROLE_VISIBLE_${suffix}`, name: `Visible ${suffix}` });
        const id = (created.body as SafeCategoryBody).id;
        await request(app.getHttpServer())
          .post(`/api/v1/categories/${id}/deactivate`)
          .set('Cookie', adminCookie);

        const response = await request(app.getHttpServer())
          .get(`/api/v1/categories/${id}`)
          .set('Cookie', getCookie());

        expect(response.status).toBe(200);
        expect((response.body as SafeCategoryBody).status).toBe(
          CategoryStatus.INACTIVE,
        );
      },
    );
  });

  describe('desactivación bloqueada por dependientes', () => {
    it('bloquea la desactivación si existe una subcategoría ACTIVE', async () => {
      const suffix = Date.now();
      const parent = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `BLOCK_PARENT_${suffix}`,
          name: `Bloqueo padre ${suffix}`,
        });
      const parentId = (parent.body as SafeCategoryBody).id;
      await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `BLOCK_CHILD_${suffix}`,
          name: `Bloqueo hijo ${suffix}`,
          parentId,
        });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/categories/${parentId}/deactivate`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(409);
    });

    it('bloquea la desactivación si existe un producto ACTIVE en la categoría', async () => {
      const suffix = Date.now();
      const category = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `PRODCAT_${suffix}`,
          name: `Categoria con producto ${suffix}`,
        });
      const categoryId = (category.body as SafeCategoryBody).id;

      const unit = await prisma.unit.upsert({
        where: { code: 'E2E_CATUNIT' },
        update: {},
        create: {
          code: 'E2E_CATUNIT',
          name: 'Unidad e2e categorías',
          abbreviation: 'ecu',
        },
      });

      const product = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          sku: `SKU_CAT_${suffix}`,
          name: `Producto categoría ${suffix}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unit.id,
          salePrice: '10.00',
          isInventoryTracked: true,
        });
      expect(product.status).toBe(201);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/categories/${categoryId}/deactivate`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(409);
    });
  });

  describe('auditoría', () => {
    it('CATEGORY_CREATED no contiene el payload completo ni secretos', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/categories')
        .set('Cookie', adminCookie)
        .send({
          code: `AUDIT_${suffix}`,
          name: `Auditoría ${suffix}`,
          description: 'Descripción larga que no debe auditarse completa',
        });
      const id = (created.body as SafeCategoryBody).id;

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.CATEGORY_CREATED, entityId: id },
      });
      expect(rows).toHaveLength(1);
      assertAuditRowHasNoSecrets(rows[0]);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('description');
    });
  });
});
