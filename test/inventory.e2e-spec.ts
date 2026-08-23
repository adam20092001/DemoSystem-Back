import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  InventoryMovementOrigin,
  InventoryMovementType,
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

const WAREHOUSE_USERNAME = 'e2e_warehouse_inventory';
const WAREHOUSE_PASSWORD = 'WarehouseInventory123';
const MANAGEMENT_USERNAME = 'e2e_management_inventory';
const MANAGEMENT_PASSWORD = 'ManagementInventory123';
const SELLER_USERNAME = 'e2e_seller_inventory';
const SELLER_PASSWORD = 'SellerInventory123';
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const SKU_PREFIX = 'INV-E2E-';
const MAX_STOCK_VALUE = '99999999999.999';

interface SafeMovementBody {
  id: string;
  product: { id: string; sku: string; name: string };
  movementType: InventoryMovementType;
  origin: InventoryMovementOrigin;
  quantity: string;
  previousStock: string;
  newStock: string;
  reason: string;
  notes: string | null;
  createdBy: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
  };
  createdAt: string;
}

interface SafeProductBody {
  id: string;
  sku: string;
  name: string;
  status: ProductStatus;
  stockCurrent: string;
}

interface SafeProductStockBody {
  productId: string;
  sku: string;
  name: string;
  stockCurrent: string;
  stockMinimum: string;
  unitAbbreviation: string;
  allowDecimal: boolean;
}

interface PaginatedBody<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

