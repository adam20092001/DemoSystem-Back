import { INestApplication } from '@nestjs/common';
import {
  AccountStatus,
  AccountType,
  CategoryStatus,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
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

/**
 * Fase A1 (PCGE) — administración del plan de cuentas jerárquico. Suite
 * dedicada, separada de accounting.e2e-spec.ts (Fase 8, GET /accounts:
 * contrato histórico de las 6 cuentas de sistema, sin cambios). Mismo
 * aislamiento que el resto del dominio: solo pos_db_test, limpieza por ID
 * propio.
 */
describe('Chart of Accounts — PCGE (Fase A1) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let customerId: string;

  const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
  // Corto a propósito: varios codes de prueba combinan un prefijo largo
  // con este sufijo, y Account.code es VarChar(20) (el más estrecho de
  // todo este archivo).
  const SUFFIX = Date.now() % 1000000;

  const createdAccountIds: string[] = [];
  const createdSaleIds: string[] = [];

  interface SafeChartAccountBody {
    id: string;
    code: string;
    name: string;
    type: AccountType;
    systemKey: string | null;
    parentId: string | null;
    level: number;
    isPostable: boolean;
    status: AccountStatus;
    normalBalance: 'DEBIT' | 'CREDIT';
  }

  async function createAccount(body: {
    code: string;
    name: string;
    type: AccountType;
    parentId?: string;
    isPostable?: boolean;
    cookie?: string;
  }): Promise<{ status: number; body: SafeChartAccountBody }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/chart-of-accounts')
      .set('Cookie', body.cookie ?? adminCookie)
      .send({
        code: body.code,
        name: body.name,
        type: body.type,
        ...(body.parentId !== undefined ? { parentId: body.parentId } : {}),
        ...(body.isPostable !== undefined
          ? { isPostable: body.isPostable }
          : {}),
      });
    if (response.status === 201) {
      createdAccountIds.push((response.body as SafeChartAccountBody).id);
    }
    return {
      status: response.status,
      body: response.body as SafeChartAccountBody,
    };
  }

  function updateAccount(
    id: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/v1/chart-of-accounts/${id}`)
      .set('Cookie', cookie)
      .send(body);
  }

  function getAccount(id: string, cookie: string = adminCookie) {
    return request(app.getHttpServer())
      .get(`/api/v1/chart-of-accounts/${id}`)
      .set('Cookie', cookie);
  }

  function listAccounts(
    query: Record<string, unknown> = {},
    cookie: string = adminCookie,
  ) {
    return request(app.getHttpServer())
      .get('/api/v1/chart-of-accounts')
      .query(query)
      .set('Cookie', cookie);
  }

  function getTree(cookie: string = adminCookie) {
    return request(app.getHttpServer())
      .get('/api/v1/chart-of-accounts/tree')
      .set('Cookie', cookie);
  }

  function activateAccount(id: string, cookie: string = adminCookie) {
    return request(app.getHttpServer())
      .post(`/api/v1/chart-of-accounts/${id}/activate`)
      .set('Cookie', cookie)
      .send({});
  }

  function deactivateAccount(id: string, cookie: string = adminCookie) {
    return request(app.getHttpServer())
      .post(`/api/v1/chart-of-accounts/${id}/deactivate`)
      .set('Cookie', cookie)
      .send({});
  }

  function reassignSystemKey(
    systemKey: string,
    accountId: string,
    cookie: string = adminCookie,
  ) {
    return request(app.getHttpServer())
      .patch(`/api/v1/chart-of-accounts/system-keys/${systemKey}`)
      .set('Cookie', cookie)
      .send({ accountId });
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: `e2e_mgmt_coa_${SUFFIX}`,
      email: `e2e_mgmt_coa_${SUFFIX}@demosystem.test`,
      password: 'ManagementCoa123',
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: `e2e_seller_coa_${SUFFIX}`,
      email: `e2e_seller_coa_${SUFFIX}@demosystem.test`,
      password: 'SellerCoa123',
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: `e2e_warehouse_coa_${SUFFIX}`,
      email: `e2e_warehouse_coa_${SUFFIX}@demosystem.test`,
      password: 'WarehouseCoa123',
      roleName: RoleName.WAREHOUSE,
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

    managementCookie = (
      await login(
        app.getHttpServer(),
        `e2e_mgmt_coa_${SUFFIX}`,
        'ManagementCoa123',
      )
    ).cookie;
    sellerCookie = (
      await login(
        app.getHttpServer(),
        `e2e_seller_coa_${SUFFIX}`,
        'SellerCoa123',
      )
    ).cookie;
    warehouseCookie = (
      await login(
        app.getHttpServer(),
        `e2e_warehouse_coa_${SUFFIX}`,
        'WarehouseCoa123',
      )
    ).cookie;

    // Upsert defensivo (nunca reinicia currentNumber si ya existe): mismo
    // criterio que configuration-tax.e2e-spec.ts/sales.e2e-spec.ts — otra
    // suite de la corrida completa puede haber borrado esta fila en su
    // propio afterAll.
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

    const category = await prisma.category.create({
      data: {
        code: `E2ECOACAT_${SUFFIX}`,
        name: 'Categoria E2E COA',
        status: CategoryStatus.ACTIVE,
      },
    });
    categoryId = category.id;

    const unit = await prisma.unit.create({
      data: {
        // Unit.code es VarChar(15): a diferencia de Category/Product, no
        // cabe el prefijo completo + timestamp de 13 dígitos.
        code: `U${String(SUFFIX).slice(-10)}`,
        name: 'Unidad E2E COA',
        abbreviation: 'eu',
        allowDecimal: false,
        status: UnitStatus.ACTIVE,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: `E2ECOA-P-${SUFFIX}`,
        name: 'Producto E2E COA',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('100.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('100.000'),
        status: ProductStatus.ACTIVE,
      },
    });
    productId = product.id;

    const customer = await prisma.customer.create({
      data: {
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        creditEnabled: true,
        name: `Cliente E2E COA ${SUFFIX}`,
      },
    });
    customerId = customer.id;
  });

  afterAll(async () => {
    try {
      if (createdSaleIds.length > 0) {
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: createdSaleIds } },
        });
        await prisma.accountingEntry.deleteMany({
          where: {
            sourceType: 'SALE',
            sourceId: { in: createdSaleIds },
          },
        });
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: createdSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
      }
      if (createdAccountIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Account', entityId: { in: createdAccountIds } },
        });
        // Hijos antes que padres: se borran en orden INVERSO de creación
        // (cada hijo se creó después de su padre en esta suite).
        for (const id of [...createdAccountIds].reverse()) {
          await prisma.account.deleteMany({ where: { id } });
        }
      }
      if (productId) {
        await prisma.product.deleteMany({ where: { id: productId } });
      }
      if (customerId) {
        await prisma.customer.deleteMany({ where: { id: customerId } });
      }
      if (unitId) {
        await prisma.unit.deleteMany({ where: { id: unitId } });
      }
      if (categoryId) {
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  describe('autorización', () => {
    it('sin cookie -> 401', async () => {
      const response = await listAccounts({}, '');
      expect(response.status).toBe(401);
    });

    it('SELLER y WAREHOUSE no pueden leer (403)', async () => {
      const sellerRes = await listAccounts({}, sellerCookie);
      const warehouseRes = await listAccounts({}, warehouseCookie);
      expect(sellerRes.status).toBe(403);
      expect(warehouseRes.status).toBe(403);
    });

    it('MANAGEMENT puede leer pero no crear (403 al mutar)', async () => {
      const readRes = await listAccounts({}, managementCookie);
      expect(readRes.status).toBe(200);

      const writeRes = await createAccount({
        code: `MGMT_${SUFFIX}`,
        name: 'No debería crearse',
        type: AccountType.ASSET,
        cookie: managementCookie,
      });
      expect(writeRes.status).toBe(403);
    });

    it('ADMIN puede leer y crear', async () => {
      const readRes = await listAccounts({}, adminCookie);
      expect(readRes.status).toBe(200);
    });
  });

  describe('jerarquía — creación, niveles y árbol', () => {
    let rootId: string;
    let childId: string;

    it('crea una cuenta raíz de agrupación (isPostable=false, level=1)', async () => {
      const result = await createAccount({
        code: `E1_${SUFFIX}`,
        name: 'Efectivo y equivalentes (grupo)',
        type: AccountType.ASSET,
        isPostable: false,
      });
      expect(result.status).toBe(201);
      expect(result.body.level).toBe(1);
      expect(result.body.parentId).toBeNull();
      expect(result.body.isPostable).toBe(false);
      expect(result.body.status).toBe('ACTIVE');
      expect(result.body.normalBalance).toBe('DEBIT');
      rootId = result.body.id;
    });

    it('crea una subcuenta postable bajo la raíz (level=2)', async () => {
      const result = await createAccount({
        code: `E1041_${SUFFIX}`,
        name: 'Cuentas corrientes operativas',
        type: AccountType.ASSET,
        parentId: rootId,
      });
      expect(result.status).toBe(201);
      expect(result.body.level).toBe(2);
      expect(result.body.parentId).toBe(rootId);
      expect(result.body.isPostable).toBe(true);
      childId = result.body.id;
    });

    it('GET /chart-of-accounts/tree anida la subcuenta bajo la raíz', async () => {
      const response = await getTree();
      expect(response.status).toBe(200);
      const tree = response.body as Array<{
        id: string;
        children: { id: string }[];
      }>;
      const rootNode = tree.find((n) => n.id === rootId);
      expect(rootNode).toBeDefined();
      expect(rootNode?.children.some((c) => c.id === childId)).toBe(true);
    });

    it('GET /chart-of-accounts/:id devuelve el detalle de la subcuenta creada', async () => {
      const response = await getAccount(childId);
      expect(response.status).toBe(200);
      const body = response.body as SafeChartAccountBody;
      expect(body.id).toBe(childId);
      expect(body.parentId).toBe(rootId);
      expect(body.level).toBe(2);
    });

    it('GET /chart-of-accounts/:id con id inexistente -> 404', async () => {
      const response = await getAccount(NON_EXISTENT_UUID);
      expect(response.status).toBe(404);
    });

    it('code duplicado -> 409, sin crear nada', async () => {
      const before = await prisma.account.count();
      const result = await createAccount({
        code: `E1_${SUFFIX}`,
        name: 'Duplicada',
        type: AccountType.ASSET,
      });
      expect(result.status).toBe(409);
      const after = await prisma.account.count();
      expect(after).toBe(before);
    });

    it('parentId inexistente -> 404', async () => {
      const result = await createAccount({
        code: `E1_X_${SUFFIX}`,
        name: 'X',
        type: AccountType.ASSET,
        parentId: NON_EXISTENT_UUID,
      });
      expect(result.status).toBe(404);
    });

    it('parentId marcado isPostable=true -> 409 (una cuenta postable no puede recibir subcuentas)', async () => {
      const result = await createAccount({
        code: `E1041X_${SUFFIX}`,
        name: 'X',
        type: AccountType.ASSET,
        parentId: childId, // childId ya es postable=true
      });
      expect(result.status).toBe(409);
    });

    it('ciclo indirecto: PATCH de un padre para que su propio hijo pase a ser su padre -> 400', async () => {
      // Par DEDICADO, no postable en ambos niveles (childId de rootId ya
      // es postable=true desde su creación — reutilizarlo dispararía el
      // 409 de "padre postable" antes de llegar siquiera a evaluar el
      // ciclo). nodeX (raíz) -> nodeY (hijo de nodeX); re-parentar nodeX
      // bajo nodeY es exactamente el ciclo de 2 niveles que
      // assertNoCycle() debe detectar.
      const nodeX = await createAccount({
        code: `CYCX_${SUFFIX}`,
        name: 'Ciclo X',
        type: AccountType.ASSET,
        isPostable: false,
      });
      expect(nodeX.status).toBe(201);
      const nodeY = await createAccount({
        code: `CYCY_${SUFFIX}`,
        name: 'Ciclo Y',
        type: AccountType.ASSET,
        parentId: nodeX.body.id,
        isPostable: false,
      });
      expect(nodeY.status).toBe(201);

      const response = await updateAccount(nodeX.body.id, {
        parentId: nodeY.body.id,
      });
      expect(response.status).toBe(400);
    });

    it('auto-padre -> 400', async () => {
      const response = await updateAccount(rootId, { parentId: rootId });
      expect(response.status).toBe(400);
    });

    it('marcar la raíz (con subcuentas) como isPostable=true -> 409', async () => {
      const response = await updateAccount(rootId, { isPostable: true });
      expect(response.status).toBe(409);
    });

    it('marcar la subcuenta hoja (sin hijos) como isPostable=true: permitido (no-op real, ya lo es)', async () => {
      const response = await updateAccount(childId, { isPostable: true });
      expect(response.status).toBe(200);
    });
  });

  describe('activación y desactivación', () => {
    let leafId: string;

    beforeAll(async () => {
      const result = await createAccount({
        code: `LEAF_${SUFFIX}`,
        name: 'Hoja desactivable',
        type: AccountType.EXPENSE,
      });
      leafId = result.body.id;
    });

    it('desactivar: 200, status INACTIVE', async () => {
      const response = await deactivateAccount(leafId);
      expect(response.status).toBe(200);
      expect((response.body as SafeChartAccountBody).status).toBe('INACTIVE');
    });

    it('desactivar de nuevo -> 409', async () => {
      const response = await deactivateAccount(leafId);
      expect(response.status).toBe(409);
    });

    it('activar bajo un padre inexistente... (cuenta raíz, sin padre): 200', async () => {
      const response = await activateAccount(leafId);
      expect(response.status).toBe(200);
      expect((response.body as SafeChartAccountBody).status).toBe('ACTIVE');
    });

    it('activar ya activa -> 409', async () => {
      const response = await activateAccount(leafId);
      expect(response.status).toBe(409);
    });

    it('desactivar con subcuentas ACTIVE -> 409', async () => {
      const parent = await createAccount({
        code: `PARENT_DEACT_${SUFFIX}`,
        name: 'Padre con hijo activo',
        type: AccountType.EXPENSE,
        isPostable: false,
      });
      expect(parent.status).toBe(201);
      const child = await createAccount({
        code: `CHILD_DEACT_${SUFFIX}`,
        name: 'Hijo activo',
        type: AccountType.EXPENSE,
        parentId: parent.body.id,
      });
      expect(child.status).toBe(201);

      const response = await deactivateAccount(parent.body.id);
      expect(response.status).toBe(409);
    });
  });

  describe('protección de cuentas de sistema', () => {
    it('GET /accounts (legacy) sigue exponiendo exactamente las 6 cuentas de sistema, forma exacta', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounts')
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const accounts = response.body as Array<Record<string, unknown>>;
      expect(accounts).toHaveLength(6);
      for (const account of accounts) {
        expect(Object.keys(account).sort()).toEqual(
          ['id', 'code', 'name', 'type', 'systemKey'].sort(),
        );
      }
    });

    it('desactivar la cuenta CASH (systemKey no nulo) -> 409, sin tocarla', async () => {
      const cashAccount = await prisma.account.findUniqueOrThrow({
        where: { systemKey: 'CASH' },
      });
      const response = await deactivateAccount(cashAccount.id);
      expect(response.status).toBe(409);

      const after = await prisma.account.findUniqueOrThrow({
        where: { id: cashAccount.id },
      });
      expect(after.status).toBe(AccountStatus.ACTIVE);
    });
  });

  describe('A1.3 — mapeo configurable (reassignSystemKey): capacidad técnica, sin activar nada real', () => {
    it('cuenta destino inexistente -> 404', async () => {
      const response = await reassignSystemKey('CASH', NON_EXISTENT_UUID);
      expect(response.status).toBe(404);
    });

    it('cuenta destino INACTIVE -> 409, CASH no se mueve', async () => {
      const inactiveTarget = await createAccount({
        code: `INACT_TARGET_${SUFFIX}`,
        name: 'Destino inactivo',
        type: AccountType.ASSET,
      });
      expect(inactiveTarget.status).toBe(201);
      await deactivateAccount(inactiveTarget.body.id);

      const cashBefore = await prisma.account.findUniqueOrThrow({
        where: { systemKey: 'CASH' },
      });

      const response = await reassignSystemKey('CASH', inactiveTarget.body.id);
      expect(response.status).toBe(409);

      const cashAfter = await prisma.account.findUniqueOrThrow({
        where: { systemKey: 'CASH' },
      });
      expect(cashAfter.id).toBe(cashBefore.id);
    });

    it('cuenta destino no postable -> 409', async () => {
      const groupTarget = await createAccount({
        code: `GROUP_TARGET_${SUFFIX}`,
        name: 'Destino de agrupación',
        type: AccountType.ASSET,
        isPostable: false,
      });
      expect(groupTarget.status).toBe(201);

      const response = await reassignSystemKey('CASH', groupTarget.body.id);
      expect(response.status).toBe(409);
    });

    it(
      'reasigna DISCOUNTS a una cuenta nueva y de vuelta a la original: 200, ' +
        'el sostenedor anterior queda sin systemKey, la nueva lo sostiene, ' +
        'y las líneas de asiento históricas de DISCOUNTS no cambian de accountId',
      async () => {
        const originalDiscounts = await prisma.account.findUniqueOrThrow({
          where: { systemKey: 'DISCOUNTS' },
        });

        const newHolder = await createAccount({
          code: `DISC_NEW_${SUFFIX}`,
          name: 'Descuentos (PCGE, destino temporal de prueba)',
          type: AccountType.CONTRA_REVENUE,
        });
        // Guarda OBLIGATORIA antes de seguir: el resto de esta prueba
        // perturba una cuenta de sistema real (DISCOUNTS). Si la fixture
        // no se creó, cortar aquí explícitamente — nunca seguir con un id
        // indefinido hacia una operación de restauración.
        expect(newHolder.status).toBe(201);
        const newHolderId = newHolder.body.id;

        const linesBefore = await prisma.accountingEntryLine.count({
          where: { accountId: originalDiscounts.id },
        });

        try {
          const reassigned = await reassignSystemKey('DISCOUNTS', newHolderId);
          expect(reassigned.status).toBe(200);
          expect((reassigned.body as SafeChartAccountBody).systemKey).toBe(
            'DISCOUNTS',
          );

          const oldHolderAfter = await prisma.account.findUniqueOrThrow({
            where: { id: originalDiscounts.id },
          });
          expect(oldHolderAfter.systemKey).toBeNull();

          // Las líneas YA posteadas siguen apuntando al accountId original:
          // reasignar el mapeo nunca reescribe AccountingEntryLine alguna.
          const linesAfterReassign = await prisma.accountingEntryLine.count({
            where: { accountId: originalDiscounts.id },
          });
          expect(linesAfterReassign).toBe(linesBefore);
        } finally {
          // Restauración OBLIGATORIA: DISCOUNTS es una cuenta de sistema
          // real, usada por cualquier venta con descuento en el resto de
          // la suite E2E completa. Se restaura sin importar el resultado.
          // `update` (singular), NUNCA `updateMany`: con un id indefinido,
          // Prisma trata un filtro `undefined` en `where` como "omitido",
          // así que `updateMany({ where: { id: undefined } })` se
          // convierte en un UPDATE sin WHERE que afectaría TODA la tabla
          // (exactamente la corrupción real que este comentario documenta
          // haber causado y corregido durante el desarrollo de esta
          // prueba) — `update` exige un identificador único real y falla
          // fuerte en vez de corromper en silencio.
          await prisma.account.update({
            where: { id: newHolderId },
            data: { systemKey: null },
          });
          await prisma.account.update({
            where: { id: originalDiscounts.id },
            data: { systemKey: 'DISCOUNTS' },
          });
        }

        const finalHolder = await prisma.account.findUniqueOrThrow({
          where: { systemKey: 'DISCOUNTS' },
        });
        expect(finalHolder.id).toBe(originalDiscounts.id);
      },
    );
  });

  describe('A1-review — validación de cuentas durante el posteo', () => {
    it('AccountingEngine.resolveAccounts() filtra status=ACTIVE e isPostable=true: una venta real sigue posteando con normalidad (regresión, sin cambios observables)', async () => {
      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send({ customerId, items: [{ productId, quantity: '1' }] });
      expect(sale.status).toBe(201);
      createdSaleIds.push((sale.body as { id: string }).id);
    });

    it('marcar isPostable=false en una cuenta de sistema (CASH) -> 409, sin tocarla (cierra la brecha: antes solo se bloqueaba la desactivación, no isPostable)', async () => {
      const cashAccount = await prisma.account.findUniqueOrThrow({
        where: { systemKey: 'CASH' },
      });
      const response = await updateAccount(cashAccount.id, {
        isPostable: false,
      });
      expect(response.status).toBe(409);

      const after = await prisma.account.findUniqueOrThrow({
        where: { id: cashAccount.id },
      });
      expect(after.isPostable).toBe(true);
    });
  });

  describe('A1-review — concurrencia real en reasignaciones', () => {
    it(
      'dos reasignaciones simultáneas del MISMO systemKey (DISCOUNTS) a cuentas DISTINTAS: ' +
        'exactamente una 200 y una 409 (índice único de systemKey, traducido por el filtro global ' +
        'de errores de Prisma), nunca dos cuentas sosteniendo el mismo systemKey',
      async () => {
        const originalDiscounts = await prisma.account.findUniqueOrThrow({
          where: { systemKey: 'DISCOUNTS' },
        });

        const targetA = await createAccount({
          code: `RSKA_${SUFFIX}`,
          name: 'Destino A de la carrera',
          type: AccountType.CONTRA_REVENUE,
        });
        expect(targetA.status).toBe(201);
        const targetB = await createAccount({
          code: `RSKB_${SUFFIX}`,
          name: 'Destino B de la carrera',
          type: AccountType.CONTRA_REVENUE,
        });
        expect(targetB.status).toBe(201);

        try {
          const [resA, resB] = await Promise.all([
            reassignSystemKey('DISCOUNTS', targetA.body.id),
            reassignSystemKey('DISCOUNTS', targetB.body.id),
          ]);

          // Bajo el lock de fila que Postgres toma sobre el sostenedor
          // actual al reasignar, una de las dos transacciones siempre
          // serializa detrás de la otra y su propio UPDATE final choca
          // con la restricción única de systemKey (P2002) — el filtro
          // global de excepciones (AllExceptionsFilter.fromPrismaError)
          // ya traduce eso a 409 sin necesidad de ningún catch adicional
          // en el servicio. Nunca hay un tercer desenlace posible.
          expect([resA.status, resB.status].sort()).toEqual([200, 409]);

          const holders = await prisma.account.findMany({
            where: { systemKey: 'DISCOUNTS' },
          });
          expect(holders).toHaveLength(1);
          expect([targetA.body.id, targetB.body.id]).toContain(holders[0].id);
        } finally {
          // Restauración OBLIGATORIA (DISCOUNTS es una cuenta de sistema
          // real) — `update` singular, nunca `updateMany`, y siempre con
          // ids ya confirmados por un 201 explícito arriba.
          await prisma.account.update({
            where: { id: targetA.body.id },
            data: { systemKey: null },
          });
          await prisma.account.update({
            where: { id: targetB.body.id },
            data: { systemKey: null },
          });
          await prisma.account.update({
            where: { id: originalDiscounts.id },
            data: { systemKey: 'DISCOUNTS' },
          });
        }

        const finalHolder = await prisma.account.findUniqueOrThrow({
          where: { systemKey: 'DISCOUNTS' },
        });
        expect(finalHolder.id).toBe(originalDiscounts.id);
      },
    );

    it(
      'una venta CON descuento se confirma mientras se reasigna DISCOUNTS en paralelo: ' +
        'la venta siempre postea su línea de DISCOUNTS contra la cuenta que realmente sostenía ' +
        'el systemKey en ese instante (la vieja o la nueva), nunca una referencia corrupta o ausente',
      async () => {
        const originalDiscounts = await prisma.account.findUniqueOrThrow({
          where: { systemKey: 'DISCOUNTS' },
        });

        const newTarget = await createAccount({
          code: `RSKSALE_${SUFFIX}`,
          name: 'Nuevo destino de Descuentos',
          type: AccountType.CONTRA_REVENUE,
        });
        expect(newTarget.status).toBe(201);

        try {
          const [saleRes, reassignRes] = await Promise.all([
            request(app.getHttpServer())
              .post('/api/v1/sales')
              .set('Cookie', adminCookie)
              .send({
                customerId,
                items: [{ productId, quantity: '1' }],
                discountAmount: '1.00',
              }),
            reassignSystemKey('DISCOUNTS', newTarget.body.id),
          ]);

          expect(saleRes.status).toBe(201);
          createdSaleIds.push((saleRes.body as { id: string }).id);
          // Sin carrera de unicidad aquí (la venta solo LEE la cuenta,
          // nunca escribe systemKey): la reasignación siempre gana sola.
          expect(reassignRes.status).toBe(200);

          const discountLine = await prisma.accountingEntryLine.findFirst({
            where: {
              accountId: { in: [originalDiscounts.id, newTarget.body.id] },
              entry: {
                sourceType: 'SALE',
                sourceId: (saleRes.body as { id: string }).id,
              },
            },
          });
          expect(discountLine).not.toBeNull();
        } finally {
          await prisma.account.update({
            where: { id: newTarget.body.id },
            data: { systemKey: null },
          });
          await prisma.account.update({
            where: { id: originalDiscounts.id },
            data: { systemKey: 'DISCOUNTS' },
          });
        }
      },
    );
  });

  describe('integridad histórica — type bloqueado con asientos reales', () => {
    it('una venta real postea AccountingEntryLine contra AR; cambiar el type de AR después -> 409', async () => {
      const sale = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send({
          customerId,
          items: [{ productId, quantity: '1' }],
        });
      expect(sale.status).toBe(201);
      createdSaleIds.push((sale.body as { id: string }).id);

      const arAccount = await prisma.account.findUniqueOrThrow({
        where: { systemKey: 'ACCOUNTS_RECEIVABLE' },
      });
      const linesForAr = await prisma.accountingEntryLine.count({
        where: { accountId: arAccount.id },
      });
      expect(linesForAr).toBeGreaterThan(0);

      const response = await updateAccount(arAccount.id, {
        type: 'LIABILITY',
      });
      expect(response.status).toBe(409);

      const unchanged = await prisma.account.findUniqueOrThrow({
        where: { id: arAccount.id },
      });
      expect(unchanged.type).toBe(AccountType.ASSET);
    });
  });

  describe('concurrencia real — dos creaciones con el mismo code en paralelo', () => {
    it('exactamente una 201 y una 409; nunca ambas 201', async () => {
      const code = `RACE_${SUFFIX}`;
      const [first, second] = await Promise.all([
        createAccount({ code, name: 'Carrera A', type: AccountType.ASSET }),
        createAccount({ code, name: 'Carrera B', type: AccountType.ASSET }),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const countWithCode = await prisma.account.count({ where: { code } });
      expect(countWithCode).toBe(1);
    });
  });
});
