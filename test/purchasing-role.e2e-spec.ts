import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  PrismaClient,
  ProductStatus,
  ProductType,
  RoleName,
  SupplierDocumentType,
  SupplierStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { businessToday } from '../src/common/date/business-date';
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
 * R1 — Rol PURCHASING. Suite dedicada y aislada: crea y limpia exclusivamente
 * lo suyo (mismo criterio que purchase-receipts.e2e-spec.ts). Cubre la matriz
 * de permisos aprobada, el login/cambio de rol del nuevo rol, las vistas de
 * recepción para almacén (sin importes) y la excepción de MANAGEMENT
 * (confirmar/anular facturas de compra).
 */

interface SessionBody {
  id: string;
  roles: RoleName[];
  activeRole: RoleName;
  mustChangePassword: boolean;
}

interface InvoiceBody {
  id: string;
  status: string;
  postedEntryId: string | null;
  lines: { id: string; productId: string | null }[];
}

interface ReceiptBody {
  id: string;
  status: string;
  lines: { id: string; purchaseInvoiceLineId: string; quantity: string }[];
}

interface ReceivableListBody {
  data: {
    id: string;
    documentNumber: string;
    pendingLinesCount: number;
    supplier: { id: string; legalName: string };
  }[];
  total: number;
}

interface ReceivableDetailBody {
  id: string;
  status: string;
  pendingLinesCount: number;
  lines: {
    purchaseInvoiceLineId: string;
    productSku: string;
    invoicedQuantity: string;
    receivedQuantity: string;
    pendingQuantity: string;
    status: string;
  }[];
}

const PASSWORD = 'E2eR1Fixture2026Aa';
const TEMP_PASSWORD = 'TemporalR1Pass123';
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

const U = {
  purchasing: 'e2e_r1_purchasing',
  multi: 'e2e_r1_multi',
  management: 'e2e_r1_management',
  warehouse: 'e2e_r1_warehouse',
  accountant: 'e2e_r1_accountant',
  seller: 'e2e_r1_seller',
  created: 'e2e_r1_created',
  assigned: 'e2e_r1_assigned',
};

const PURCHASE_SYSTEM_KEYS: AccountingSystemKey[] = [
  AccountingSystemKey.ACCOUNTS_PAYABLE,
  AccountingSystemKey.VAT_RECEIVABLE,
  AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
  AccountingSystemKey.PURCHASE_INTERNAL_CONSUMPTION,
  AccountingSystemKey.PURCHASE_FIXED_ASSET,
  AccountingSystemKey.PURCHASE_OPERATING_EXPENSE,
  AccountingSystemKey.PURCHASE_OTHER,
];