describe('Inventory (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let adminId: string;
  let categoryId: string;
  let unitId: string;
  let noDecimalUnitId: string;
  const createdProductIds: string[] = [];
  let productCounter = 0;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_inventory@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_inventory@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_inventory@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
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
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;

    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
    });
    adminId = adminUser.id;

    const category = await prisma.category.upsert({
      where: { code: 'E2E_INVCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2E_INVCAT', name: 'Categoria e2e inventario' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2EINVUNIT' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2EINVUNIT',
        name: 'Unidad e2e inventario',
        abbreviation: 'eiu',
        allowDecimal: true,
      },
    });
    unitId = unit.id;

    const ndUnit = await prisma.unit.upsert({
      where: { code: 'E2EINVND' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2EINVND',
        name: 'Unidad e2e sin decimales',
        abbreviation: 'eind',
        allowDecimal: false,
      },
    });
    noDecimalUnitId = ndUnit.id;
  });

  afterAll(async () => {
    if (createdProductIds.length > 0) {
      // AuditLog no tiene FK hacia InventoryMovement/Product (entityId es un
      // string libre, por diseño, igual que en todo el resto del dominio de
      // auditoría): borrar el movimiento/producto no arrastra su auditoría.
      // Se recolectan los IDs de movimiento ANTES de borrarlos para eliminar
      // únicamente las auditorías que le pertenecen a este spec, nunca con
      // un deleteMany global de todas las auditorías INVENTORY_*/PRODUCT_*.
      const movementIds = (
        await prisma.inventoryMovement.findMany({
          where: { productId: { in: createdProductIds } },
          select: { id: true },
        })
      ).map((movement) => movement.id);

      if (movementIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'InventoryMovement',
            entityId: { in: movementIds },
          },
        });
      }
      await prisma.auditLog.deleteMany({
        where: {
          entityType: 'Product',
          entityId: { in: createdProductIds },
        },
      });

      await prisma.inventoryMovement.deleteMany({
        where: { productId: { in: createdProductIds } },
      });
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
    }
    await app.close();
    await prisma.$disconnect();
  });

  function nextSku(): string {
    productCounter += 1;
    return `${SKU_PREFIX}${Date.now()}-${productCounter}`;
  }

  async function createProduct(
    overrides: Record<string, unknown> = {},
  ): Promise<SafeProductBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: nextSku(),
        name: `Producto e2e inventario ${productCounter}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '10.00',
        isInventoryTracked: true,
        ...overrides,
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el producto fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeProductBody;
    createdProductIds.push(body.id);
    return body;
  }

  /**
   * Orden real createdAt DESC, id DESC (mismo contrato que el servicio),
   * calculado desde los timestamps reales en PostgreSQL en vez de asumir el
   * orden de creación: si dos movimientos comparten el mismo milisegundo, el
   * desempate por id DESC puede alterar cuál aparece primero.
   */
  async function expectedMovementOrder(ids: string[]): Promise<string[]> {
    const rows = await prisma.inventoryMovement.findMany({
      where: { id: { in: ids } },
      select: { id: true, createdAt: true },
    });
    return [...rows]
      .sort((a, b) => {
        const diff = b.createdAt.getTime() - a.createdAt.getTime();
        if (diff !== 0) {
          return diff;
        }
        return a.id > b.id ? -1 : 1;
      })
      .map((row) => row.id);
  }

  async function getAuditRow(
    action: AuditAction,
    movementId: string,
  ): Promise<{ metadata: unknown; description: string }> {
    const rows = await prisma.auditLog.findMany({
      where: { action, entityType: 'InventoryMovement', entityId: movementId },
    });
    expect(rows).toHaveLength(1);
    return rows[0];
  }

  /**
   * Inserta directamente en inventory_movements (bypass total del motor) para
   * verificar que PostgreSQL rechaza la fila mediante el CHECK/índice
   * indicado. No se acopla al texto completo del error: solo al SQLSTATE
   * (23514 = check_violation, 23505 = unique_violation), estable entre
   * versiones de Postgres/Prisma.
   */
  async function expectPgRejection(
    insert: () => Promise<unknown>,
    sqlstate: '23514' | '23505',
  ): Promise<void> {
    let caught = false;
    try {
      await insert();
    } catch (error) {
      caught = true;
      const pgError = error as { code?: string; meta?: { code?: string } };
      expect(pgError.code).toBe('P2010');
      expect(pgError.meta?.code).toBe(sqlstate);
    }
    expect(caught).toBe(true);
  }

  // ============================================================
  // 7. Rutas existentes / inexistentes
  // ============================================================
  describe('rutas', () => {
    it('no existen PATCH ni DELETE de InventoryMovement', async () => {
      const created = await createProduct();
      const initial = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: created.id, quantity: '1.000', reason: 'Saldo' });
      const movementId = (initial.body as SafeMovementBody).id;

      const patchResponse = await request(app.getHttpServer())
        .patch(`/api/v1/inventory/movements/${movementId}`)
        .set('Cookie', adminCookie)
        .send({ quantity: '999.000' });
      expect(patchResponse.status).toBe(404);

      const deleteResponse = await request(app.getHttpServer())
        .delete(`/api/v1/inventory/movements/${movementId}`)
        .set('Cookie', adminCookie);
      expect(deleteResponse.status).toBe(404);

      const stillThere = await prisma.inventoryMovement.findUnique({
        where: { id: movementId },
      });
      expect(stillThere).not.toBeNull();
      expect(stillThere?.quantity.toFixed(3)).toBe('1.000');
    });
  });

  // ============================================================
  // 8. Autenticación y autorización (HTTP real)
  // ============================================================
  describe('autenticación y autorización', () => {
    it('sin cookie: escritura, kardex, stock y low-stock responden 401', async () => {
      const writeResponse = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .send({ productId: NON_EXISTENT_UUID, quantity: '1.000', reason: 'x' });
      expect(writeResponse.status).toBe(401);

      const movementsResponse = await request(app.getHttpServer()).get(
        '/api/v1/inventory/movements',
      );
      expect(movementsResponse.status).toBe(401);

      const stockResponse = await request(app.getHttpServer()).get(
        `/api/v1/inventory/products/${NON_EXISTENT_UUID}/stock`,
      );
      expect(stockResponse.status).toBe(401);

      const lowStockResponse = await request(app.getHttpServer()).get(
        '/api/v1/inventory/low-stock',
      );
      expect(lowStockResponse.status).toBe(401);
    });

    it('ADMIN puede escribir, consultar movimientos, stock y low-stock', async () => {
      const product = await createProduct();
      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'ADMIN entry',
        });
      expect(write.status).toBe(201);

      const movements = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', adminCookie);
      expect(movements.status).toBe(200);

      const stock = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', adminCookie);
      expect(stock.status).toBe(200);

      const lowStock = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', adminCookie);
      expect(lowStock.status).toBe(200);
    });

    it('WAREHOUSE puede escribir, consultar movimientos, stock y low-stock', async () => {
      const product = await createProduct();
      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', warehouseCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'WAREHOUSE entry',
        });
      expect(write.status).toBe(201);

      const movements = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', warehouseCookie);
      expect(movements.status).toBe(200);

      const stock = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', warehouseCookie);
      expect(stock.status).toBe(200);

      const lowStock = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', warehouseCookie);
      expect(lowStock.status).toBe(200);
    });

    it('MANAGEMENT no puede escribir (403) pero sí consultar movimientos, stock y low-stock', async () => {
      const product = await createProduct();
      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', managementCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'MANAGEMENT entry',
        });
      expect(write.status).toBe(403);

      const movements = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', managementCookie);
      expect(movements.status).toBe(200);

      const stock = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', managementCookie);
      expect(stock.status).toBe(200);

      const lowStock = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', managementCookie);
      expect(lowStock.status).toBe(200);
    });

    it('SELLER no puede escribir ni consultar kardex/low-stock (403), pero sí stock operativo (200)', async () => {
      const product = await createProduct();

      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', sellerCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'SELLER entry',
        });
      expect(write.status).toBe(403);

      const movements = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .set('Cookie', sellerCookie);
      expect(movements.status).toBe(403);

      const movementByIdResponse = await request(app.getHttpServer())
        .get(`/api/v1/inventory/movements/${NON_EXISTENT_UUID}`)
        .set('Cookie', sellerCookie);
      expect(movementByIdResponse.status).toBe(403);

      const productMovements = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/movements`)
        .set('Cookie', sellerCookie);
      expect(productMovements.status).toBe(403);

      const lowStock = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', sellerCookie);
      expect(lowStock.status).toBe(403);

      const stock = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', sellerCookie);
      expect(stock.status).toBe(200);
    });
  });

  // ============================================================
  // 9. Validación HTTP y whitelist
  // ============================================================
  describe('validación HTTP y whitelist', () => {
    it('productId inválido → 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: 'not-a-uuid', quantity: '1.000', reason: 'x' });
      expect(response.status).toBe(400);
    });

    it('quantity no string → 400', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: 1, reason: 'x' });
      expect(response.status).toBe(400);
    });

    it('quantity negativa → 400', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '-1.000', reason: 'x' });
      expect(response.status).toBe(400);
    });

    it('quantity en notación científica → 400', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1e3', reason: 'x' });
      expect(response.status).toBe(400);
    });

    it('más de 3 decimales → 400', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.2345', reason: 'x' });
      expect(response.status).toBe(400);
    });

    it('más de 11 dígitos enteros → 400', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '123456789012',
          reason: 'x',
        });
      expect(response.status).toBe(400);
    });

    it('quantity = "0" → 400 por el motor (no por el patrón del DTO), sin escritura', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '0', reason: 'x' });
      expect(response.status).toBe(400);

      const movementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movementCount).toBe(0);
    });

    it('reason vacío → 400', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.000', reason: '' });
      expect(response.status).toBe(400);
    });

    it('reason solo espacios → 400 (normalizado por el motor)', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.000', reason: '   ' });
      expect(response.status).toBe(400);
    });

    it('notes mayor de 500 caracteres → 400', async () => {
      const product = await createProduct();
      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'x',
          notes: 'a'.repeat(501),
        });
      expect(response.status).toBe(400);
    });

    it('el cliente no puede elegir movementType/origin/previousStock/createdByUserId (whitelist)', async () => {
      const product = await createProduct();

      const withMovementType = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'x',
          movementType: InventoryMovementType.EXIT,
        });
      expect(withMovementType.status).toBe(400);

      const withOrigin = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'x',
          origin: InventoryMovementOrigin.SALE,
        });
      expect(withOrigin.status).toBe(400);

      const withPreviousStock = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'x',
          previousStock: '999.000',
        });
      expect(withPreviousStock.status).toBe(400);

      const withCreatedByUserId = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'x',
          createdByUserId: NON_EXISTENT_UUID,
        });
      expect(withCreatedByUserId.status).toBe(400);

      const movementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movementCount).toBe(0);
    });
  });

  // ============================================================
  // 10. Saldo inicial
  // ============================================================
  describe('saldo inicial', () => {
    it('registra el saldo inicial correctamente y lo persiste en PostgreSQL', async () => {
      const product = await createProduct();

      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '10.000',
          reason: '  Saldo inicial de apertura  ',
          notes: '  nota inicial  ',
        });

      expect(response.status).toBe(201);
      const body = response.body as SafeMovementBody;
      expect(body.movementType).toBe(InventoryMovementType.ENTRY);
      expect(body.origin).toBe(InventoryMovementOrigin.INITIAL_BALANCE);
      expect(body.previousStock).toBe('0.000');
      expect(body.newStock).toBe('10.000');
      expect(body.quantity).toBe('10.000');
      expect(body.reason).toBe('Saldo inicial de apertura');
      expect(body.notes).toBe('nota inicial');

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('10.000');

      const movements = await prisma.inventoryMovement.findMany({
        where: { productId: product.id },
      });
      expect(movements).toHaveLength(1);
      const movement = movements[0];
      expect(movement.origin).toBe(InventoryMovementOrigin.INITIAL_BALANCE);
      expect(movement.previousStock.toFixed(3)).toBe('0.000');
      expect(movement.newStock.toFixed(3)).toBe('10.000');
      expect(movement.createdByUserId).toBe(adminId);
      expect(movement.referenceType).toBeNull();
      expect(movement.referenceId).toBeNull();
    });

    it('un segundo saldo inicial para el mismo producto responde 409 sin alterar nada', async () => {
      const product = await createProduct();
      const first = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '5.000', reason: 'Primero' });
      expect(first.status).toBe(201);

      const second = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '3.000', reason: 'Segundo' });
      expect(second.status).toBe(409);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('5.000');

      const movements = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movements).toBe(1);
    });

    it('saldo inicial con stockCurrent ya distinto de cero responde 409 sin escritura parcial', async () => {
      const product = await createProduct();
      const entry = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '4.000',
          reason: 'Entrada previa',
        });
      expect(entry.status).toBe(201);

      const initialBalance = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'Saldo tardío',
        });
      expect(initialBalance.status).toBe(409);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('4.000');

      const movements = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movements).toBe(1);
    });

    it('saldo inicial con un movimiento previo responde 409 aunque el stock haya vuelto a cero', async () => {
      const product = await createProduct();
      const entry = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '4.000', reason: 'Entrada' });
      expect(entry.status).toBe(201);

      const exit = await request(app.getHttpServer())
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '4.000', reason: 'Salida' });
      expect(exit.status).toBe(201);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('0.000');

      const initialBalance = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'Saldo tras movimientos',
        });
      expect(initialBalance.status).toBe(409);

      const movements = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movements).toBe(2);
    });
  });

  // ============================================================
  // 11. Entradas, salidas y ajustes + auditoría
  // ============================================================
  describe('entradas, salidas y ajustes', () => {
    it('flujo completo: entrada, salida, ajuste positivo y ajuste negativo, con auditoría exacta', async () => {
      const product = await createProduct();

      const initial = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '10.000', reason: 'Saldo' });
      expect(initial.status).toBe(201);
      const initialBody = initial.body as SafeMovementBody;
      const initialAudit = await getAuditRow(
        AuditAction.INVENTORY_INITIAL_BALANCE_CREATED,
        initialBody.id,
      );
      assertAuditRowHasNoSecrets(initialAudit);
      const initialMetadata = initialAudit.metadata as Record<string, unknown>;
      expect(Object.keys(initialMetadata).sort()).toEqual(
        [
          'movementId',
          'productId',
          'quantity',
          'previousStock',
          'newStock',
          'movementType',
          'origin',
        ].sort(),
      );
      expect(initialMetadata.previousStock).toBe('0.000');
      expect(initialMetadata.newStock).toBe('10.000');

      const entry = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', warehouseCookie)
        .send({
          productId: product.id,
          quantity: '5.000',
          reason: '  Compra a proveedor  ',
          notes: '  factura 123  ',
        });
      expect(entry.status).toBe(201);
      const entryBody = entry.body as SafeMovementBody;
      expect(entryBody.movementType).toBe(InventoryMovementType.ENTRY);
      expect(entryBody.origin).toBe(InventoryMovementOrigin.MANUAL);
      expect(entryBody.previousStock).toBe('10.000');
      expect(entryBody.newStock).toBe('15.000');
      expect(entryBody.reason).toBe('Compra a proveedor');
      expect(entryBody.notes).toBe('factura 123');
      const warehouseUser = await prisma.user.findUniqueOrThrow({
        where: { username: WAREHOUSE_USERNAME },
      });
      expect(entryBody.createdBy.id).toBe(warehouseUser.id);
      const entryAudit = await getAuditRow(
        AuditAction.INVENTORY_ENTRY_CREATED,
        entryBody.id,
      );
      assertAuditRowHasNoSecrets(entryAudit);

      const exit = await request(app.getHttpServer())
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '3.000',
          reason: 'Venta manual',
        });
      expect(exit.status).toBe(201);
      const exitBody = exit.body as SafeMovementBody;
      expect(exitBody.movementType).toBe(InventoryMovementType.EXIT);
      expect(exitBody.previousStock).toBe('15.000');
      expect(exitBody.newStock).toBe('12.000');
      await getAuditRow(AuditAction.INVENTORY_EXIT_CREATED, exitBody.id);

      const adjustIn = await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments/in')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '2.000',
          reason: 'Ajuste por conteo',
        });
      expect(adjustIn.status).toBe(201);
      const adjustInBody = adjustIn.body as SafeMovementBody;
      expect(adjustInBody.movementType).toBe(
        InventoryMovementType.ADJUSTMENT_IN,
      );
      expect(adjustInBody.previousStock).toBe('12.000');
      expect(adjustInBody.newStock).toBe('14.000');
      await getAuditRow(
        AuditAction.INVENTORY_ADJUSTMENT_IN_CREATED,
        adjustInBody.id,
      );

      const adjustOut = await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments/out')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '4.000',
          reason: 'Ajuste por merma',
        });
      expect(adjustOut.status).toBe(201);
      const adjustOutBody = adjustOut.body as SafeMovementBody;
      expect(adjustOutBody.movementType).toBe(
        InventoryMovementType.ADJUSTMENT_OUT,
      );
      expect(adjustOutBody.previousStock).toBe('14.000');
      expect(adjustOutBody.newStock).toBe('10.000');
      const adjustOutAudit = await getAuditRow(
        AuditAction.INVENTORY_ADJUSTMENT_OUT_CREATED,
        adjustOutBody.id,
      );
      const adjustOutMetadata = adjustOutAudit.metadata as Record<
        string,
        unknown
      >;
      expect(adjustOutMetadata).not.toHaveProperty('reason');
      expect(adjustOutMetadata).not.toHaveProperty('notes');
      expect(adjustOutMetadata).not.toHaveProperty('referenceType');
      expect(adjustOutMetadata).not.toHaveProperty('referenceId');
      expect(JSON.stringify(adjustOutAudit)).not.toMatch(/cookie|jwt/i);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('10.000');

      const movementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movementCount).toBe(5);
    });
  });

  // ============================================================
  // 12. Stock insuficiente y capacidad máxima
  // ============================================================
  describe('stock insuficiente y capacidad máxima', () => {
    it('salida mayor al saldo → 409 sin escritura', async () => {
      const product = await createProduct();
      await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '5.000', reason: 'Saldo' });

      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '10.000',
          reason: 'Salida excesiva',
        });
      expect(response.status).toBe(409);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('5.000');
      const movementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movementCount).toBe(1);
    });

    it('ajuste negativo mayor al saldo → 409 sin escritura ni auditoría adicional', async () => {
      const product = await createProduct();
      await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '5.000', reason: 'Saldo' });

      const response = await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments/out')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '10.000',
          reason: 'Ajuste excesivo',
        });
      expect(response.status).toBe(409);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('5.000');

      const auditRows = await prisma.auditLog.findMany({
        where: { action: AuditAction.INVENTORY_ADJUSTMENT_OUT_CREATED },
      });
      const relatedToProduct = auditRows.filter(
        (row) =>
          (row.metadata as Record<string, unknown> | null)?.productId ===
          product.id,
      );
      expect(relatedToProduct).toHaveLength(0);
    });

    it('capacidad máxima: entrada que excede MAX_STOCK_VALUE → 409 sin escritura', async () => {
      const product = await createProduct();
      const initial = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: MAX_STOCK_VALUE,
          reason: 'Saldo al máximo',
        });
      expect(initial.status).toBe(201);
      expect((initial.body as SafeMovementBody).newStock).toBe(MAX_STOCK_VALUE);

      const overflow = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '0.001',
          reason: 'Excede el máximo',
        });
      expect(overflow.status).toBe(409);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe(MAX_STOCK_VALUE);
      const movementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movementCount).toBe(1);
    });
  });

  // ============================================================
  // 13. Unidad sin decimales
  // ============================================================
  describe('unidad sin decimales (allowDecimal=false)', () => {
    it('acepta cantidades enteras y rechaza fraccionarias', async () => {
      const product = await createProduct({ unitId: noDecimalUnitId });

      const wholeAsInt = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1', reason: 'Entero' });
      expect(wholeAsInt.status).toBe(201);

      const wholeWithZeros = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.000',
          reason: 'Entero con ceros',
        });
      expect(wholeWithZeros.status).toBe(201);

      const fractional = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '1.500',
          reason: 'Fraccionario',
        });
      expect(fractional.status).toBe(400);

      const smallFraction = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: product.id,
          quantity: '0.001',
          reason: 'Fraccionario pequeño',
        });
      expect(smallFraction.status).toBe(400);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('2.000');
      const movementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movementCount).toBe(2);
    });
  });

  // ============================================================
  // 14. Estados y tipo de producto
  // ============================================================
  describe('estados y tipo de producto', () => {
    it('SERVICE → 400 en escritura y en GET stock para cualquier rol', async () => {
      const service = await createProduct({
        productType: ProductType.SERVICE,
        isInventoryTracked: false,
        stockMinimum: '0',
      });

      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: service.id, quantity: '1.000', reason: 'x' });
      expect(write.status).toBe(400);

      const stockAsAdmin = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${service.id}/stock`)
        .set('Cookie', adminCookie);
      expect(stockAsAdmin.status).toBe(400);

      const stockAsSeller = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${service.id}/stock`)
        .set('Cookie', sellerCookie);
      expect(stockAsSeller.status).toBe(400);
    });

    it('isInventoryTracked=false → 400 en escritura y en GET stock para cualquier rol', async () => {
      const notTracked = await createProduct({
        isInventoryTracked: false,
        stockMinimum: '0',
      });

      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: notTracked.id, quantity: '1.000', reason: 'x' });
      expect(write.status).toBe(400);

      const stockAsAdmin = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${notTracked.id}/stock`)
        .set('Cookie', adminCookie);
      expect(stockAsAdmin.status).toBe(400);

      const stockAsSeller = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${notTracked.id}/stock`)
        .set('Cookie', sellerCookie);
      expect(stockAsSeller.status).toBe(400);
    });

    it('producto INACTIVE → 409 en escritura; SELLER recibe 404 genérico en stock; ADMIN/WAREHOUSE/MANAGEMENT lo ven', async () => {
      const product = await createProduct();
      const deactivated = await request(app.getHttpServer())
        .post(`/api/v1/products/${product.id}/deactivate`)
        .set('Cookie', adminCookie);
      expect(deactivated.status).toBe(200);

      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.000', reason: 'x' });
      expect(write.status).toBe(409);

      const movementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(movementCount).toBe(0);

      const asSeller = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', sellerCookie);
      expect(asSeller.status).toBe(404);
      expect((asSeller.body as { message: string }).message).not.toMatch(
        /categor|unidad/i,
      );

      const asAdmin = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', adminCookie);
      expect(asAdmin.status).toBe(200);

      const asWarehouse = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', warehouseCookie);
      expect(asWarehouse.status).toBe(200);

      const asManagement = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', managementCookie);
      expect(asManagement.status).toBe(200);
    });

    it('categoría INACTIVE → 409 en escritura; SELLER recibe 404 en stock; ADMIN/WAREHOUSE/MANAGEMENT lo ven', async () => {
      const dedicatedCategory = await prisma.category.upsert({
        where: { code: 'E2E_INVCAT_INACT' },
        update: { status: CategoryStatus.ACTIVE },
        create: {
          code: 'E2E_INVCAT_INACT',
          name: 'Categoria e2e inventario inactiva',
        },
      });
      const product = await createProduct({ categoryId: dedicatedCategory.id });

      // La API bloquea /categories/:id/deactivate mientras exista un
      // producto ACTIVE con esa categoría (regla de negocio de
      // CategoriesService), que es exactamente el estado que esta prueba
      // necesita construir: producto operativo con categoría inactiva.
      // Se actualiza el estado directamente vía Prisma (preparación de
      // fixture); la petición bajo prueba (POST /entries) sigue pasando por
      // el stack HTTP completo.
      await prisma.category.update({
        where: { id: dedicatedCategory.id },
        data: { status: CategoryStatus.INACTIVE },
      });

      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.000', reason: 'x' });
      expect(write.status).toBe(409);

      const categoryInactiveMovementCount =
        await prisma.inventoryMovement.count({
          where: { productId: product.id },
        });
      expect(categoryInactiveMovementCount).toBe(0);

      const asSeller = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', sellerCookie);
      expect(asSeller.status).toBe(404);

      const asAdmin = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', adminCookie);
      expect(asAdmin.status).toBe(200);

      const asWarehouse = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', warehouseCookie);
      expect(asWarehouse.status).toBe(200);

      const asManagement = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', managementCookie);
      expect(asManagement.status).toBe(200);
    });

    it('unidad INACTIVE → 409 en escritura; SELLER recibe 404 en stock; ADMIN/WAREHOUSE/MANAGEMENT lo ven', async () => {
      const dedicatedUnit = await prisma.unit.upsert({
        where: { code: 'E2EINVUINACT' },
        update: { status: UnitStatus.ACTIVE },
        create: {
          code: 'E2EINVUINACT',
          name: 'Unidad e2e inventario inactiva',
          abbreviation: 'eiv',
        },
      });
      const product = await createProduct({ unitId: dedicatedUnit.id });

      // Mismo motivo que en la prueba de categoría INACTIVE: la API bloquea
      // /units/:id/deactivate mientras exista un producto ACTIVE con esa
      // unidad, así que el estado se prepara directamente vía Prisma.
      await prisma.unit.update({
        where: { id: dedicatedUnit.id },
        data: { status: UnitStatus.INACTIVE },
      });

      const write = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.000', reason: 'x' });
      expect(write.status).toBe(409);

      const unitInactiveMovementCount = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      expect(unitInactiveMovementCount).toBe(0);

      const asSeller = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', sellerCookie);
      expect(asSeller.status).toBe(404);

      const asAdmin = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', adminCookie);
      expect(asAdmin.status).toBe(200);

      const asWarehouse = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', warehouseCookie);
      expect(asWarehouse.status).toBe(200);

      const asManagement = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', managementCookie);
      expect(asManagement.status).toBe(200);
    });
  });

  // ============================================================
  // 15. Consulta de stock actual
  // ============================================================
  describe('consulta de stock actual', () => {
    it('producto inexistente → 404', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${NON_EXISTENT_UUID}/stock`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(404);
    });

    it('respuesta exacta y cambia tras movimientos reales', async () => {
      const product = await createProduct({ stockMinimum: '2.000' });

      const before = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', adminCookie);
      expect(before.status).toBe(200);
      const beforeBody = before.body as SafeProductStockBody;
      expect(Object.keys(beforeBody).sort()).toEqual(
        [
          'productId',
          'sku',
          'name',
          'stockCurrent',
          'stockMinimum',
          'unitAbbreviation',
          'allowDecimal',
        ].sort(),
      );
      expect(beforeBody.productId).toBe(product.id);
      expect(beforeBody.sku).toBe(product.sku);
      expect(beforeBody.stockCurrent).toBe('0.000');
      expect(beforeBody.stockMinimum).toBe('2.000');
      expect(beforeBody.allowDecimal).toBe(true);
      expect(JSON.stringify(beforeBody)).not.toMatch(
        /categoryStatus|unitStatus|referenceType|referenceId/i,
      );

      await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '7.000', reason: 'Saldo' });

      const after = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${product.id}/stock`)
        .set('Cookie', adminCookie);
      expect((after.body as SafeProductStockBody).stockCurrent).toBe('7.000');
    });
  });

  // ============================================================
  // 16. Listado global de movimientos
  // ============================================================
  describe('listado global de movimientos', () => {
    it('estructura paginada, filtros, orden y búsqueda', async () => {
      const suffix = Date.now();
      const product = await createProduct({
        sku: `${SKU_PREFIX}LIST-${suffix}`,
        name: `Producto Listado Buscable ${suffix}`,
      });

      const initial = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '10.000', reason: 'Saldo' });
      const initialId = (initial.body as SafeMovementBody).id;

      const entry = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', warehouseCookie)
        .send({ productId: product.id, quantity: '1.000', reason: 'Entrada' });
      const entryId = (entry.body as SafeMovementBody).id;

      const defaultPage = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId: product.id })
        .set('Cookie', adminCookie);
      expect(defaultPage.status).toBe(200);
      const defaultBody = defaultPage.body as PaginatedBody<SafeMovementBody>;
      expect(Object.keys(defaultBody).sort()).toEqual(
        ['data', 'page', 'limit', 'total', 'totalPages'].sort(),
      );
      expect(defaultBody.page).toBe(1);
      expect(defaultBody.limit).toBe(20);
      expect(defaultBody.total).toBe(2);
      const expectedOrder = await expectedMovementOrder([entryId, initialId]);
      expect(defaultBody.data.map((row) => row.id)).toEqual(expectedOrder);
      for (const row of defaultBody.data) {
        expect(row).not.toHaveProperty('referenceType');
        expect(row).not.toHaveProperty('referenceId');
        expect(row).not.toHaveProperty('passwordHash');
        expect(row).not.toHaveProperty('roleId');
        expect(row).not.toHaveProperty('failedLoginAttempts');
      }

      const customPaged = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId: product.id, page: 1, limit: 1 })
        .set('Cookie', adminCookie);
      expect(
        (customPaged.body as PaginatedBody<SafeMovementBody>).data,
      ).toHaveLength(1);
      expect((customPaged.body as PaginatedBody<SafeMovementBody>).limit).toBe(
        1,
      );

      const byMovementType = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({
          productId: product.id,
          movementType: InventoryMovementType.ENTRY,
        })
        .set('Cookie', adminCookie);
      expect(
        (byMovementType.body as PaginatedBody<SafeMovementBody>).total,
      ).toBe(2);

      const byOrigin = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({
          productId: product.id,
          origin: InventoryMovementOrigin.MANUAL,
        })
        .set('Cookie', adminCookie);
      const byOriginBody = byOrigin.body as PaginatedBody<SafeMovementBody>;
      expect(byOriginBody.total).toBe(1);
      expect(byOriginBody.data[0].id).toBe(entryId);

      const warehouseUser = await prisma.user.findUniqueOrThrow({
        where: { username: WAREHOUSE_USERNAME },
      });
      const byActor = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId: product.id, createdByUserId: warehouseUser.id })
        .set('Cookie', adminCookie);
      const byActorBody = byActor.body as PaginatedBody<SafeMovementBody>;
      expect(byActorBody.total).toBe(1);
      expect(byActorBody.data[0].id).toBe(entryId);

      const farFuture = new Date(
        Date.now() + 24 * 60 * 60 * 1000,
      ).toISOString();
      const farPast = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
      const byDateRange = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId: product.id, dateFrom: farPast, dateTo: farFuture })
        .set('Cookie', adminCookie);
      expect((byDateRange.body as PaginatedBody<SafeMovementBody>).total).toBe(
        2,
      );

      const emptyByDateRange = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({
          productId: product.id,
          dateFrom: farFuture,
          dateTo: farFuture,
        })
        .set('Cookie', adminCookie);
      expect(
        (emptyByDateRange.body as PaginatedBody<SafeMovementBody>).data,
      ).toHaveLength(0);

      const invalidRange = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ productId: product.id, dateFrom: farFuture, dateTo: farPast })
        .set('Cookie', adminCookie);
      expect(invalidRange.status).toBe(400);

      const searchBySku = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ search: `list-${suffix}` })
        .set('Cookie', adminCookie);
      const searchBySkuBody =
        searchBySku.body as PaginatedBody<SafeMovementBody>;
      expect(searchBySkuBody.data.some((row) => row.id === initialId)).toBe(
        true,
      );

      const searchByName = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ search: `listado buscable ${suffix}` })
        .set('Cookie', adminCookie);
      const searchByNameBody =
        searchByName.body as PaginatedBody<SafeMovementBody>;
      expect(searchByNameBody.data.some((row) => row.id === initialId)).toBe(
        true,
      );

      const emptyPage = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements')
        .query({ search: `sku-inexistente-${suffix}-zzz` })
        .set('Cookie', adminCookie);
      expect(emptyPage.status).toBe(200);
      expect((emptyPage.body as PaginatedBody<SafeMovementBody>).data).toEqual(
        [],
      );
    });
  });

  // ============================================================
  // 17. Movimiento por id
  // ============================================================
  describe('movimiento por id', () => {
    it('id inválido → 400; inexistente → 404; existente → 200; SELLER → 403', async () => {
      const invalid = await request(app.getHttpServer())
        .get('/api/v1/inventory/movements/not-a-uuid')
        .set('Cookie', adminCookie);
      expect(invalid.status).toBe(400);

      const missing = await request(app.getHttpServer())
        .get(`/api/v1/inventory/movements/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie);
      expect(missing.status).toBe(404);

      const product = await createProduct();
      const created = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.000', reason: 'Saldo' });
      const movementId = (created.body as SafeMovementBody).id;

      const existing = await request(app.getHttpServer())
        .get(`/api/v1/inventory/movements/${movementId}`)
        .set('Cookie', adminCookie);
      expect(existing.status).toBe(200);
      const existingBody = existing.body as SafeMovementBody;
      expect(existingBody.id).toBe(movementId);
      expect(existingBody).not.toHaveProperty('referenceType');
      expect(existingBody).not.toHaveProperty('referenceId');

      const asSeller = await request(app.getHttpServer())
        .get(`/api/v1/inventory/movements/${movementId}`)
        .set('Cookie', sellerCookie);
      expect(asSeller.status).toBe(403);
    });
  });

  // ============================================================
  // 18. Kardex por producto
  // ============================================================
  describe('kardex por producto', () => {
    it('validaciones, orden, contradicción de productId y confinamiento al producto', async () => {
      const invalidProductId = await request(app.getHttpServer())
        .get('/api/v1/inventory/products/not-a-uuid/movements')
        .set('Cookie', adminCookie);
      expect(invalidProductId.status).toBe(400);

      const missingProduct = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${NON_EXISTENT_UUID}/movements`)
        .set('Cookie', adminCookie);
      expect(missingProduct.status).toBe(404);

      const emptyProduct = await createProduct();
      const emptyKardex = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${emptyProduct.id}/movements`)
        .set('Cookie', adminCookie);
      expect(emptyKardex.status).toBe(200);
      expect(
        (emptyKardex.body as PaginatedBody<SafeMovementBody>).data,
      ).toEqual([]);

      const productA = await createProduct();
      const productB = await createProduct();
      const initialA = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: productA.id,
          quantity: '10.000',
          reason: 'Saldo A',
        });
      const entryA = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: productA.id,
          quantity: '1.000',
          reason: 'Entrada A',
        });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({
          productId: productB.id,
          quantity: '99.000',
          reason: 'Saldo B',
        });

      const kardexA = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productA.id}/movements`)
        .set('Cookie', adminCookie);
      const kardexABody = kardexA.body as PaginatedBody<SafeMovementBody>;
      expect(kardexABody.data).toHaveLength(2);
      const expectedOrderA = await expectedMovementOrder([
        (entryA.body as SafeMovementBody).id,
        (initialA.body as SafeMovementBody).id,
      ]);
      expect(kardexABody.data.map((row) => row.id)).toEqual(expectedOrderA);
      expect(
        kardexABody.data.every((row) => row.product.id === productA.id),
      ).toBe(true);

      const consistentQuery = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productA.id}/movements`)
        .query({ productId: productA.id })
        .set('Cookie', adminCookie);
      expect(consistentQuery.status).toBe(200);

      const contradictoryQuery = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productA.id}/movements`)
        .query({ productId: productB.id })
        .set('Cookie', adminCookie);
      expect(contradictoryQuery.status).toBe(400);

      await request(app.getHttpServer())
        .post(`/api/v1/products/${productA.id}/deactivate`)
        .set('Cookie', adminCookie);
      const kardexInactive = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productA.id}/movements`)
        .set('Cookie', adminCookie);
      expect(kardexInactive.status).toBe(200);
      expect(
        (kardexInactive.body as PaginatedBody<SafeMovementBody>).data,
      ).toHaveLength(2);
      const kardexInactiveWarehouse = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productA.id}/movements`)
        .set('Cookie', warehouseCookie);
      expect(kardexInactiveWarehouse.status).toBe(200);
      const kardexInactiveManagement = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productA.id}/movements`)
        .set('Cookie', managementCookie);
      expect(kardexInactiveManagement.status).toBe(200);

      const asSeller = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productA.id}/movements`)
        .set('Cookie', sellerCookie);
      expect(asSeller.status).toBe(403);
    });
  });

  // ============================================================
  // 19. Low-stock
  // ============================================================
  describe('low-stock', () => {
    let lowStockCategoryId: string;
    let lowStockUnitId: string;

    beforeAll(async () => {
      const category = await prisma.category.upsert({
        where: { code: 'E2E_LOWSTOCK' },
        update: { status: CategoryStatus.ACTIVE },
        create: { code: 'E2E_LOWSTOCK', name: 'Categoria e2e low-stock' },
      });
      lowStockCategoryId = category.id;
      const unit = await prisma.unit.upsert({
        where: { code: 'E2ELOWSTOCK' },
        update: { status: UnitStatus.ACTIVE, allowDecimal: true },
        create: {
          code: 'E2ELOWSTOCK',
          name: 'Unidad e2e low-stock',
          abbreviation: 'els',
          allowDecimal: true,
        },
      });
      lowStockUnitId = unit.id;
    });

    async function createLowStockCandidate(
      stockMinimum: string,
      initialBalance: string | null,
      overrides: Record<string, unknown> = {},
    ): Promise<SafeProductBody> {
      const product = await createProduct({
        categoryId: lowStockCategoryId,
        unitId: lowStockUnitId,
        stockMinimum,
        ...overrides,
      });
      if (initialBalance !== null) {
        await request(app.getHttpServer())
          .post('/api/v1/inventory/initial-balances')
          .set('Cookie', adminCookie)
          .send({
            productId: product.id,
            quantity: initialBalance,
            reason: 'Saldo low-stock',
          });
      }
      return product;
    }

    it('incluye exactamente los productos elegibles y excluye el resto (filtrado por categoría/unidad exclusivas)', async () => {
      const below = await createLowStockCandidate('10.000', '5.000');
      const equal = await createLowStockCandidate('5.000', '5.000');
      const zeroZero = await createLowStockCandidate('0', null);
      const above = await createLowStockCandidate('5.000', '20.000');
      const service = await createLowStockCandidate('0', null, {
        productType: ProductType.SERVICE,
        isInventoryTracked: false,
      });
      const notTracked = await createLowStockCandidate('0', null, {
        isInventoryTracked: false,
      });
      const inactiveProduct = await createLowStockCandidate('10.000', '1.000');
      await request(app.getHttpServer())
        .post(`/api/v1/products/${inactiveProduct.id}/deactivate`)
        .set('Cookie', adminCookie);

      const response = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ categoryId: lowStockCategoryId, limit: 100 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<{
        id: string;
        stockCurrent: string;
        stockMinimum: string;
      }>;
      const ids = body.data.map((row) => row.id);

      expect(ids).toContain(below.id);
      expect(ids).toContain(equal.id);
      expect(ids).toContain(zeroZero.id);
      expect(ids).not.toContain(above.id);
      expect(ids).not.toContain(service.id);
      expect(ids).not.toContain(notTracked.id);
      expect(ids).not.toContain(inactiveProduct.id);

      const zeroZeroRow = body.data.find((row) => row.id === zeroZero.id);
      expect(zeroZeroRow?.stockCurrent).toBe('0.000');
      expect(zeroZeroRow?.stockMinimum).toBe('0.000');
    });

    it('excluye productos con categoría o unidad inactiva', async () => {
      const inactiveCategory = await prisma.category.upsert({
        where: { code: 'E2E_LOWSTOCK_CI' },
        update: { status: CategoryStatus.ACTIVE },
        create: {
          code: 'E2E_LOWSTOCK_CI',
          name: 'Low-stock categoria inactiva',
        },
      });
      const withInactiveCategory = await createLowStockCandidate(
        '10.000',
        '1.000',
        { categoryId: inactiveCategory.id },
      );
      // La API bloquea el deactivate mientras el producto siga ACTIVE; se
      // prepara el estado directamente vía Prisma (ver nota equivalente en
      // "estados y tipo de producto").
      await prisma.category.update({
        where: { id: inactiveCategory.id },
        data: { status: CategoryStatus.INACTIVE },
      });

      const inactiveUnit = await prisma.unit.upsert({
        where: { code: 'E2ELOWSTOCKUI' },
        update: { status: UnitStatus.ACTIVE },
        create: {
          code: 'E2ELOWSTOCKUI',
          name: 'Low-stock unidad inactiva',
          abbreviation: 'lsi',
        },
      });
      const withInactiveUnit = await createLowStockCandidate(
        '10.000',
        '1.000',
        { unitId: inactiveUnit.id },
      );
      await prisma.unit.update({
        where: { id: inactiveUnit.id },
        data: { status: UnitStatus.INACTIVE },
      });

      const responseByCategory = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ search: withInactiveCategory.sku })
        .set('Cookie', adminCookie);
      expect(
        (responseByCategory.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === withInactiveCategory.id,
        ),
      ).toBe(false);

      const responseByUnit = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ search: withInactiveUnit.sku })
        .set('Cookie', adminCookie);
      expect(
        (responseByUnit.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === withInactiveUnit.id,
        ),
      ).toBe(false);
    });

    it('paginación, filtros, búsqueda case-insensitive y orden name/sku/id', async () => {
      const suffix = Date.now();
      const first = await createLowStockCandidate('10.000', '1.000', {
        sku: `${SKU_PREFIX}LOW-A-${suffix}`,
        name: `Aardvark LowStock ${suffix}`,
      });
      const second = await createLowStockCandidate('10.000', '1.000', {
        sku: `${SKU_PREFIX}LOW-B-${suffix}`,
        name: `Bardvark LowStock ${suffix}`,
      });

      const byCategoryUnit = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({
          categoryId: lowStockCategoryId,
          unitId: lowStockUnitId,
          search: `lowstock ${suffix}`,
        })
        .set('Cookie', adminCookie);
      expect(byCategoryUnit.status).toBe(200);
      const body = byCategoryUnit.body as PaginatedBody<{
        id: string;
        sku: string;
        name: string;
      }>;
      expect(body.data.map((row) => row.id)).toEqual([first.id, second.id]);
      expect(body.total).toBe(2);
      expect(body.totalPages).toBe(1);

      const upperCaseSearch = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ search: `LOWSTOCK ${suffix}`.toUpperCase() })
        .set('Cookie', adminCookie);
      expect(
        (upperCaseSearch.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === first.id,
        ),
      ).toBe(true);

      const skuSearch = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ search: `low-a-${suffix}`.toUpperCase() })
        .set('Cookie', adminCookie);
      expect(
        (skuSearch.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === first.id,
        ),
      ).toBe(true);

      const paged = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({
          categoryId: lowStockCategoryId,
          unitId: lowStockUnitId,
          search: `lowstock ${suffix}`,
          page: 2,
          limit: 1,
        })
        .set('Cookie', adminCookie);
      const pagedBody = paged.body as PaginatedBody<{ id: string }>;
      expect(pagedBody.data).toHaveLength(1);
      expect(pagedBody.data[0].id).toBe(second.id);
      expect(pagedBody.page).toBe(2);
      expect(pagedBody.totalPages).toBe(2);

      for (const row of body.data) {
        expect(row).toHaveProperty('stockCurrent');
        expect(
          (row as unknown as { stockCurrent: string }).stockCurrent,
        ).toMatch(/^\d+\.\d{3}$/);
      }
    });

    it('ADMIN/WAREHOUSE/MANAGEMENT acceden (200); SELLER no (403)', async () => {
      const admin = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', adminCookie);
      expect(admin.status).toBe(200);

      const warehouse = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', warehouseCookie);
      expect(warehouse.status).toBe(200);

      const management = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', managementCookie);
      expect(management.status).toBe(200);

      const seller = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .set('Cookie', sellerCookie);
      expect(seller.status).toBe(403);
    });

    // ================================================================
    // Fase 9, Bloque A (R5) — brand / status / difference
    // ================================================================
    it('difference = stockMinimum - stockCurrent, fixed 3 decimales, fraccionario y cero', async () => {
      const fractional = await createLowStockCandidate('10.000', '7.500');
      const zero = await createLowStockCandidate('10.000', '10.000');

      const response = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ categoryId: lowStockCategoryId, limit: 100 })
        .set('Cookie', adminCookie);
      const body = response.body as PaginatedBody<{
        id: string;
        difference: string;
      }>;
      const fractionalRow = body.data.find((r) => r.id === fractional.id);
      const zeroRow = body.data.find((r) => r.id === zero.id);
      expect(fractionalRow?.difference).toBe('2.500');
      expect(zeroRow?.difference).toBe('0.000');
    });

    it('brand: omitido no filtra; con valor filtra insensible a mayúsculas; en blanco -> 400', async () => {
      const suffix = Date.now();
      const branded = await createLowStockCandidate('10.000', '1.000', {
        sku: `${SKU_PREFIX}LOW-BRAND-${suffix}`,
        name: `Producto marca low-stock ${suffix}`,
        brand: `MarcaLowStock${suffix}`,
      });

      const byBrand = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ brand: `marcalowstock${suffix}`.toUpperCase() })
        .set('Cookie', adminCookie);
      expect(byBrand.status).toBe(200);
      expect(
        (byBrand.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === branded.id,
        ),
      ).toBe(true);

      const trimmed = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ brand: `  MarcaLowStock${suffix}  ` })
        .set('Cookie', adminCookie);
      expect(
        (trimmed.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === branded.id,
        ),
      ).toBe(true);

      const blank = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ brand: '   ' })
        .set('Cookie', adminCookie);
      expect(blank.status).toBe(400);
    });

    it('status: omitido preserva ACTIVE-only exacto; INACTIVE explícito incluye productos inactivos elegibles', async () => {
      const inactiveEligible = await createLowStockCandidate('10.000', '1.000');
      await request(app.getHttpServer())
        .post(`/api/v1/products/${inactiveEligible.id}/deactivate`)
        .set('Cookie', adminCookie);

      const defaultResponse = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({ categoryId: lowStockCategoryId, limit: 100 })
        .set('Cookie', adminCookie);
      expect(
        (defaultResponse.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === inactiveEligible.id,
        ),
      ).toBe(false);

      const inactiveResponse = await request(app.getHttpServer())
        .get('/api/v1/inventory/low-stock')
        .query({
          categoryId: lowStockCategoryId,
          status: ProductStatus.INACTIVE,
          limit: 100,
        })
        .set('Cookie', adminCookie);
      expect(inactiveResponse.status).toBe(200);
      expect(
        (inactiveResponse.body as PaginatedBody<{ id: string }>).data.some(
          (row) => row.id === inactiveEligible.id,
        ),
      ).toBe(true);
    });
  });

  // ============================================================
  // 21-23. Concurrencia real (HTTP + Promise.all, sin mocks, sin sleeps)
  // ============================================================
  describe('concurrencia real', () => {
    it('dos entradas concurrentes sobre stock cero: ambas 201, stock final 5.000, cadena consistente', async () => {
      const product = await createProduct();

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/inventory/entries')
          .set('Cookie', adminCookie)
          .send({
            productId: product.id,
            quantity: '2.000',
            reason: 'Entrada concurrente A',
          }),
        request(app.getHttpServer())
          .post('/api/v1/inventory/entries')
          .set('Cookie', warehouseCookie)
          .send({
            productId: product.id,
            quantity: '3.000',
            reason: 'Entrada concurrente B',
          }),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('5.000');

      const movements = await prisma.inventoryMovement.findMany({
        where: { productId: product.id },
        orderBy: { previousStock: 'asc' },
      });
      expect(movements).toHaveLength(2);
      expect(movements[0].previousStock.toFixed(3)).toBe('0.000');
      expect(
        ['2.000', '3.000'].includes(movements[0].newStock.toFixed(3)),
      ).toBe(true);
      expect(
        ['2.000', '3.000'].includes(movements[1].previousStock.toFixed(3)),
      ).toBe(true);
      expect(movements[1].newStock.toFixed(3)).toBe('5.000');
      expect(movements[0].newStock.toFixed(3)).toBe(
        movements[1].previousStock.toFixed(3),
      );
    }, 60000);

    it('dos salidas concurrentes de 7.000 sobre stock 10.000: una 201, una 409, stock final 3.000', async () => {
      const product = await createProduct();
      await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '10.000', reason: 'Saldo' });

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/inventory/exits')
          .set('Cookie', adminCookie)
          .send({
            productId: product.id,
            quantity: '7.000',
            reason: 'Salida concurrente A',
          }),
        request(app.getHttpServer())
          .post('/api/v1/inventory/exits')
          .set('Cookie', warehouseCookie)
          .send({
            productId: product.id,
            quantity: '7.000',
            reason: 'Salida concurrente B',
          }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('3.000');

      const exitMovements = await prisma.inventoryMovement.count({
        where: {
          productId: product.id,
          movementType: InventoryMovementType.EXIT,
        },
      });
      expect(exitMovements).toBe(1);

      const exitAudits = await prisma.auditLog.count({
        where: { action: AuditAction.INVENTORY_EXIT_CREATED },
      });
      const winner = first.status === 201 ? first : second;
      const winnerMovementId = (winner.body as SafeMovementBody).id;
      const relatedAudit = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.INVENTORY_EXIT_CREATED,
          entityType: 'InventoryMovement',
          entityId: winnerMovementId,
        },
      });
      expect(relatedAudit).toHaveLength(1);
      expect(exitAudits).toBeGreaterThanOrEqual(1);
    }, 60000);

    it('dos saldos iniciales concurrentes para el mismo producto: exactamente uno gana', async () => {
      const product = await createProduct();

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/inventory/initial-balances')
          .set('Cookie', adminCookie)
          .send({
            productId: product.id,
            quantity: '5.000',
            reason: 'Saldo concurrente A',
          }),
        request(app.getHttpServer())
          .post('/api/v1/inventory/initial-balances')
          .set('Cookie', warehouseCookie)
          .send({
            productId: product.id,
            quantity: '7.000',
            reason: 'Saldo concurrente B',
          }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const winner = first.status === 201 ? first : second;
      const winnerBody = winner.body as SafeMovementBody;

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe(winnerBody.newStock);
      expect(['5.000', '7.000']).toContain(productRow.stockCurrent.toFixed(3));

      const initialBalanceMovements = await prisma.inventoryMovement.count({
        where: {
          productId: product.id,
          origin: InventoryMovementOrigin.INITIAL_BALANCE,
        },
      });
      expect(initialBalanceMovements).toBe(1);

      const audits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.INVENTORY_INITIAL_BALANCE_CREATED,
          entityType: 'InventoryMovement',
          entityId: winnerBody.id,
        },
      });
      expect(audits).toHaveLength(1);
    }, 60000);
  });

  // ============================================================
  // 24. Restricciones reales de PostgreSQL (bypass del motor)
  // ============================================================
  describe('restricciones reales de PostgreSQL', () => {
    let constraintProductId: string;

    beforeAll(async () => {
      const product = await createProduct();
      constraintProductId = product.id;
    });

    it('inventory_movements_quantity_positive rechaza quantity=0', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO inventory_movements
              (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, created_by_user_id, created_at)
            VALUES
              (gen_random_uuid(), ${constraintProductId}::uuid, 'ENTRY', 'MANUAL', 0, 0, 0, 'check probe', ${adminId}::uuid, now())
          `,
        '23514',
      );
      const count = await prisma.inventoryMovement.count({
        where: { productId: constraintProductId, reason: 'check probe' },
      });
      expect(count).toBe(0);
      expect(await prisma.product.count()).toBeGreaterThan(0);
    });

    it('inventory_movements_previous_stock_non_negative rechaza previousStock negativo', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO inventory_movements
              (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, created_by_user_id, created_at)
            VALUES
              (gen_random_uuid(), ${constraintProductId}::uuid, 'ENTRY', 'MANUAL', 1, -1, 0, 'check probe', ${adminId}::uuid, now())
          `,
        '23514',
      );
      const count = await prisma.inventoryMovement.count({
        where: { productId: constraintProductId, reason: 'check probe' },
      });
      expect(count).toBe(0);
      expect(await prisma.product.count()).toBeGreaterThan(0);
    });

    it('inventory_movements_new_stock_non_negative rechaza newStock negativo', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO inventory_movements
              (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, created_by_user_id, created_at)
            VALUES
              (gen_random_uuid(), ${constraintProductId}::uuid, 'EXIT', 'MANUAL', 2, 1, -1, 'check probe', ${adminId}::uuid, now())
          `,
        '23514',
      );
      const count = await prisma.inventoryMovement.count({
        where: { productId: constraintProductId, reason: 'check probe' },
      });
      expect(count).toBe(0);
      expect(await prisma.product.count()).toBeGreaterThan(0);
    });

    it('inventory_movements_stock_consistency rechaza aritmética inconsistente', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO inventory_movements
              (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, created_by_user_id, created_at)
            VALUES
              (gen_random_uuid(), ${constraintProductId}::uuid, 'ENTRY', 'MANUAL', 1, 1, 5, 'check probe', ${adminId}::uuid, now())
          `,
        '23514',
      );
      const count = await prisma.inventoryMovement.count({
        where: { productId: constraintProductId, reason: 'check probe' },
      });
      expect(count).toBe(0);
      expect(await prisma.product.count()).toBeGreaterThan(0);
    });

    it('inventory_movements_origin_type_consistency rechaza SALE con ENTRY', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO inventory_movements
              (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, reference_type, reference_id, created_by_user_id, created_at)
            VALUES
              (gen_random_uuid(), ${constraintProductId}::uuid, 'ENTRY', 'SALE', 1, 1, 2, 'check probe', 'SALE', '11111111-1111-1111-1111-111111111111', ${adminId}::uuid, now())
          `,
        '23514',
      );
      const count = await prisma.inventoryMovement.count({
        where: { productId: constraintProductId, reason: 'check probe' },
      });
      expect(count).toBe(0);
      expect(await prisma.product.count()).toBeGreaterThan(0);
    });

    it('inventory_movements_reference_pair rechaza referencia incompleta', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO inventory_movements
              (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, reference_type, reference_id, created_by_user_id, created_at)
            VALUES
              (gen_random_uuid(), ${constraintProductId}::uuid, 'ENTRY', 'MANUAL', 1, 1, 2, 'check probe', 'SALE', NULL, ${adminId}::uuid, now())
          `,
        '23514',
      );
      const count = await prisma.inventoryMovement.count({
        where: { productId: constraintProductId, reason: 'check probe' },
      });
      expect(count).toBe(0);
      expect(await prisma.product.count()).toBeGreaterThan(0);
    });

    it('inventory_movements_one_initial_balance_per_product rechaza un segundo INITIAL_BALANCE', async () => {
      const product = await createProduct();
      await prisma.$executeRaw`
        INSERT INTO inventory_movements
          (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, created_by_user_id, created_at)
        VALUES
          (gen_random_uuid(), ${product.id}::uuid, 'ENTRY', 'INITIAL_BALANCE', 1, 0, 1, 'check probe first', ${adminId}::uuid, now())
      `;

      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO inventory_movements
              (id, product_id, movement_type, origin, quantity, previous_stock, new_stock, reason, created_by_user_id, created_at)
            VALUES
              (gen_random_uuid(), ${product.id}::uuid, 'ENTRY', 'INITIAL_BALANCE', 1, 0, 1, 'check probe second', ${adminId}::uuid, now())
          `,
        '23505',
      );

      const count = await prisma.inventoryMovement.count({
        where: {
          productId: product.id,
          origin: InventoryMovementOrigin.INITIAL_BALANCE,
        },
      });
      expect(count).toBe(1);

      // El INSERT directo nunca pasó por el motor, así que Product.stockCurrent
      // (todavía "0.000") queda inconsistente con el new_stock=1 insertado a
      // mano. Se elimina la fila insertada de inmediato, sin esperar al
      // afterAll global, para no dejar esa inconsistencia expuesta durante el
      // resto de la ejecución (el producto en sí, ya sin movimientos, lo
      // limpia el afterAll junto con el resto de fixtures de este spec).
      await prisma.inventoryMovement.deleteMany({
        where: { productId: product.id },
      });
    });

    it('la conexión sigue siendo utilizable tras los rechazos anteriores', async () => {
      const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(result[0].ok).toBe(1);
    });
  });

  // ============================================================
  // 25-26. Integridad stock/movimientos y atomicidad
  // ============================================================
  describe('integridad entre stock y movimientos', () => {
    it('el encadenamiento previousStock/newStock es exacto y sin campos inmutables extra', async () => {
      const product = await createProduct();
      await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '10.000', reason: 'Saldo' });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '5.000', reason: 'Entrada' });
      await request(app.getHttpServer())
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '3.000', reason: 'Salida' });

      const movements = await prisma.inventoryMovement.findMany({
        where: { productId: product.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      expect(movements).toHaveLength(3);

      for (let i = 1; i < movements.length; i += 1) {
        expect(movements[i].previousStock.toFixed(3)).toBe(
          movements[i - 1].newStock.toFixed(3),
        );
      }
      for (const movement of movements) {
        expect(movement.quantity.greaterThan(0)).toBe(true);
        expect(movement.origin).not.toBeNull();
        expect(movement.createdByUserId).toBe(adminId);
        expect(movement.referenceType).toBeNull();
        expect(movement.referenceId).toBeNull();
        expect(movement.createdAt).toBeInstanceOf(Date);
        expect(movement).not.toHaveProperty('updatedAt');
        expect(movement).not.toHaveProperty('deletedAt');
        expect(movement).not.toHaveProperty('status');
      }

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      const lastMovement = movements[movements.length - 1];
      expect(productRow.stockCurrent.toFixed(3)).toBe(
        lastMovement.newStock.toFixed(3),
      );
    });

    it('operaciones rechazadas no dejan movimiento ni auditoría ni cambio de stock', async () => {
      const product = await createProduct();
      await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '5.000', reason: 'Saldo' });

      const beforeMovements = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      const beforeAudits = await prisma.auditLog.count({
        where: { entityType: 'InventoryMovement' },
      });

      const rejectedByDto = await request(app.getHttpServer())
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '-1.000', reason: 'x' });
      expect(rejectedByDto.status).toBe(400);

      const rejectedByStock = await request(app.getHttpServer())
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '999.000', reason: 'x' });
      expect(rejectedByStock.status).toBe(409);

      const rejectedByDuplicateInitial = await request(app.getHttpServer())
        .post('/api/v1/inventory/initial-balances')
        .set('Cookie', adminCookie)
        .send({ productId: product.id, quantity: '1.000', reason: 'x' });
      expect(rejectedByDuplicateInitial.status).toBe(409);

      const afterMovements = await prisma.inventoryMovement.count({
        where: { productId: product.id },
      });
      const afterAudits = await prisma.auditLog.count({
        where: { entityType: 'InventoryMovement' },
      });
      expect(afterMovements).toBe(beforeMovements);
      expect(afterAudits).toBe(beforeAudits);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: product.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('5.000');
    });
  });

  // ============================================================
  // 28. Regresión de Swagger y rutas (lo no cubierto por app.e2e-spec.ts)
  // ============================================================
  describe('regresión de Swagger', () => {
    it('el documento OpenAPI conserva exactamente las 10 operaciones de Inventory, sin PATCH/DELETE', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');
      expect(response.status).toBe(200);

      const document = response.body as {
        paths: Record<string, Record<string, unknown>>;
        tags: { name: string }[];
      };
      expect(document.tags.map((tag) => tag.name)).toContain('Inventory');

      const inventoryPaths = Object.keys(document.paths).filter((path) =>
        path.includes('/inventory'),
      );
      expect(inventoryPaths).toHaveLength(10);
      for (const path of inventoryPaths) {
        const methods = Object.keys(document.paths[path]);
        expect(methods).not.toContain('patch');
        expect(methods).not.toContain('delete');
      }
    });
  });
});
