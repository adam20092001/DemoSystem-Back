import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  PrismaClient,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
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

const SELLER_USERNAME = 'e2e_seller_products';
const SELLER_PASSWORD = 'SellerProducts123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_products';
const WAREHOUSE_PASSWORD = 'WarehouseProducts123';
const MANAGEMENT_USERNAME = 'e2e_management_products';
const MANAGEMENT_PASSWORD = 'ManagementProducts123';
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

interface SafeProductBody {
  id: string;
  sku: string;
  name: string;
  productType: ProductType;
  salePrice: string;
  isInventoryTracked: boolean;
  stockCurrent: string;
  stockMinimum: string;
  status: ProductStatus;
  internalNotes?: string | null;
  specifications?: SafeSpecificationBody[];
}

interface SafeSpecificationBody {
  id: string;
  name: string;
  value: string;
}

describe('Products & Specifications (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  let categoryId: string;
  let unitId: string;
  let inactiveCategoryId: string;
  let inactiveUnitId: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_products@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_products@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_products@demosystem.test',
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

    const category = await prisma.category.upsert({
      where: { code: 'E2E_PRODCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2E_PRODCAT', name: 'Categoría e2e productos' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2E_PRODUNIT' },
      update: { status: UnitStatus.ACTIVE },
      create: {
        code: 'E2E_PRODUNIT',
        name: 'Unidad e2e productos',
        abbreviation: 'epu',
      },
    });
    unitId = unit.id;

    const inactiveCategory = await prisma.category.upsert({
      where: { code: 'E2E_PRODCAT_INACTIVE' },
      update: { status: CategoryStatus.INACTIVE },
      create: {
        code: 'E2E_PRODCAT_INACTIVE',
        name: 'Categoría inactiva e2e productos',
        status: CategoryStatus.INACTIVE,
      },
    });
    inactiveCategoryId = inactiveCategory.id;

    const inactiveUnit = await prisma.unit.upsert({
      where: { code: 'E2E_PU_INACT' },
      update: { status: UnitStatus.INACTIVE },
      create: {
        code: 'E2E_PU_INACT',
        name: 'Unidad inactiva e2e productos',
        abbreviation: 'epi',
        status: UnitStatus.INACTIVE,
      },
    });
    inactiveUnitId = inactiveUnit.id;
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  function baseProductPayload(suffix: number): Record<string, unknown> {
    return {
      sku: `sku-e2e-${suffix}`,
      name: `Producto e2e ${suffix}`,
      productType: ProductType.PRODUCT,
      categoryId,
      unitId,
      salePrice: '19.9',
      isInventoryTracked: true,
      stockMinimum: '5',
    };
  }

  describe('POST /products', () => {
    it('crea el producto correctamente y normaliza el SKU (trim+upper)', async () => {
      const suffix = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));

      expect(response.status).toBe(201);
      const body = response.body as SafeProductBody;
      expect(body.sku).toBe(`SKU-E2E-${suffix}`);
      expect(body.stockCurrent).toBe('0.000');
      expect(body.salePrice).toBe('19.90');
      expect(body.stockMinimum).toBe('5.000');
    });

    it('SKU duplicado responde 409', async () => {
      const suffix = Date.now();
      const payload = baseProductPayload(suffix);
      const first = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(payload);
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({ ...payload, name: 'Otro nombre' });

      expect(second.status).toBe(409);
    });

    it('categoría inexistente responde 404 y categoría inactiva responde 409', async () => {
      const suffix = Date.now();
      const missing = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({ ...baseProductPayload(suffix), categoryId: NON_EXISTENT_UUID });
      expect(missing.status).toBe(404);

      const inactive = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix + 1),
          categoryId: inactiveCategoryId,
        });
      expect(inactive.status).toBe(409);
    });

    it('unidad inexistente responde 404 y unidad inactiva responde 409', async () => {
      const suffix = Date.now();
      const missing = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({ ...baseProductPayload(suffix), unitId: NON_EXISTENT_UUID });
      expect(missing.status).toBe(404);

      const inactive = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({ ...baseProductPayload(suffix + 1), unitId: inactiveUnitId });
      expect(inactive.status).toBe(409);
    });

    it('SERVICE con isInventoryTracked=true responde 400', async () => {
      const suffix = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          productType: ProductType.SERVICE,
          isInventoryTracked: true,
          stockMinimum: '0',
        });

      expect(response.status).toBe(400);
    });

    it('SERVICE con stockMinimum > 0 responde 400', async () => {
      const suffix = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          productType: ProductType.SERVICE,
          isInventoryTracked: false,
          stockMinimum: '2',
        });

      expect(response.status).toBe(400);
    });

    it('enviar stockCurrent en el body responde 400 (whitelist)', async () => {
      const suffix = Date.now();
      const response = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({ ...baseProductPayload(suffix), stockCurrent: '100.000' });

      expect(response.status).toBe(400);
    });
  });

  describe('PATCH /products/:id', () => {
    it('update vacío responde 400', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const id = (created.body as SafeProductBody).id;

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/products/${id}`)
        .set('Cookie', adminCookie)
        .send({});

      expect(response.status).toBe(400);
    });

    it('actualización parcial efectiva (solo name)', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const id = (created.body as SafeProductBody).id;

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/products/${id}`)
        .set('Cookie', adminCookie)
        .send({ name: 'Nombre actualizado' });

      expect(response.status).toBe(200);
      expect((response.body as SafeProductBody & { name: string }).name).toBe(
        'Nombre actualizado',
      );
    });

    it('convertir PRODUCT a SERVICE sin isInventoryTracked=false responde 400', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const id = (created.body as SafeProductBody).id;

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/products/${id}`)
        .set('Cookie', adminCookie)
        .send({ productType: ProductType.SERVICE });

      expect(response.status).toBe(400);
    });

    it('convertir PRODUCT a SERVICE con valores compatibles funciona (200)', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const id = (created.body as SafeProductBody).id;

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/products/${id}`)
        .set('Cookie', adminCookie)
        .send({
          productType: ProductType.SERVICE,
          isInventoryTracked: false,
          stockMinimum: '0',
        });

      expect(response.status).toBe(200);
      expect((response.body as SafeProductBody).productType).toBe(
        ProductType.SERVICE,
      );
    });

    it('un cambio real de precio genera PRODUCT_PRICE_CHANGED; un precio equivalente no', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const id = (created.body as SafeProductBody).id;

      const equivalent = await request(app.getHttpServer())
        .patch(`/api/v1/products/${id}`)
        .set('Cookie', adminCookie)
        .send({ salePrice: '19.90' });
      expect(equivalent.status).toBe(200);

      const noChangeRows = await prisma.auditLog.findMany({
        where: { action: AuditAction.PRODUCT_PRICE_CHANGED, entityId: id },
      });
      expect(noChangeRows).toHaveLength(0);

      const realChange = await request(app.getHttpServer())
        .patch(`/api/v1/products/${id}`)
        .set('Cookie', adminCookie)
        .send({ salePrice: '25.50' });
      expect(realChange.status).toBe(200);

      const changeRows = await prisma.auditLog.findMany({
        where: { action: AuditAction.PRODUCT_PRICE_CHANGED, entityId: id },
      });
      expect(changeRows).toHaveLength(1);
    });
  });

  describe('visibilidad por rol', () => {
    it('SELLER siempre ve solo status=ACTIVE en el listado', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const id = (created.body as SafeProductBody).id;
      await request(app.getHttpServer())
        .post(`/api/v1/products/${id}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ status: ProductStatus.INACTIVE })
        .set('Cookie', sellerCookie);

      expect(response.status).toBe(200);
      const body = response.body as { data: SafeProductBody[] };
      expect(body.data.find((p) => p.id === id)).toBeUndefined();
    });

    it('internalNotes está ausente para SELLER y visible para ADMIN/WAREHOUSE/MANAGEMENT', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          internalNotes: 'Nota interna secreta',
        });
      const id = (created.body as SafeProductBody).id;

      const asSeller = await request(app.getHttpServer())
        .get(`/api/v1/products/${id}`)
        .set('Cookie', sellerCookie);
      expect(asSeller.status).toBe(200);
      expect(asSeller.body).not.toHaveProperty('internalNotes');

      const asAdmin = await request(app.getHttpServer())
        .get(`/api/v1/products/${id}`)
        .set('Cookie', adminCookie);
      const asWarehouse = await request(app.getHttpServer())
        .get(`/api/v1/products/${id}`)
        .set('Cookie', warehouseCookie);
      const asManagement = await request(app.getHttpServer())
        .get(`/api/v1/products/${id}`)
        .set('Cookie', managementCookie);

      expect((asAdmin.body as SafeProductBody).internalNotes).toBe(
        'Nota interna secreta',
      );
      expect((asWarehouse.body as SafeProductBody).internalNotes).toBe(
        'Nota interna secreta',
      );
      expect((asManagement.body as SafeProductBody).internalNotes).toBe(
        'Nota interna secreta',
      );
    });
  });

  describe('activar/desactivar', () => {
    it('activa y desactiva correctamente', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const id = (created.body as SafeProductBody).id;

      const deactivated = await request(app.getHttpServer())
        .post(`/api/v1/products/${id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivated.status).toBe(200);
      expect((deactivated.body as SafeProductBody).status).toBe(
        ProductStatus.INACTIVE,
      );

      const activated = await request(app.getHttpServer())
        .post(`/api/v1/products/${id}/activate`)
        .set('Cookie', adminCookie);
      expect(activated.status).toBe(200);
      expect((activated.body as SafeProductBody).status).toBe(
        ProductStatus.ACTIVE,
      );
    });
  });

  describe('especificaciones técnicas', () => {
    it('crea una especificación correctamente', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const productId = (created.body as SafeProductBody).id;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/specifications`)
        .set('Cookie', adminCookie)
        .send({ name: 'Color', value: 'Rojo' });

      expect(response.status).toBe(201);
      expect((response.body as SafeSpecificationBody).name).toBe('Color');
    });

    it('nombre duplicado (insensible a mayúsculas) responde 409', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const productId = (created.body as SafeProductBody).id;

      await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/specifications`)
        .set('Cookie', adminCookie)
        .send({ name: 'Potencia', value: '750W' });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/specifications`)
        .set('Cookie', adminCookie)
        .send({ name: 'POTENCIA', value: '1000W' });

      expect(response.status).toBe(409);
    });

    it('una especificación de otro producto responde 404', async () => {
      const suffix = Date.now();
      const productA = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const productB = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix + 1));

      const spec = await request(app.getHttpServer())
        .post(
          `/api/v1/products/${(productA.body as SafeProductBody).id}/specifications`,
        )
        .set('Cookie', adminCookie)
        .send({ name: 'Peso', value: '2kg' });
      const specId = (spec.body as SafeSpecificationBody).id;

      const response = await request(app.getHttpServer())
        .patch(
          `/api/v1/products/${(productB.body as SafeProductBody).id}/specifications/${specId}`,
        )
        .set('Cookie', adminCookie)
        .send({ value: 'Otro valor' });

      expect(response.status).toBe(404);
    });

    it('update vacío responde 400', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const productId = (created.body as SafeProductBody).id;
      const spec = await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/specifications`)
        .set('Cookie', adminCookie)
        .send({ name: 'Material', value: 'Acero' });
      const specId = (spec.body as SafeSpecificationBody).id;

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/products/${productId}/specifications/${specId}`)
        .set('Cookie', adminCookie)
        .send({});

      expect(response.status).toBe(400);
    });

    it('elimina físicamente la especificación (204) y no la audita con el value completo', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send(baseProductPayload(suffix));
      const productId = (created.body as SafeProductBody).id;
      const spec = await request(app.getHttpServer())
        .post(`/api/v1/products/${productId}/specifications`)
        .set('Cookie', adminCookie)
        .send({ name: 'Garantía', value: 'Valor secreto de especificación' });
      const specId = (spec.body as SafeSpecificationBody).id;

      const response = await request(app.getHttpServer())
        .delete(`/api/v1/products/${productId}/specifications/${specId}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(204);

      const remaining = await prisma.productSpecification.findUnique({
        where: { id: specId },
      });
      expect(remaining).toBeNull();

      const rows = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PRODUCT_SPECIFICATION_CHANGED,
          entityId: productId,
        },
      });
      expect(rows.length).toBeGreaterThan(0);
      for (const row of rows) {
        assertAuditRowHasNoSecrets(row);
        expect(JSON.stringify(row.metadata)).not.toContain(
          'Valor secreto de especificación',
        );
      }
    });
  });

  // ==================================================================
  // Fase 9, Bloque A (R6) — GET /products: brand / lowStockOnly
  // ==================================================================
  describe('GET /products — brand / lowStockOnly (Fase 9, R6)', () => {
    it('brand: omitido no filtra; con valor filtra insensible a mayúsculas; recorta espacios; en blanco -> 400', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          brand: `MarcaR6-${suffix}`,
        });
      expect(created.status).toBe(201);
      const id = (created.body as SafeProductBody).id;

      const byBrand = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ brand: `marcar6-${suffix}`.toUpperCase() })
        .set('Cookie', adminCookie);
      expect(byBrand.status).toBe(200);
      expect(
        (byBrand.body as { data: SafeProductBody[] }).data.some(
          (p) => p.id === id,
        ),
      ).toBe(true);

      const trimmed = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ brand: `  MarcaR6-${suffix}  ` })
        .set('Cookie', adminCookie);
      expect(
        (trimmed.body as { data: SafeProductBody[] }).data.some(
          (p) => p.id === id,
        ),
      ).toBe(true);

      const blank = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ brand: '   ' })
        .set('Cookie', adminCookie);
      expect(blank.status).toBe(400);
    });

    it('lowStockOnly: omitido/false preservan el comportamiento existente; true filtra tracked+stockCurrent<=stockMinimum en BD', async () => {
      const suffix = Date.now();
      // stockCurrent nace en 0.000 (Fase 2/3): con stockMinimum=5, ya es
      // elegible como stock bajo sin necesitar un movimiento de inventario.
      const belowMinimum = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          sku: `sku-e2e-r6-below-${suffix}`,
          stockMinimum: '5',
        });
      expect(belowMinimum.status).toBe(201);
      const belowId = (belowMinimum.body as SafeProductBody).id;

      // stockCurrent nace en 0.000, así que incluso con stockMinimum='0'
      // seguiría calificando como stock bajo (0 <= 0, misma regla exacta
      // de GET /inventory/low-stock). Para un caso genuino "NO stock
      // bajo" hace falta stockCurrent > stockMinimum vía un movimiento
      // real de inventario.
      const aboveMinimum = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          sku: `sku-e2e-r6-above-${suffix}`,
          stockMinimum: '0',
        });
      expect(aboveMinimum.status).toBe(201);
      const aboveId = (aboveMinimum.body as SafeProductBody).id;
      const initialBalance = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: aboveId,
          quantity: '5.000',
          reason: 'Saldo Fase 9 R6 (no stock bajo)',
        });
      expect(initialBalance.status).toBe(201);

      const notTracked = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          sku: `sku-e2e-r6-nottracked-${suffix}`,
          isInventoryTracked: false,
          stockMinimum: '0',
        });
      expect(notTracked.status).toBe(201);
      const notTrackedId = (notTracked.body as SafeProductBody).id;

      // El catálogo de este archivo E2E se acumula entre ejecuciones (sin
      // limpieza, misma convención ya establecida aquí): se filtra con
      // `search` por el sufijo único de esta prueba para no depender de
      // que las 3 filas propias entren en un `limit` fijo del catálogo
      // completo.
      const omitted = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ categoryId, unitId, search: String(suffix) })
        .set('Cookie', adminCookie);
      expect(omitted.status).toBe(200);
      const omittedIds = (omitted.body as { data: SafeProductBody[] }).data.map(
        (p) => p.id,
      );
      expect(omittedIds).toContain(belowId);
      expect(omittedIds).toContain(aboveId);
      expect(omittedIds).toContain(notTrackedId);

      const explicitFalse = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({
          categoryId,
          unitId,
          search: String(suffix),
          lowStockOnly: 'false',
        })
        .set('Cookie', adminCookie);
      const falseIds = (
        explicitFalse.body as { data: SafeProductBody[] }
      ).data.map((p) => p.id);
      expect(falseIds.sort()).toEqual(omittedIds.sort());

      const lowStockOnly = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({
          categoryId,
          unitId,
          search: String(suffix),
          lowStockOnly: 'true',
        })
        .set('Cookie', adminCookie);
      expect(lowStockOnly.status).toBe(200);
      const lowStockIds = (
        lowStockOnly.body as { data: SafeProductBody[] }
      ).data.map((p) => p.id);
      expect(lowStockIds).toContain(belowId);
      expect(lowStockIds).not.toContain(aboveId);
      expect(lowStockIds).not.toContain(notTrackedId);
    });

    it('lowStockOnly=true + isInventoryTracked=false -> 400 (combinación contradictoria)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ lowStockOnly: 'true', isInventoryTracked: 'false' })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(400);
    });

    it('lowStockOnly=true + isInventoryTracked=true: combinación válida, mismo resultado que solo lowStockOnly=true', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          sku: `sku-e2e-r6-combo-${suffix}`,
          stockMinimum: '5',
        });
      const id = (created.body as SafeProductBody).id;

      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({
          categoryId,
          unitId,
          search: String(suffix),
          lowStockOnly: 'true',
          isInventoryTracked: 'true',
        })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(
        (response.body as { data: SafeProductBody[] }).data.some(
          (p) => p.id === id,
        ),
      ).toBe(true);
    });

    it('lowStockOnly=true respeta paginación/orden existentes (name ASC, sku ASC) sin filtrar en memoria', async () => {
      const suffix = Date.now();
      const first = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          sku: `sku-e2e-r6-order-a-${suffix}`,
          name: `Aardvark R6 ${suffix}`,
          stockMinimum: '5',
        });
      const second = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({
          ...baseProductPayload(suffix),
          sku: `sku-e2e-r6-order-b-${suffix}`,
          name: `Bardvark R6 ${suffix}`,
          stockMinimum: '5',
        });
      const firstId = (first.body as SafeProductBody).id;
      const secondId = (second.body as SafeProductBody).id;

      const response = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({
          categoryId,
          unitId,
          lowStockOnly: 'true',
          search: `r6 ${suffix}`,
          page: 1,
          limit: 1,
        })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as {
        data: SafeProductBody[];
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(firstId);
      expect(body.total).toBe(2);
      expect(body.totalPages).toBe(2);

      const secondPage = await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({
          categoryId,
          unitId,
          lowStockOnly: 'true',
          search: `r6 ${suffix}`,
          page: 2,
          limit: 1,
        })
        .set('Cookie', adminCookie);
      expect((secondPage.body as { data: SafeProductBody[] }).data[0].id).toBe(
        secondId,
      );
    });

    it('no crea AuditLog ni muta Product (lectura pura)', async () => {
      const suffix = Date.now();
      const created = await request(app.getHttpServer())
        .post('/api/v1/products')
        .set('Cookie', adminCookie)
        .send({ ...baseProductPayload(suffix), stockMinimum: '5' });
      const id = (created.body as SafeProductBody).id;
      const before = await prisma.product.findUniqueOrThrow({
        where: { id },
      });
      const auditBefore = await prisma.auditLog.count();

      await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ brand: 'x', lowStockOnly: 'true' })
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get('/api/v1/products')
        .query({ lowStockOnly: 'false' })
        .set('Cookie', adminCookie);

      const after = await prisma.product.findUniqueOrThrow({ where: { id } });
      const auditAfter = await prisma.auditLog.count();
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.stockCurrent.toString()).toBe(
        before.stockCurrent.toString(),
      );
      expect(auditAfter).toBe(auditBefore);
    });
  });
});