describe('R1 — Rol PURCHASING (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let purchasingCookie: string;
  let managementCookie: string;
  let warehouseCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let purchasingUserId: string;
  let managementUserId: string;
  let warehouseUserId: string;

  let categoryId: string;
  let unitId: string;
  let supplierId: string;
  let productId: string;
  let secondProductId: string;
  let serviceInvoiceNumberSeed = 0;

  const createdAccountIds: string[] = [];
  const createdInvoiceIds: string[] = [];
  const createdReceiptIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdProductIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  // ---------------------------------------------------------------- helpers
  function api(
    method: 'get' | 'post' | 'patch' | 'put' | 'delete',
    url: string,
    cookie: string,
    body?: Record<string, unknown>,
  ): request.Test {
    const req = request(app.getHttpServer())
      [method](`/api/v1${url}`)
      .set('Cookie', cookie);
    return body === undefined ? req : req.send(body);
  }

  function goodLine(prodId: string, quantity: string): Record<string, unknown> {
    return {
      productId: prodId,
      acquisitionKind: 'GOOD',
      purchasePurpose: 'RESALE_INVENTORY',
      quantity,
      unitCost: '10.00',
      taxCategory: 'UNAFFECTED',
    };
  }

  function serviceLine(): Record<string, unknown> {
    return {
      description: 'Servicio de flete R1',
      acquisitionKind: 'SERVICE',
      purchasePurpose: 'OPERATING_EXPENSE',
      quantity: '1.000',
      unitCost: '100.00',
      taxCategory: 'UNAFFECTED',
    };
  }

  async function createInvoice(
    lines: Record<string, unknown>[],
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<request.Response> {
    serviceInvoiceNumberSeed += 1;
    return api('post', '/purchase-invoices', cookie, {
      supplierId,
      documentType: 'FACTURA',
      documentSeries: 'R100',
      documentNumber: `${nextSuffix().slice(-7)}${serviceInvoiceNumberSeed}`,
      issueDate: businessToday(),
      lines,
      ...overrides,
    });
  }

  async function draftInvoice(
    lines: Record<string, unknown>[],
  ): Promise<InvoiceBody> {
    const response = await createInvoice(lines, purchasingCookie);
    if (response.status !== 201) {
      throw new Error(`Factura fixture: ${JSON.stringify(response.body)}`);
    }
    const body = response.body as InvoiceBody;
    createdInvoiceIds.push(body.id);
    return body;
  }

  /** Factura CONFIRMED por MANAGEMENT (la excepción aprobada). */
  async function confirmedInvoice(
    lines: Record<string, unknown>[],
  ): Promise<InvoiceBody> {
    const draft = await draftInvoice(lines);
    const confirmed = await api(
      'post',
      `/purchase-invoices/${draft.id}/confirm`,
      managementCookie,
      {},
    );
    if (confirmed.status !== 200) {
      throw new Error(`Confirmar fixture: ${JSON.stringify(confirmed.body)}`);
    }
    return confirmed.body as InvoiceBody;
  }

  async function receive(
    invoiceId: string,
    lineId: string,
    quantity: string,
    cookie: string,
  ): Promise<request.Response> {
    return api('post', `/purchase-invoices/${invoiceId}/receipts`, cookie, {
      lines: [{ purchaseInvoiceLineId: lineId, quantity }],
    });
  }

  async function stockOf(id: string): Promise<string> {
    const p = await prisma.product.findUniqueOrThrow({ where: { id } });
    return p.stockCurrent.toFixed(3);
  }

  async function createAccount(
    code: string,
    type: AccountType,
  ): Promise<string> {
    const response = await api('post', '/chart-of-accounts', adminCookie, {
      code,
      name: `Cuenta sintética E2E R1 ${code}`,
      type,
      isPostable: true,
    });
    if (response.status !== 201) {
      throw new Error(`Cuenta fixture: ${JSON.stringify(response.body)}`);
    }
    const id = (response.body as { id: string }).id;
    createdAccountIds.push(id);
    return id;
  }

  async function activatePurchaseMappings(): Promise<void> {
    const short = Date.now() % 1000000;
    let i = 0;
    for (const systemKey of PURCHASE_SYSTEM_KEYS) {
      i += 1;
      const accountId = await createAccount(
        `R1${i}${short}`,
        systemKey === AccountingSystemKey.ACCOUNTS_PAYABLE
          ? AccountType.LIABILITY
          : AccountType.ASSET,
      );
      const response = await api(
        'patch',
        `/chart-of-accounts/system-keys/${systemKey}`,
        adminCookie,
        { accountId },
      );
      if (response.status !== 200) {
        throw new Error(`Mapeo ${systemKey}: ${JSON.stringify(response.body)}`);
      }
    }
  }

  function supplierBody(): Record<string, unknown> {
    const suffix = nextSuffix();
    return {
      documentType: SupplierDocumentType.RUC,
      documentNumber: suffix.slice(-11).padStart(11, '0'),
      legalName: `Proveedor E2E R1 ${suffix}`,
    };
  }

  /** Ninguna clave financiera en ninguna parte del JSON (para WAREHOUSE). */
  function expectNoFinancialData(body: unknown): void {
    const serialized = JSON.stringify(body);
    for (const forbidden of [
      'reclassif',
      'unitCost',
      'taxableBase',
      'taxAmount',
      'creditable',
      'lineTotal',
      'totalAmount',
      'subtotal',
      'postedEntryId',
      'accountId',
    ]) {
      expect(serialized).not.toContain(forbidden);
    }
  }

  // ------------------------------------------------------------- lifecycle
  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(`Login admin: ${JSON.stringify(adminLogin.body)}`);
    }
    adminCookie = adminLogin.cookie;

    const fixtures: [string, RoleName][] = [
      [U.purchasing, RoleName.PURCHASING],
      [U.multi, RoleName.PURCHASING],
      [U.management, RoleName.MANAGEMENT],
      [U.warehouse, RoleName.WAREHOUSE],
      [U.accountant, RoleName.ACCOUNTANT],
      [U.seller, RoleName.SELLER],
      [U.assigned, RoleName.SELLER],
    ];
    const users: Record<string, string> = {};
    for (const [username, roleName] of fixtures) {
      const user = await upsertFixtureUser(prisma, {
        username,
        email: `${username}@demosystem.test`,
        password: PASSWORD,
        roleName,
      });
      users[username] = user.id;
    }
    // Usuario multi-rol: PURCHASING + ADMIN asignados.
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMIN },
    });
    await prisma.userRole.create({
      data: { userId: users[U.multi], roleId: adminRole.id },
    });
    purchasingUserId = users[U.purchasing];
    managementUserId = users[U.management];
    warehouseUserId = users[U.warehouse];

    const cookieOf = async (username: string): Promise<string> => {
      const result = await login(app.getHttpServer(), username, PASSWORD);
      if (result.status !== 200) {
        throw new Error(`Login ${username}: ${JSON.stringify(result.body)}`);
      }
      return result.cookie;
    };
    purchasingCookie = await cookieOf(U.purchasing);
    managementCookie = await cookieOf(U.management);
    warehouseCookie = await cookieOf(U.warehouse);
    accountantCookie = await cookieOf(U.accountant);
    sellerCookie = await cookieOf(U.seller);

    const short = Date.now() % 1000000;
    const category = await prisma.category.create({
      data: { code: `R1CAT${short}`, name: `Categoría E2E R1 ${short}` },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `R1UN${short}`,
        name: `Unidad E2E R1 ${short}`,
        abbreviation: 'r1u',
        allowDecimal: true,
      },
    });
    unitId = unit.id;

    for (const slot of ['A', 'B']) {
      const suffix = nextSuffix();
      const product = await createProductRow(prisma, {
        data: {
          sku: `R1-${slot}-${suffix}`,
          name: `Producto E2E R1 ${slot} ${suffix}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId,
          salePrice: '50.00',
          isInventoryTracked: true,
          stockCurrent: '0.000',
          status: ProductStatus.ACTIVE,
        },
      });
      createdProductIds.push(product.id);
      if (slot === 'A') {
        productId = product.id;
      } else {
        secondProductId = product.id;
      }
    }

    const supplier = await api(
      'post',
      '/suppliers',
      adminCookie,
      supplierBody(),
    );
    supplierId = (supplier.body as { id: string }).id;
    createdSupplierIds.push(supplierId);

    await activatePurchaseMappings();
  }, 90000);

  afterAll(async () => {
    try {
      const receipts = await prisma.purchaseReceipt.findMany({
        where: {
          OR: [
            { id: { in: createdReceiptIds } },
            { purchaseInvoiceId: { in: createdInvoiceIds } },
          ],
        },
        select: { id: true, reclassificationEntryId: true },
      });
      const receiptIds = receipts.map((r) => r.id);
      const reclassEntryIds = receipts
        .map((r) => r.reclassificationEntryId)
        .filter((id): id is string => id !== null);
      await prisma.purchaseReceiptLine.deleteMany({
        where: { purchaseReceiptId: { in: receiptIds } },
      });
      await prisma.purchaseReceipt.deleteMany({
        where: { id: { in: receiptIds } },
      });

      const posted = await prisma.purchaseInvoice.findMany({
        where: {
          id: { in: createdInvoiceIds },
          postedEntryId: { not: null },
        },
        select: { postedEntryId: true },
      });
      const originalIds = [
        ...posted
          .map((p) => p.postedEntryId)
          .filter((id): id is string => id !== null),
        ...reclassEntryIds,
      ];
      await prisma.purchaseInvoice.deleteMany({
        where: { id: { in: createdInvoiceIds } },
      });
      if (originalIds.length > 0) {
        const reversals = await prisma.accountingEntry.findMany({
          where: { reversesEntryId: { in: originalIds } },
          select: { id: true },
        });
        const entryIds = [...originalIds, ...reversals.map((r) => r.id)];
        await prisma.accountingEntryLine.deleteMany({
          where: { entryId: { in: entryIds } },
        });
        await prisma.accountingEntry.deleteMany({
          where: { id: { in: entryIds } },
        });
      }

      await prisma.inventoryMovement.deleteMany({
        where: { productId: { in: createdProductIds } },
      });
      await prisma.supplier.deleteMany({
        where: { id: { in: createdSupplierIds } },
      });
      await deleteProductRows(prisma, {
        where: { id: { in: createdProductIds } },
      });
      await prisma.category.deleteMany({ where: { id: categoryId } });
      await prisma.unit.deleteMany({ where: { id: unitId } });
      await prisma.account.deleteMany({
        where: { id: { in: createdAccountIds } },
      });

      const usernames = Object.values(U);
      await prisma.userRole.deleteMany({
        where: { user: { username: { in: usernames } } },
      });
      await prisma.user.deleteMany({ where: { username: { in: usernames } } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 90000);

  // =====================================================================
  // 1-3. Rol disponible, asignación y login
  // =====================================================================
  describe('rol PURCHASING: catálogo, asignación y sesión', () => {
    it('1. aparece en GET /roles (derivado de RoleName)', async () => {
      const response = await api('get', '/roles', adminCookie);
      expect(response.status).toBe(200);
      const names = (response.body as { name: string }[]).map((r) => r.name);
      expect(names).toContain('PURCHASING');
    });

    it('1b. la fila de Role existe en base de datos (migración M2 / seed)', async () => {
      const role = await prisma.role.findUnique({
        where: { name: RoleName.PURCHASING },
      });
      expect(role).not.toBeNull();
      expect(role?.description).toBeTruthy();
    });

    it('2. ADMIN crea un usuario solo-PURCHASING y asigna el rol a un usuario existente (con auditoría)', async () => {
      const created = await api('post', '/users', adminCookie, {
        firstName: 'Compras',
        lastName: 'Nuevo',
        username: U.created,
        email: `${U.created}@demosystem.test`,
        temporaryPassword: TEMP_PASSWORD,
        roleNames: [RoleName.PURCHASING],
      });
      expect(created.status).toBe(201);
      const createdBody = created.body as { id: string; roles: RoleName[] };
      expect(createdBody.roles).toEqual([RoleName.PURCHASING]);
      const createdAudit = await prisma.auditLog.count({
        where: {
          action: AuditAction.USER_CREATED,
          entityId: createdBody.id,
        },
      });
      expect(createdAudit).toBe(1);

      const assigned = await prisma.user.findUniqueOrThrow({
        where: { username: U.assigned },
      });
      const patched = await api('patch', `/users/${assigned.id}`, adminCookie, {
        roleNames: [RoleName.SELLER, RoleName.PURCHASING],
      });
      expect(patched.status).toBe(200);
      // Orden de presentación: PURCHASING antes que SELLER.
      expect((patched.body as { roles: RoleName[] }).roles).toEqual([
        RoleName.PURCHASING,
        RoleName.SELLER,
      ]);
      const updatedAudit = await prisma.auditLog.count({
        where: { action: AuditAction.USER_UPDATED, entityId: assigned.id },
      });
      expect(updatedAudit).toBeGreaterThanOrEqual(1);
    });

    it('3. un usuario exclusivamente PURCHASING inicia sesión (activeRole PURCHASING)', async () => {
      const result = await login(app.getHttpServer(), U.created, TEMP_PASSWORD);
      expect(result.status).toBe(200);
      const body = result.body as unknown as SessionBody;
      expect(body.roles).toEqual([RoleName.PURCHASING]);
      expect(body.activeRole).toBe(RoleName.PURCHASING);

      const fixtureLogin = await login(
        app.getHttpServer(),
        U.purchasing,
        PASSWORD,
      );
      expect(fixtureLogin.status).toBe(200);
      expect((fixtureLogin.body as unknown as SessionBody).activeRole).toBe(
        RoleName.PURCHASING,
      );
      const me = await api('get', '/auth/me', fixtureLogin.cookie);
      expect((me.body as { role: RoleName }).role).toBe(RoleName.PURCHASING);
    });

    it('4-5. roles combinados: el login elige PURCHASING (menos privilegiado) y el cambio de rol NO suma permisos', async () => {
      const first = await login(app.getHttpServer(), U.multi, PASSWORD);
      expect(first.status).toBe(200);
      expect((first.body as unknown as SessionBody).activeRole).toBe(
        RoleName.PURCHASING,
      );
      expect((first.body as unknown as SessionBody).roles).toEqual(
        expect.arrayContaining([RoleName.PURCHASING, RoleName.ADMIN]),
      );

      // Con PURCHASING activo, aunque tenga ADMIN asignado: sin permisos de ADMIN.
      const target = await api(
        'post',
        '/suppliers',
        adminCookie,
        supplierBody(),
      );
      const targetId = (target.body as { id: string }).id;
      createdSupplierIds.push(targetId);
      expect(
        (
          await api(
            'post',
            `/suppliers/${targetId}/deactivate`,
            first.cookie,
            {},
          )
        ).status,
      ).toBe(403);
      expect((await api('get', '/users', first.cookie)).status).toBe(403);

      // Cambio a ADMIN: ahora sí; y el cambio queda auditado.
      const switched = await api('post', '/auth/switch-role', first.cookie, {
        role: RoleName.ADMIN,
      });
      expect(switched.status).toBe(200);
      const adminSideCookie = (
        (switched.headers['set-cookie'] as unknown as string[])[0] ?? ''
      ).split(';')[0];
      expect(
        (
          await api(
            'post',
            `/suppliers/${targetId}/deactivate`,
            adminSideCookie,
            {},
          )
        ).status,
      ).toBe(200);
      expect(
        await prisma.auditLog.count({
          where: { action: AuditAction.ACTIVE_ROLE_SWITCHED },
        }),
      ).toBeGreaterThanOrEqual(1);

      // Vuelta a PURCHASING: pierde de nuevo el privilegio.
      const back = await api('post', '/auth/switch-role', adminSideCookie, {
        role: RoleName.PURCHASING,
      });
      expect(back.status).toBe(200);
      const purchasingSideCookie = (
        (back.headers['set-cookie'] as unknown as string[])[0] ?? ''
      ).split(';')[0];
      expect(
        (
          await api(
            'post',
            `/suppliers/${targetId}/activate`,
            purchasingSideCookie,
            {},
          )
        ).status,
      ).toBe(403);

      // Un rol no asignado no puede activarse.
      expect(
        (
          await api('post', '/auth/switch-role', purchasingSideCookie, {
            role: RoleName.WAREHOUSE,
          })
        ).status,
      ).toBe(403);
    });
  });

  // =====================================================================
  // 6. Lecturas de catálogo
  // =====================================================================
  describe('PURCHASING: catálogos de solo lectura', () => {
    it('6. consulta productos, categorías, unidades y configuración POS', async () => {
      expect((await api('get', '/products', purchasingCookie)).status).toBe(
        200,
      );
      expect(
        (await api('get', `/products/${productId}`, purchasingCookie)).status,
      ).toBe(200);
      expect((await api('get', '/categories', purchasingCookie)).status).toBe(
        200,
      );
      expect((await api('get', '/units', purchasingCookie)).status).toBe(200);
      const pos = await api('get', '/configuration/pos', purchasingCookie);
      expect(pos.status).toBe(200);
      expect(pos.body).toHaveProperty('taxRate');
    });

    it('6b. no escribe catálogos ni lee la configuración administrativa', async () => {
      expect(
        (
          await api('post', '/products', purchasingCookie, {
            sku: 'X',
            name: 'X',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api('post', '/categories', purchasingCookie, {
            code: 'X',
            name: 'X',
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await api('post', '/units', purchasingCookie, {
            code: 'X',
            name: 'X',
          })
        ).status,
      ).toBe(403);
      expect(
        (await api('get', '/configuration', purchasingCookie)).status,
      ).toBe(403);
      expect(
        (await api('patch', '/configuration', purchasingCookie, {})).status,
      ).toBe(403);
    });
  });

  // =====================================================================
  // 7-9. Proveedores
  // =====================================================================
  describe('PURCHASING: proveedores', () => {
    it('7-8. lista, consulta, crea y edita (con auditoría del actor real)', async () => {
      expect((await api('get', '/suppliers', purchasingCookie)).status).toBe(
        200,
      );
      expect(
        (await api('get', `/suppliers/${supplierId}`, purchasingCookie)).status,
      ).toBe(200);

      const created = await api(
        'post',
        '/suppliers',
        purchasingCookie,
        supplierBody(),
      );
      expect(created.status).toBe(201);
      const body = created.body as { id: string; status: string };
      createdSupplierIds.push(body.id);
      expect(body.status).toBe('ACTIVE');

      const patched = await api(
        'patch',
        `/suppliers/${body.id}`,
        purchasingCookie,
        { tradeName: 'Nombre comercial R1' },
      );
      expect(patched.status).toBe(200);
      expect((patched.body as { tradeName: string }).tradeName).toBe(
        'Nombre comercial R1',
      );

      const createdAudit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.SUPPLIER_CREATED, entityId: body.id },
      });
      expect(createdAudit.userId).toBe(purchasingUserId);
      const updatedAudit = await prisma.auditLog.findFirstOrThrow({
        where: { action: AuditAction.SUPPLIER_UPDATED, entityId: body.id },
      });
      expect(updatedAudit.userId).toBe(purchasingUserId);
    });

    it('9. no activa ni desactiva proveedores (403) y el estado queda intacto', async () => {
      expect(
        (
          await api(
            'post',
            `/suppliers/${supplierId}/deactivate`,
            purchasingCookie,
            {},
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await api(
            'post',
            `/suppliers/${supplierId}/activate`,
            purchasingCookie,
            {},
          )
        ).status,
      ).toBe(403);
      const row = await prisma.supplier.findUniqueOrThrow({
        where: { id: supplierId },
      });
      expect(row.status).toBe(SupplierStatus.ACTIVE);
    });

    it('9b. PATCH no admite cambiar el estado vía propiedades adicionales (400) y no produce ningún cambio', async () => {
      const before = await prisma.supplier.findUniqueOrThrow({
        where: { id: supplierId },
      });
      const auditBefore = await prisma.auditLog.count({
        where: { action: AuditAction.SUPPLIER_UPDATED, entityId: supplierId },
      });
      for (const payload of [
        { status: 'INACTIVE' },
        { legalName: 'Intento', status: 'INACTIVE' },
        { legalName: 'Intento', id: NON_EXISTENT_UUID },
      ]) {
        expect(
          (
            await api(
              'patch',
              `/suppliers/${supplierId}`,
              purchasingCookie,
              payload,
            )
          ).status,
        ).toBe(400);
      }
      const after = await prisma.supplier.findUniqueOrThrow({
        where: { id: supplierId },
      });
      expect(after.status).toBe(SupplierStatus.ACTIVE);
      expect(after.legalName).toBe(before.legalName);
      expect(
        await prisma.auditLog.count({
          where: { action: AuditAction.SUPPLIER_UPDATED, entityId: supplierId },
        }),
      ).toBe(auditBefore);
    });

    it('MANAGEMENT/ACCOUNTANT/SELLER/WAREHOUSE no crean ni editan proveedores', async () => {
      for (const cookie of [
        managementCookie,
        accountantCookie,
        sellerCookie,
        warehouseCookie,
      ]) {
        expect(
          (await api('post', '/suppliers', cookie, supplierBody())).status,
        ).toBe(403);
        expect(
          (
            await api('patch', `/suppliers/${supplierId}`, cookie, {
              tradeName: 'X',
            })
          ).status,
        ).toBe(403);
      }
    });
  });

  // =====================================================================
  // 10-16. Facturas de compra
  // =====================================================================
  describe('facturas de compra: PURCHASING crea/edita, MANAGEMENT confirma/anula', () => {
    it('10-11. PURCHASING crea (DRAFT), lee y edita una factura DRAFT, con auditoría del actor', async () => {
      const draft = await draftInvoice([goodLine(productId, '10.000')]);
      expect(draft.status).toBe('DRAFT');

      expect(
        (await api('get', '/purchase-invoices', purchasingCookie)).status,
      ).toBe(200);
      expect(
        (await api('get', `/purchase-invoices/${draft.id}`, purchasingCookie))
          .status,
      ).toBe(200);

      const edited = await api(
        'patch',
        `/purchase-invoices/${draft.id}`,
        purchasingCookie,
        { paymentTermsDays: 30 },
      );
      expect(edited.status).toBe(200);

      const createdAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.PURCHASE_INVOICE_CREATED,
          entityId: draft.id,
        },
      });
      expect(createdAudit.userId).toBe(purchasingUserId);
      const updatedAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.PURCHASE_INVOICE_UPDATED,
          entityId: draft.id,
        },
      });
      expect(updatedAudit.userId).toBe(purchasingUserId);
    });

    it('12-13. (R3) PURCHASING confirma y anula (200) con auditoría de su propio usuario', async () => {
      const draft = await draftInvoice([goodLine(productId, '1.000')]);
      const confirmed = await api(
        'post',
        `/purchase-invoices/${draft.id}/confirm`,
        purchasingCookie,
        {},
      );
      expect(confirmed.status).toBe(200);
      expect((confirmed.body as InvoiceBody).status).toBe('CONFIRMED');
      const cancelled = await api(
        'post',
        `/purchase-invoices/${draft.id}/cancel`,
        purchasingCookie,
        { reason: 'motivo' },
      );
      expect(cancelled.status).toBe(200);
      expect((cancelled.body as InvoiceBody).status).toBe('CANCELLED');
      const audits = await prisma.auditLog.findMany({
        where: {
          entityId: draft.id,
          action: {
            in: [
              AuditAction.PURCHASE_INVOICE_CONFIRMED,
              AuditAction.PURCHASE_INVOICE_CANCELLED,
            ],
          },
        },
      });
      expect(audits).toHaveLength(2);
      for (const a of audits) expect(a.userId).toBe(purchasingUserId);
    });

    it('14-15. MANAGEMENT confirma (con asiento contable) y anula (con reversión): excepción aprobada, con auditoría del actor real', async () => {
      const draft = await draftInvoice([goodLine(productId, '2.000')]);
      const confirmed = await api(
        'post',
        `/purchase-invoices/${draft.id}/confirm`,
        managementCookie,
        {},
      );
      expect(confirmed.status).toBe(200);
      const confirmedBody = confirmed.body as InvoiceBody;
      expect(confirmedBody.status).toBe('CONFIRMED');
      expect(confirmedBody.postedEntryId).not.toBeNull();

      const confirmAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.PURCHASE_INVOICE_CONFIRMED,
          entityId: draft.id,
        },
      });
      expect(confirmAudit.userId).toBe(managementUserId);

      const cancelled = await api(
        'post',
        `/purchase-invoices/${draft.id}/cancel`,
        managementCookie,
        { reason: 'Anulada por gerencia (E2E R1)' },
      );
      expect(cancelled.status).toBe(200);
      expect((cancelled.body as InvoiceBody).status).toBe('CANCELLED');
      const reversal = await prisma.accountingEntry.count({
        where: { reversesEntryId: confirmedBody.postedEntryId },
      });
      expect(reversal).toBe(1);
      const cancelAudit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.PURCHASE_INVOICE_CANCELLED,
          entityId: draft.id,
        },
      });
      expect(cancelAudit.userId).toBe(managementUserId);
    });

    it('16. MANAGEMENT no adquiere otros permisos de escritura financiera', async () => {
      const draft = await draftInvoice([goodLine(productId, '1.000')]);
      // No crea ni edita facturas
      expect(
        (await createInvoice([goodLine(productId, '1.000')], managementCookie))
          .status,
      ).toBe(403);
      expect(
        (
          await api(
            'patch',
            `/purchase-invoices/${draft.id}`,
            managementCookie,
            { paymentTermsDays: 1 },
          )
        ).status,
      ).toBe(403);
      // No recibe mercadería ni anula recepciones
      expect(
        (await receive(draft.id, draft.lines[0].id, '1.000', managementCookie))
          .status,
      ).toBe(403);
      expect(
        (
          await api(
            'post',
            `/purchase-receipts/${NON_EXISTENT_UUID}/cancel`,
            managementCookie,
            { reason: 'x' },
          )
        ).status,
      ).toBe(403);
      // No registra ni anula pagos a proveedor
      expect(
        (await api('post', '/supplier-payments', managementCookie, {})).status,
      ).toBe(403);
      expect(
        (
          await api(
            'post',
            `/supplier-payments/${NON_EXISTENT_UUID}/cancel`,
            managementCookie,
            { reason: 'x' },
          )
        ).status,
      ).toBe(403);
      // La factura no cambió
      const row = await prisma.purchaseInvoice.findUniqueOrThrow({
        where: { id: draft.id },
      });
      expect(row.status).toBe('DRAFT');
    });

    it('ACCOUNTANT/SELLER/WAREHOUSE no crean, editan, confirman ni anulan facturas', async () => {
      const draft = await draftInvoice([goodLine(productId, '1.000')]);
      for (const cookie of [accountantCookie, sellerCookie, warehouseCookie]) {
        expect(
          (await createInvoice([goodLine(productId, '1.000')], cookie)).status,
        ).toBe(403);
        expect(
          (
            await api('patch', `/purchase-invoices/${draft.id}`, cookie, {
              paymentTermsDays: 1,
            })
          ).status,
        ).toBe(403);
        expect(
          (
            await api(
              'post',
              `/purchase-invoices/${draft.id}/confirm`,
              cookie,
              {},
            )
          ).status,
        ).toBe(403);
        expect(
          (
            await api('post', `/purchase-invoices/${draft.id}/cancel`, cookie, {
              reason: 'x',
            })
          ).status,
        ).toBe(403);
      }
    });

    it('PURCHASING solo edita DRAFT: una factura CONFIRMED responde 409 (el estado no cambia)', async () => {
      const confirmed = await confirmedInvoice([goodLine(productId, '1.000')]);
      const response = await api(
        'patch',
        `/purchase-invoices/${confirmed.id}`,
        purchasingCookie,
        { paymentTermsDays: 15 },
      );
      expect(response.status).toBe(409);
      const row = await prisma.purchaseInvoice.findUniqueOrThrow({
        where: { id: confirmed.id },
      });
      expect(row.status).toBe('CONFIRMED');
    });
  });

  // =====================================================================
  // 17-19. Recepción física por WAREHOUSE (sin importes)
  // =====================================================================
  describe('WAREHOUSE: recepción física sin visibilidad financiera', () => {
    it('17-19. identifica la factura pendiente, ve cantidades, recibe parcial y totalmente sin ver importes; solo ADMIN anula la recepción', async () => {
      const dedicated = await createProductRow(prisma, {
        data: {
          sku: `R1-W-${nextSuffix()}`,
          name: `Producto almacén E2E R1`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId,
          salePrice: '50.00',
          isInventoryTracked: true,
          stockCurrent: '0.000',
          status: ProductStatus.ACTIVE,
        },
      });
      createdProductIds.push(dedicated.id);

      // Una línea elegible (bien con producto) + una de servicio (no elegible)
      const invoice = await confirmedInvoice([
        goodLine(dedicated.id, '10.000'),
        serviceLine(),
      ]);
      const goodLineId = invoice.lines.find((l) => l.productId !== null)!.id;

      // Listado de pendientes
      const list = await api(
        'get',
        '/purchase-receiving/invoices',
        warehouseCookie,
      );
      expect(list.status).toBe(200);
      expectNoFinancialData(list.body);
      const listed = (list.body as ReceivableListBody).data.find(
        (i) => i.id === invoice.id,
      );
      expect(listed).toBeDefined();
      expect(listed?.pendingLinesCount).toBe(1);
      expect(listed?.supplier.id).toBe(supplierId);

      // Detalle: solo la línea elegible, con cantidades
      const detail = await api(
        'get',
        `/purchase-receiving/invoices/${invoice.id}`,
        warehouseCookie,
      );
      expect(detail.status).toBe(200);
      expectNoFinancialData(detail.body);
      const detailBody = detail.body as ReceivableDetailBody;
      expect(detailBody.status).toBe('CONFIRMED');
      expect(detailBody.lines).toHaveLength(1);
      expect(detailBody.lines[0]).toMatchObject({
        purchaseInvoiceLineId: goodLineId,
        invoicedQuantity: '10.000',
        receivedQuantity: '0.000',
        pendingQuantity: '10.000',
        status: 'PENDING',
      });

      // Recepción parcial (4 de 10)
      const first = await receive(
        invoice.id,
        goodLineId,
        '4.000',
        warehouseCookie,
      );
      expect(first.status).toBe(201);
      expectNoFinancialData(first.body);
      expect(first.body).not.toHaveProperty('reclassificationEntryId');
      const firstBody = first.body as ReceiptBody;
      createdReceiptIds.push(firstBody.id);
      expect(firstBody.lines[0].quantity).toBe('4.000');
      expect(await stockOf(dedicated.id)).toBe('4.000');

      const partial = await api(
        'get',
        `/purchase-receiving/invoices/${invoice.id}`,
        warehouseCookie,
      );
      expect((partial.body as ReceivableDetailBody).lines[0]).toMatchObject({
        receivedQuantity: '4.000',
        pendingQuantity: '6.000',
        status: 'PARTIAL',
      });
      const stillListed = await api(
        'get',
        '/purchase-receiving/invoices',
        warehouseCookie,
      );
      expect(
        (stillListed.body as ReceivableListBody).data.some(
          (i) => i.id === invoice.id,
        ),
      ).toBe(true);

      // Lecturas de recepción por las rutas existentes: también sin importes
      const history = await api(
        'get',
        `/purchase-invoices/${invoice.id}/receipts`,
        warehouseCookie,
      );
      expect(history.status).toBe(200);
      expectNoFinancialData(history.body);
      const one = await api(
        'get',
        `/purchase-receipts/${firstBody.id}`,
        warehouseCookie,
      );
      expect(one.status).toBe(200);
      expectNoFinancialData(one.body);
      expect(one.body).not.toHaveProperty('reclassificationEntryId');

      // Mismas rutas para ADMIN: conservan los campos financieros actuales
      const adminView = await api(
        'get',
        `/purchase-receipts/${firstBody.id}`,
        adminCookie,
      );
      expect(adminView.body).toHaveProperty('reclassificationEntryId', null);
      expect(
        (adminView.body as { lines: Record<string, unknown>[] }).lines[0],
      ).toHaveProperty('reclassifiedAmount', null);

      // Completar la recepción
      const second = await receive(
        invoice.id,
        goodLineId,
        '6.000',
        warehouseCookie,
      );
      expect(second.status).toBe(201);
      const secondBody = second.body as ReceiptBody;
      createdReceiptIds.push(secondBody.id);
      expect(await stockOf(dedicated.id)).toBe('10.000');
      const complete = await api(
        'get',
        `/purchase-receiving/invoices/${invoice.id}`,
        warehouseCookie,
      );
      expect((complete.body as ReceivableDetailBody).lines[0]).toMatchObject({
        pendingQuantity: '0.000',
        status: 'COMPLETE',
      });
      expect((complete.body as ReceivableDetailBody).pendingLinesCount).toBe(0);
      const afterComplete = await api(
        'get',
        '/purchase-receiving/invoices',
        warehouseCookie,
      );
      expect(
        (afterComplete.body as ReceivableListBody).data.some(
          (i) => i.id === invoice.id,
        ),
      ).toBe(false);

      // Sobre-recepción: 409, el stock no cambia
      expect(
        (await receive(invoice.id, goodLineId, '1.000', warehouseCookie))
          .status,
      ).toBe(409);
      expect(await stockOf(dedicated.id)).toBe('10.000');

      // WAREHOUSE no anula la recepción (403, nada cambia)
      expect(
        (
          await api(
            'post',
            `/purchase-receipts/${secondBody.id}/cancel`,
            warehouseCookie,
            { reason: 'intento' },
          )
        ).status,
      ).toBe(403);
      expect(await stockOf(dedicated.id)).toBe('10.000');

      // ADMIN anula: la cantidad vuelve a quedar pendiente (solo cuentan ACTIVE)
      const cancelled = await api(
        'post',
        `/purchase-receipts/${secondBody.id}/cancel`,
        adminCookie,
        { reason: 'Anulación E2E R1' },
      );
      expect(cancelled.status).toBe(200);
      expect(await stockOf(dedicated.id)).toBe('4.000');
      const reopened = await api(
        'get',
        `/purchase-receiving/invoices/${invoice.id}`,
        warehouseCookie,
      );
      expect((reopened.body as ReceivableDetailBody).lines[0]).toMatchObject({
        receivedQuantity: '4.000',
        pendingQuantity: '6.000',
        status: 'PARTIAL',
      });

      // Auditoría: el actor de la recepción es WAREHOUSE
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.PURCHASE_RECEIPT_CREATED,
          entityId: firstBody.id,
        },
      });
      expect(audit.userId).toBe(warehouseUserId);
    });

    it('R1-A. varias líneas elegibles pendientes: listado y detalle coinciden en cada etapa y las recepciones anuladas no cuentan', async () => {
      const makeProduct = async (slot: string) => {
        const product = await createProductRow(prisma, {
          data: {
            sku: `R1-M-${slot}-${nextSuffix()}`,
            name: `Producto multilínea ${slot} E2E R1`,
            productType: ProductType.PRODUCT,
            categoryId,
            unitId,
            salePrice: '50.00',
            isInventoryTracked: true,
            stockCurrent: '0.000',
            status: ProductStatus.ACTIVE,
          },
        });
        createdProductIds.push(product.id);
        return product;
      };
      const productOne = await makeProduct('1');
      const productTwo = await makeProduct('2');

      // 2 líneas elegibles (8 y 5) + 1 servicio no elegible
      const invoice = await confirmedInvoice([
        goodLine(productOne.id, '8.000'),
        goodLine(productTwo.id, '5.000'),
        serviceLine(),
      ]);
      const lineOne = invoice.lines.find(
        (l) => l.productId === productOne.id,
      )!.id;
      const lineTwo = invoice.lines.find(
        (l) => l.productId === productTwo.id,
      )!.id;

      type Expected = Record<
        string,
        { invoiced: string; received: string; pending: string; status: string }
      >;
      /** Verifica detalle y listado contra el mismo estado esperado. */
      const expectState = async (
        expected: Expected,
        pendingLines: number,
      ): Promise<void> => {
        const detail = await api(
          'get',
          `/purchase-receiving/invoices/${invoice.id}`,
          warehouseCookie,
        );
        expect(detail.status).toBe(200);
        expectNoFinancialData(detail.body);
        const body = detail.body as ReceivableDetailBody;
        expect(body.lines).toHaveLength(2);
        expect(body.pendingLinesCount).toBe(pendingLines);
        for (const [lineId, values] of Object.entries(expected)) {
          const line = body.lines.find(
            (l) => l.purchaseInvoiceLineId === lineId,
          );
          expect(line).toMatchObject({
            invoicedQuantity: values.invoiced,
            receivedQuantity: values.received,
            pendingQuantity: values.pending,
            status: values.status,
          });
        }
        const list = await api(
          'get',
          '/purchase-receiving/invoices?limit=100',
          warehouseCookie,
        );
        expect(list.status).toBe(200);
        const listed = (list.body as ReceivableListBody).data.find(
          (i) => i.id === invoice.id,
        );
        if (pendingLines === 0) {
          expect(listed).toBeUndefined();
        } else {
          expect(listed?.pendingLinesCount).toBe(pendingLines);
        }
      };

      // 1) Ambas pendientes
      await expectState(
        {
          [lineOne]: {
            invoiced: '8.000',
            received: '0.000',
            pending: '8.000',
            status: 'PENDING',
          },
          [lineTwo]: {
            invoiced: '5.000',
            received: '0.000',
            pending: '5.000',
            status: 'PENDING',
          },
        },
        2,
      );

      // 2) Recepción anulada: no cuenta (3 de la línea 1, luego anulada)
      const toCancel = await receive(
        invoice.id,
        lineOne,
        '3.000',
        warehouseCookie,
      );
      expect(toCancel.status).toBe(201);
      const toCancelId = (toCancel.body as ReceiptBody).id;
      createdReceiptIds.push(toCancelId);
      expect(
        (
          await api(
            'post',
            `/purchase-receipts/${toCancelId}/cancel`,
            adminCookie,
            { reason: 'Anulación E2E R1-A' },
          )
        ).status,
      ).toBe(200);
      await expectState(
        {
          [lineOne]: {
            invoiced: '8.000',
            received: '0.000',
            pending: '8.000',
            status: 'PENDING',
          },
          [lineTwo]: {
            invoiced: '5.000',
            received: '0.000',
            pending: '5.000',
            status: 'PENDING',
          },
        },
        2,
      );

      // 3) Parcial en ambas líneas (2 de 8 y 1 de 5): sigue habiendo 2 pendientes
      const partialOne = await receive(
        invoice.id,
        lineOne,
        '2.000',
        warehouseCookie,
      );
      const partialTwo = await receive(
        invoice.id,
        lineTwo,
        '1.000',
        warehouseCookie,
      );
      expect(partialOne.status).toBe(201);
      expect(partialTwo.status).toBe(201);
      createdReceiptIds.push((partialOne.body as ReceiptBody).id);
      createdReceiptIds.push((partialTwo.body as ReceiptBody).id);
      await expectState(
        {
          [lineOne]: {
            invoiced: '8.000',
            received: '2.000',
            pending: '6.000',
            status: 'PARTIAL',
          },
          [lineTwo]: {
            invoiced: '5.000',
            received: '1.000',
            pending: '4.000',
            status: 'PARTIAL',
          },
        },
        2,
      );

      // 4) Se completa la línea 1: queda 1 pendiente
      const completeOne = await receive(
        invoice.id,
        lineOne,
        '6.000',
        warehouseCookie,
      );
      expect(completeOne.status).toBe(201);
      const completeOneId = (completeOne.body as ReceiptBody).id;
      createdReceiptIds.push(completeOneId);
      await expectState(
        {
          [lineOne]: {
            invoiced: '8.000',
            received: '8.000',
            pending: '0.000',
            status: 'COMPLETE',
          },
          [lineTwo]: {
            invoiced: '5.000',
            received: '1.000',
            pending: '4.000',
            status: 'PARTIAL',
          },
        },
        1,
      );

      // 5) Se completa también la línea 2: la factura sale del listado
      const completeTwo = await receive(
        invoice.id,
        lineTwo,
        '4.000',
        warehouseCookie,
      );
      expect(completeTwo.status).toBe(201);
      createdReceiptIds.push((completeTwo.body as ReceiptBody).id);
      await expectState(
        {
          [lineOne]: {
            invoiced: '8.000',
            received: '8.000',
            pending: '0.000',
            status: 'COMPLETE',
          },
          [lineTwo]: {
            invoiced: '5.000',
            received: '5.000',
            pending: '0.000',
            status: 'COMPLETE',
          },
        },
        0,
      );

      // 6) Anular la recepción que completó la línea 1 la reabre (solo ACTIVE cuentan)
      expect(
        (
          await api(
            'post',
            `/purchase-receipts/${completeOneId}/cancel`,
            adminCookie,
            { reason: 'Reapertura E2E R1-A' },
          )
        ).status,
      ).toBe(200);
      await expectState(
        {
          [lineOne]: {
            invoiced: '8.000',
            received: '2.000',
            pending: '6.000',
            status: 'PARTIAL',
          },
          [lineTwo]: {
            invoiced: '5.000',
            received: '5.000',
            pending: '0.000',
            status: 'COMPLETE',
          },
        },
        1,
      );
    });

    it('R1-B. paginación real: total, páginas 1..N, orden estable, sin duplicados ni omisiones', async () => {
      const pagedProduct = await createProductRow(prisma, {
        data: {
          sku: `R1-P-${nextSuffix()}`,
          name: 'Producto paginación E2E R1',
          productType: ProductType.PRODUCT,
          categoryId,
          unitId,
          salePrice: '50.00',
          isInventoryTracked: true,
          stockCurrent: '0.000',
          status: ProductStatus.ACTIVE,
        },
      });
      createdProductIds.push(pagedProduct.id);

      // 5 facturas elegibles con pendiente (superan el límite de página = 2)
      const eligibleIds: string[] = [];
      for (let i = 0; i < 5; i += 1) {
        const invoice = await confirmedInvoice([
          goodLine(pagedProduct.id, '2.000'),
        ]);
        eligibleIds.push(invoice.id);
      }
      // Excluida 1: completamente recibida
      const received = await confirmedInvoice([
        goodLine(pagedProduct.id, '1.000'),
      ]);
      expect(
        (
          await receive(
            received.id,
            received.lines[0].id,
            '1.000',
            warehouseCookie,
          )
        ).status,
      ).toBe(201);
      // Excluida 2: DRAFT
      const draft = await draftInvoice([goodLine(pagedProduct.id, '1.000')]);
      // Excluida 3: solo servicio (ninguna línea elegible)
      const serviceOnly = await confirmedInvoice([serviceLine()]);
      // Excluida 4: CANCELLED
      const cancelled = await confirmedInvoice([
        goodLine(pagedProduct.id, '1.000'),
      ]);
      expect(
        (
          await api(
            'post',
            `/purchase-invoices/${cancelled.id}/cancel`,
            managementCookie,
            { reason: 'Excluida de la paginación E2E R1-B' },
          )
        ).status,
      ).toBe(200);
      const excluded = [received.id, draft.id, serviceOnly.id, cancelled.id];

      // Verdad independiente: se calcula con Prisma (no con la consulta SQL bajo prueba)
      const eligibleLines = await prisma.purchaseInvoiceLine.findMany({
        where: {
          isReceiptEligible: true,
          purchaseInvoice: { status: 'CONFIRMED' },
        },
        select: { id: true, quantity: true, purchaseInvoiceId: true },
      });
      const receivedByLine = await prisma.purchaseReceiptLine.groupBy({
        by: ['purchaseInvoiceLineId'],
        where: { purchaseReceipt: { status: 'ACTIVE' } },
        _sum: { quantity: true },
      });
      const receivedMap = new Map(
        receivedByLine.map((r) => [
          r.purchaseInvoiceLineId,
          r._sum.quantity?.toString() ?? '0',
        ]),
      );
      const pendingInvoiceIds = new Set(
        eligibleLines
          .filter(
            (l) => Number(l.quantity) > Number(receivedMap.get(l.id) ?? 0),
          )
          .map((l) => l.purchaseInvoiceId),
      );
      const ordered = await prisma.purchaseInvoice.findMany({
        where: { id: { in: [...pendingInvoiceIds] } },
        orderBy: [{ issueDate: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      const expectedIds = ordered.map((i) => i.id);
      for (const id of eligibleIds) {
        expect(expectedIds).toContain(id);
      }
      for (const id of excluded) {
        expect(expectedIds).not.toContain(id);
      }

      interface PagedBody extends ReceivableListBody {
        page: number;
        limit: number;
        totalPages: number;
      }
      const limit = 2;
      const expectedPages = Math.ceil(expectedIds.length / limit);
      expect(expectedPages).toBeGreaterThanOrEqual(3);

      const collected: string[] = [];
      for (let page = 1; page <= expectedPages; page += 1) {
        const response = await api(
          'get',
          `/purchase-receiving/invoices?page=${page}&limit=${limit}`,
          warehouseCookie,
        );
        expect(response.status).toBe(200);
        expectNoFinancialData(response.body);
        const body = response.body as PagedBody;
        expect(body.total).toBe(expectedIds.length);
        expect(body.page).toBe(page);
        expect(body.limit).toBe(limit);
        expect(body.totalPages).toBe(expectedPages);
        const expectedSize =
          page < expectedPages
            ? limit
            : expectedIds.length - limit * (expectedPages - 1);
        expect(body.data).toHaveLength(expectedSize);
        for (const item of body.data) {
          expect(item.pendingLinesCount).toBeGreaterThanOrEqual(1);
        }
        collected.push(...body.data.map((i) => i.id));
      }

      // Sin duplicados, sin omisiones, con el mismo orden determinista
      expect(new Set(collected).size).toBe(collected.length);
      expect(collected).toEqual(expectedIds);
      for (const id of excluded) {
        expect(collected).not.toContain(id);
      }

      // Una página posterior a la última: vacía, con el mismo total
      const beyond = await api(
        'get',
        `/purchase-receiving/invoices?page=${expectedPages + 1}&limit=${limit}`,
        warehouseCookie,
      );
      expect(beyond.status).toBe(200);
      expect((beyond.body as PagedBody).data).toHaveLength(0);
      expect((beyond.body as PagedBody).total).toBe(expectedIds.length);

      // Estabilidad: repetir la página 1 devuelve lo mismo
      const again = await api(
        'get',
        `/purchase-receiving/invoices?page=1&limit=${limit}`,
        warehouseCookie,
      );
      expect((again.body as PagedBody).data.map((i) => i.id)).toEqual(
        expectedIds.slice(0, limit),
      );
    }, 60000);

    it('rutas de recepción: sin conflicto con rutas parametrizadas, DRAFT → 409, inexistente → 404', async () => {
      const draft = await draftInvoice([goodLine(productId, '1.000')]);
      expect(
        (
          await api(
            'get',
            `/purchase-receiving/invoices/${draft.id}`,
            warehouseCookie,
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await api(
            'get',
            `/purchase-receiving/invoices/${NON_EXISTENT_UUID}`,
            warehouseCookie,
          )
        ).status,
      ).toBe(404);
      expect(
        (
          await api(
            'get',
            '/purchase-receiving/invoices/no-es-uuid',
            warehouseCookie,
          )
        ).status,
      ).toBe(400);
      // Una factura DRAFT jamás aparece como pendiente de recepción
      const list = await api(
        'get',
        '/purchase-receiving/invoices',
        warehouseCookie,
      );
      expect(
        (list.body as ReceivableListBody).data.some((i) => i.id === draft.id),
      ).toBe(false);
    });

    it('(R3) vistas de recepción: ADMIN/MANAGEMENT/ACCOUNTANT/PURCHASING leen (200); nunca SELLER', async () => {
      for (const cookie of [
        adminCookie,
        managementCookie,
        accountantCookie,
        purchasingCookie,
      ]) {
        expect(
          (await api('get', '/purchase-receiving/invoices', cookie)).status,
        ).toBe(200);
      }
      expect(
        (await api('get', '/purchase-receiving/invoices', sellerCookie)).status,
      ).toBe(403);
      expect(
        (
          await api(
            'get',
            `/purchase-receiving/invoices/${NON_EXISTENT_UUID}`,
            sellerCookie,
          )
        ).status,
      ).toBe(403);
    });

    it('WAREHOUSE no abre facturas ni proveedores ni cuentas por pagar', async () => {
      const draft = await draftInvoice([goodLine(productId, '1.000')]);
      expect(
        (await api('get', '/purchase-invoices', warehouseCookie)).status,
      ).toBe(403);
      expect(
        (await api('get', `/purchase-invoices/${draft.id}`, warehouseCookie))
          .status,
      ).toBe(403);
      expect((await api('get', '/suppliers', warehouseCookie)).status).toBe(
        403,
      );
      expect(
        (await api('get', '/accounts-payable', warehouseCookie)).status,
      ).toBe(403);
      expect(
        (await api('get', '/supplier-payments', warehouseCookie)).status,
      ).toBe(403);
    });

    it('(R3) PURCHASING lee recepciones (vista completa), registra y anula', async () => {
      const invoice = await confirmedInvoice([
        goodLine(secondProductId, '3.000'),
      ]);
      const lineId = invoice.lines[0].id;
      const created = await receive(invoice.id, lineId, '1.000', adminCookie);
      expect(created.status).toBe(201);
      const receipt = created.body as ReceiptBody;
      createdReceiptIds.push(receipt.id);

      expect(
        (
          await api(
            'get',
            `/purchase-invoices/${invoice.id}/receipts`,
            purchasingCookie,
          )
        ).status,
      ).toBe(200);
      const detail = await api(
        'get',
        `/purchase-receipts/${receipt.id}`,
        purchasingCookie,
      );
      expect(detail.status).toBe(200);
      expect(detail.body).toHaveProperty('reclassificationEntryId');

      const own = await receive(invoice.id, lineId, '1.000', purchasingCookie);
      expect(own.status).toBe(201);
      createdReceiptIds.push((own.body as ReceiptBody).id);
      expect(
        (
          await api(
            'post',
            `/purchase-receipts/${receipt.id}/cancel`,
            purchasingCookie,
            { reason: 'x' },
          )
        ).status,
      ).toBe(200);
    });
  });

  // =====================================================================
  // 20-24. Cuentas por pagar y operaciones prohibidas
  // =====================================================================
  describe('PURCHASING: cuentas por pagar (solo lectura) y operaciones prohibidas', () => {
    it('20. lee cuentas por pagar y todos sus reportes y exportaciones GET', async () => {
      for (const path of [
        '',
        '/summary',
        '/aging',
        '/reconciliation',
        '/export.xlsx',
        '/summary/export.xlsx',
        '/aging/export.xlsx',
        '/reconciliation/export.xlsx',
      ]) {
        const response = await api(
          'get',
          `/accounts-payable${path}`,
          purchasingCookie,
        );
        expect(response.status).toBe(200);
      }
    });

    it('21. (R3) accede a pagos a proveedores: ninguna ruta responde 403', async () => {
      expect(
        (await api('get', '/supplier-payments', purchasingCookie)).status,
      ).toBe(200);
      expect(
        (
          await api(
            'get',
            `/supplier-payments/${NON_EXISTENT_UUID}`,
            purchasingCookie,
          )
        ).status,
      ).toBe(404);
      expect(
        (await api('post', '/supplier-payments', purchasingCookie, {})).status,
      ).toBe(400);
      expect(
        (
          await api(
            'post',
            `/supplier-payments/${NON_EXISTENT_UUID}/cancel`,
            purchasingCookie,
            { reason: 'x' },
          )
        ).status,
      ).toBe(404);
    });

    it('22. no administra usuarios ni roles', async () => {
      expect((await api('get', '/users', purchasingCookie)).status).toBe(403);
      expect((await api('post', '/users', purchasingCookie, {})).status).toBe(
        403,
      );
      expect(
        (
          await api('patch', `/users/${purchasingUserId}`, purchasingCookie, {
            roleNames: [RoleName.ADMIN],
          })
        ).status,
      ).toBe(403);
      expect((await api('get', '/roles', purchasingCookie)).status).toBe(403);
      // La tentativa de auto-escalada no cambió nada
      const roles = await prisma.userRole.count({
        where: { userId: purchasingUserId },
      });
      expect(roles).toBe(1);
    });

    it('23. no escribe ni lee inventario', async () => {
      expect(
        (await api('get', '/inventory/movements', purchasingCookie)).status,
      ).toBe(403);
      for (const path of [
        '/inventory/entries',
        '/inventory/exits',
        '/inventory/initial-balances',
        '/inventory/adjustments/in',
        '/inventory/adjustments/out',
      ]) {
        expect(
          (await api('post', path, purchasingCookie, { productId })).status,
        ).toBe(403);
      }
    });

    it('24. endpoints alternativos: contabilidad, ventas, clientes y configuración siguen cerrados (importaciones y pagos a proveedores se abrieron en R3)', async () => {
      for (const [method, path] of [
        ['get', '/accounting/entries'],
        ['get', '/chart-of-accounts'],
        ['post', '/accounting/manual-entries'],
        ['get', '/accounting/periods'],
        ['get', '/sales'],
        ['get', '/quotes'],
        ['get', '/customers'],
        ['get', '/payments'],
        ['get', '/dashboard'],
        ['get', '/audit-logs'],
        ['get', '/electronic-documents'],
      ] as const) {
        const response = await api(method, path, purchasingCookie, {});
        expect([403, 404]).toContain(response.status);
        if (response.status === 404) {
          // una ruta que no existe nunca cuenta como acceso concedido
          expect(response.status).not.toBe(200);
        }
      }
      // Las rutas existentes de verdad responden 403 (no 404): comprobación estricta.
      for (const path of [
        '/accounting/entries',
        '/chart-of-accounts',
        '/accounting/periods',
        '/sales',
        '/quotes',
        '/customers',
        '/payments',
        '/dashboard',
      ]) {
        expect((await api('get', path, purchasingCookie)).status).toBe(403);
      }
    });

    it('sin sesión: 401 en las rutas nuevas y modificadas', async () => {
      for (const path of [
        '/purchase-receiving/invoices',
        '/suppliers',
        '/purchase-invoices',
        '/accounts-payable',
      ]) {
        expect(
          (await request(app.getHttpServer()).get(`/api/v1${path}`)).status,
        ).toBe(401);
      }
    });
  });

  // =====================================================================
  // 25. Regresión de los demás roles
  // =====================================================================
  describe('regresión: ADMIN, SELLER, ACCOUNTANT y demás roles conservan su comportamiento', () => {
    it('ADMIN conserva acceso completo (facturas, recepciones, proveedores, usuarios)', async () => {
      const invoice = await confirmedInvoice([
        goodLine(secondProductId, '2.000'),
      ]);
      const receipt = await receive(
        invoice.id,
        invoice.lines[0].id,
        '2.000',
        adminCookie,
      );
      expect(receipt.status).toBe(201);
      createdReceiptIds.push((receipt.body as ReceiptBody).id);
      expect((await api('get', '/users', adminCookie)).status).toBe(200);
      expect((await api('get', '/suppliers', adminCookie)).status).toBe(200);
      expect((await api('get', '/supplier-payments', adminCookie)).status).toBe(
        200,
      );
      const adminDraft = await createInvoice(
        [goodLine(productId, '1.000')],
        adminCookie,
      );
      expect(adminDraft.status).toBe(201);
      createdInvoiceIds.push((adminDraft.body as InvoiceBody).id);
    });

    it('ACCOUNTANT conserva lectura de compras, recepciones y cuentas por pagar; sin escritura', async () => {
      for (const path of [
        '/suppliers',
        '/purchase-invoices',
        '/accounts-payable',
        '/supplier-payments',
        '/purchase-receiving/invoices',
      ]) {
        expect((await api('get', path, accountantCookie)).status).toBe(200);
      }
    });

    it('SELLER no obtiene ningún acceso a compras, recepciones ni cuentas por pagar', async () => {
      for (const path of [
        '/suppliers',
        '/purchase-invoices',
        '/accounts-payable',
        '/supplier-payments',
        '/purchase-receiving/invoices',
      ]) {
        expect((await api('get', path, sellerCookie)).status).toBe(403);
      }
      // y conserva su acceso comercial
      expect((await api('get', '/products', sellerCookie)).status).toBe(200);
    });

    it('MANAGEMENT conserva su lectura global (compras, cuentas por pagar)', async () => {
      for (const path of [
        '/suppliers',
        '/purchase-invoices',
        '/accounts-payable',
        '/supplier-payments',
      ]) {
        expect((await api('get', path, managementCookie)).status).toBe(200);
      }
    });
  });
});
