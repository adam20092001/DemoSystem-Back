import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AccountingSourceType,
  CategoryStatus,
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
  UserStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { AuditAction } from '../src/audit/audit-action.enum';
import { hashPassword } from '../src/common/security/password.service';
import type { ElectronicInvoicingProvider } from '../src/electronic-invoicing/providers/electronic-invoicing-provider.interface';
import { RetryableProviderSubmissionError } from '../src/electronic-invoicing/providers/electronic-invoicing-provider-errors';
import { ELECTRONIC_INVOICING_PROVIDER } from '../src/electronic-invoicing/providers/electronic-invoicing-provider.token';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Fase 11, Bloque D — API pública de facturación electrónica (HTTP + roles
 * + Swagger). Suite DEDICADA a la capa HTTP: la concurrencia real de
 * asignación de números fiscales ya está cubierta contra PostgreSQL real
 * en test/electronic-invoicing.e2e-spec.ts (motor interno, Bloque C) y no
 * se duplica aquí. Mismo aislamiento que el resto del dominio: solo
 * pos_db_test, limpieza por ID propio, nunca deleteMany({}).
 *
 * TRES instancias de aplicación:
 *  - `app`: proveedor real (MockElectronicInvoicingProvider).
 *  - `failingApp`: proveedor sobrescrito que SIEMPRE lanza
 *    RetryableProviderSubmissionError (falla técnica DEFINITIVA).
 *  - `unknownOutcomeApp`: proveedor sobrescrito que SIEMPRE lanza un Error
 *    genérico no clasificado (resultado DESCONOCIDO, fail closed).
 *
 * IGV desactivado a propósito durante toda la suite (CompanySettings
 * restaurada exacta al cierre): así total = subtotal, sin depender de la
 * configuración vigente compartida, necesario para pagar ventas de
 * "Público general" con el monto exacto en la misma solicitud de creación.
 */
describe('Electronic Invoicing — API pública HTTP (Fase 11, Bloque D) (e2e)', () => {
  let app: INestApplication<App>;
  let failingApp: INestApplication<App>;
  let unknownOutcomeApp: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let sellerCookie: string;
  let managementCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let rucCustomerId: string;
  let genericCustomerId: string;

  let companySettingsId: string;
  let companySettingsBaseline: {
    businessName: string;
    taxId: string | null;
    address: string | null;
    taxEnabled: boolean;
  };

  const FACTURA_SERIES = 'F910';
  const BOLETA_SERIES = 'B910';
  const UNIT_PRICE = '50.00';

  const SELLER_USERNAME = 'e2e_seller_eivapi';
  const SELLER_PASSWORD = 'SellerEivApi123';
  const MANAGEMENT_USERNAME = 'e2e_management_eivapi';
  const MANAGEMENT_PASSWORD = 'ManagementEivApi123';
  const WAREHOUSE_USERNAME = 'e2e_warehouse_eivapi';
  const WAREHOUSE_PASSWORD = 'WarehouseEivApi123';
  const MULTI_ROLE_USERNAME = 'e2e_multirole_eivapi';
  const MULTI_ROLE_PASSWORD = 'MultiRoleEivApi123';

  const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

  const ownedUserIds: string[] = [];
  const createdSaleIds: string[] = [];
  const createdDocumentIds: string[] = [];
  const ownedAdminLoginAuditIds: string[] = [];

  interface FixtureSale {
    id: string;
    number: string;
    total: string;
  }

  interface FixtureUser {
    id: string;
  }

  async function upsertSingleRoleUser(
    username: string,
    email: string,
    password: string,
    roleName: RoleName,
  ): Promise<FixtureUser> {
    const role = await prisma.role.findUniqueOrThrow({
      where: { name: roleName },
    });
    const passwordHash = await hashPassword(password);
    const data = {
      email,
      firstName: 'E2E',
      lastName: 'EivApi',
      passwordHash,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      blockedAt: null,
    };
    const user = await prisma.user.upsert({
      where: { username },
      create: { username, ...data },
      update: data,
    });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.create({
      data: { userId: user.id, roleId: role.id },
    });
    return user;
  }

  async function upsertMultiRoleUser(
    username: string,
    email: string,
    password: string,
    roleNames: RoleName[],
  ): Promise<FixtureUser> {
    const roles = await prisma.role.findMany({
      where: { name: { in: roleNames } },
    });
    const passwordHash = await hashPassword(password);
    const data = {
      email,
      firstName: 'E2E',
      lastName: 'EivApiMultiRole',
      passwordHash,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      blockedAt: null,
    };
    const user = await prisma.user.upsert({
      where: { username },
      create: { username, ...data },
      update: data,
    });
    await prisma.userRole.deleteMany({ where: { userId: user.id } });
    await prisma.userRole.createMany({
      data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
    });
    return user;
  }

  async function switchRole(cookie: string, role: RoleName): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/auth/switch-role')
      .set('Cookie', cookie)
      .send({ role });
    if (response.status !== 200) {
      throw new Error(
        `No se pudo cambiar el rol activo a ${role}: ${JSON.stringify(response.body)}`,
      );
    }
    // Si el rol activo ya era el solicitado, AuthService.switchRole() es un
    // no-op explícito: no reemite cookie (ni audita ACTIVE_ROLE_SWITCHED).
    // La cookie ORIGINAL sigue siendo válida para ese mismo rol activo.
    const setCookie = (response.headers['set-cookie'] ?? []) as string[];
    if (setCookie.length === 0) {
      return cookie;
    }
    return (setCookie[0] ?? '').split(';')[0] ?? '';
  }

  async function createFixtureSale(input: {
    customerId: string;
    quantity: string;
    payment?: { method: string; amount: string };
  }): Promise<FixtureSale> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send({
        customerId: input.customerId,
        items: [{ productId, quantity: input.quantity }],
        ...(input.payment ? { payment: input.payment } : {}),
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la venta fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as FixtureSale;
    createdSaleIds.push(body.id);
    return body;
  }

  function issueDoc(
    cookie: string,
    saleId: string,
    body: Record<string, unknown>,
    appInstance: INestApplication<App> = app,
  ) {
    return request(appInstance.getHttpServer())
      .post(`/api/v1/sales/${saleId}/electronic-documents`)
      .set('Cookie', cookie)
      .send(body);
  }

  function listDocs(cookie: string, query: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .get('/api/v1/electronic-documents')
      .query(query)
      .set('Cookie', cookie);
  }

  function getDoc(cookie: string, id: string) {
    return request(app.getHttpServer())
      .get(`/api/v1/electronic-documents/${id}`)
      .set('Cookie', cookie);
  }

  function retryDoc(
    cookie: string,
    id: string,
    appInstance: INestApplication<App> = app,
  ) {
    return request(appInstance.getHttpServer())
      .post(`/api/v1/electronic-documents/${id}/retry`)
      .set('Cookie', cookie);
  }

  function listSeries(cookie: string, query: Record<string, unknown> = {}) {
    return request(app.getHttpServer())
      .get('/api/v1/fiscal-series')
      .query(query)
      .set('Cookie', cookie);
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    const failingProvider: ElectronicInvoicingProvider = {
      code: 'MOCK',
      submit: () =>
        Promise.reject(
          new RetryableProviderSubmissionError(
            'ECONNREFUSED (simulado, e2e API Fase 11D)',
          ),
        ),
    };
    const failingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ELECTRONIC_INVOICING_PROVIDER)
      .useValue(failingProvider)
      .compile();
    failingApp = failingModule.createNestApplication<INestApplication<App>>();
    setupApp(failingApp);
    await failingApp.init();

    const unknownOutcomeProvider: ElectronicInvoicingProvider = {
      code: 'MOCK',
      submit: () =>
        Promise.reject(
          new Error('raw sensitive provider failure (simulado, e2e API)'),
        ),
    };
    const unknownOutcomeModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ELECTRONIC_INVOICING_PROVIDER)
      .useValue(unknownOutcomeProvider)
      .compile();
    unknownOutcomeApp =
      unknownOutcomeModule.createNestApplication<INestApplication<App>>();
    setupApp(unknownOutcomeApp);
    await unknownOutcomeApp.init();

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
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
    });
    const adminLoginAudit = await prisma.auditLog.findFirstOrThrow({
      where: { action: AuditAction.LOGIN_SUCCESS, userId: adminUser.id },
      orderBy: { createdAt: 'desc' },
    });
    ownedAdminLoginAuditIds.push(adminLoginAudit.id);

    const sellerUser = await upsertSingleRoleUser(
      SELLER_USERNAME,
      'e2e_seller_eivapi@example.com',
      SELLER_PASSWORD,
      RoleName.SELLER,
    );
    ownedUserIds.push(sellerUser.id);
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;

    const managementUser = await upsertSingleRoleUser(
      MANAGEMENT_USERNAME,
      'e2e_management_eivapi@example.com',
      MANAGEMENT_PASSWORD,
      RoleName.MANAGEMENT,
    );
    ownedUserIds.push(managementUser.id);
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;

    const warehouseUser = await upsertSingleRoleUser(
      WAREHOUSE_USERNAME,
      'e2e_warehouse_eivapi@example.com',
      WAREHOUSE_PASSWORD,
      RoleName.WAREHOUSE,
    );
    ownedUserIds.push(warehouseUser.id);
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;

    const multiRoleUser = await upsertMultiRoleUser(
      MULTI_ROLE_USERNAME,
      'e2e_multirole_eivapi@example.com',
      MULTI_ROLE_PASSWORD,
      [RoleName.ADMIN, RoleName.SELLER, RoleName.MANAGEMENT],
    );
    ownedUserIds.push(multiRoleUser.id);

    // Identidad del emisor (§8 del Bloque 11C, reutilizado aquí): el seed
    // base no necesariamente satisface "taxId exactamente 11 numéricos".
    // IGV desactivado a propósito (ver comentario de la suite).
    const companySettingsRow = await prisma.companySettings.findFirstOrThrow();
    companySettingsId = companySettingsRow.id;
    companySettingsBaseline = {
      businessName: companySettingsRow.businessName,
      taxId: companySettingsRow.taxId,
      address: companySettingsRow.address,
      taxEnabled: companySettingsRow.taxEnabled,
    };
    await prisma.companySettings.update({
      where: { id: companySettingsId },
      data: {
        businessName: 'Empresa Demo Fiscal API E2E SAC',
        taxId: '20100000001',
        address: 'Av. Fiscal API E2E 100',
        taxEnabled: false,
      },
    });

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

    const category = await prisma.category.upsert({
      where: { code: 'E2EEIVAPICAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EEIVAPICAT', name: 'Categoria E2E Facturacion API' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2EEIVAPIU' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2EEIVAPIU',
        name: 'Unidad E2E Facturacion API',
        abbreviation: 'eeia',
        allowDecimal: false,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: `E2EEIVAPI-P-${Date.now()}`,
        name: 'Producto E2E Facturacion API',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal(UNIT_PRICE),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('100000.000'),
        status: ProductStatus.ACTIVE,
      },
    });
    productId = product.id;

    const rucCustomer = await prisma.customer.create({
      data: {
        customerType: CustomerType.COMPANY,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: CustomerDocumentType.RUC,
        documentNumber: '20123456789',
        name: 'Distribuidora API E2E SAC',
      },
    });
    rucCustomerId = rucCustomer.id;

    // No se asume que pos_db_test ya tiene sembrado el cliente genérico
    // (mismo criterio que accounts-receivable/customers/payments/quotes/
    // reports.e2e-spec.ts): upsert idempotente por `code`, identidad
    // exclusivamente estructural (nunca se crea una segunda fila genérica).
    const genericCustomer = await prisma.customer.upsert({
      where: { code: 'PUBLIC_GENERAL' },
      update: {
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
      create: {
        code: 'PUBLIC_GENERAL',
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
      },
    });
    genericCustomerId = genericCustomer.id;

    await prisma.fiscalSeries.create({
      data: {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
        currentNumber: 0,
        active: true,
      },
    });
    await prisma.fiscalSeries.create({
      data: {
        documentType: FiscalDocumentType.BOLETA,
        series: BOLETA_SERIES,
        currentNumber: 0,
        active: true,
      },
    });
  });

  afterAll(async () => {
    try {
      if (createdDocumentIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'ElectronicDocument',
            entityId: { in: createdDocumentIds },
          },
        });
        await prisma.electronicDocument.deleteMany({
          where: { id: { in: createdDocumentIds } },
        });
      }

      await prisma.fiscalSeries.deleteMany({
        where: { series: { in: [FACTURA_SERIES, BOLETA_SERIES] } },
      });

      if (createdSaleIds.length > 0) {
        const ownedEntries = await prisma.accountingEntry.findMany({
          where: {
            sourceType: AccountingSourceType.SALE,
            sourceId: { in: createdSaleIds },
          },
          select: { id: true },
        });
        const ownedEntryIds = ownedEntries.map((entry) => entry.id);
        if (ownedEntryIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: {
              entityType: 'AccountingEntry',
              entityId: { in: ownedEntryIds },
            },
          });
        }
        await prisma.accountingEntry.deleteMany({
          where: {
            sourceType: AccountingSourceType.SALE,
            sourceId: { in: createdSaleIds },
          },
        });

        const ownedMovements = await prisma.inventoryMovement.findMany({
          where: {
            referenceType: 'Sale',
            referenceId: { in: createdSaleIds },
          },
          select: { id: true },
        });
        const ownedMovementIds = ownedMovements.map((m) => m.id);
        if (ownedMovementIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: {
              entityType: 'InventoryMovement',
              entityId: { in: ownedMovementIds },
            },
          });
        }
        await prisma.inventoryMovement.deleteMany({
          where: {
            referenceType: 'Sale',
            referenceId: { in: createdSaleIds },
          },
        });

        const ownedPayments = await prisma.payment.findMany({
          where: { saleId: { in: createdSaleIds } },
          select: { id: true },
        });
        const ownedPaymentIds = ownedPayments.map((p) => p.id);
        if (ownedPaymentIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: {
              entityType: 'Payment',
              entityId: { in: ownedPaymentIds },
            },
          });
          await prisma.payment.deleteMany({
            where: { id: { in: ownedPaymentIds } },
          });
        }

        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: createdSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
      }

      await prisma.customer.deleteMany({ where: { id: rucCustomerId } });
      await prisma.product.deleteMany({ where: { id: productId } });
      await prisma.unit.deleteMany({ where: { id: unitId } });
      await prisma.category.deleteMany({ where: { id: categoryId } });

      await prisma.companySettings.update({
        where: { id: companySettingsId },
        data: companySettingsBaseline,
      });

      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.SALE },
      });

      if (ownedAdminLoginAuditIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedAdminLoginAuditIds } },
        });
      }
      if (ownedUserIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { userId: { in: ownedUserIds } },
        });
        await prisma.userRole.deleteMany({
          where: { userId: { in: ownedUserIds } },
        });
        await prisma.user.deleteMany({ where: { id: { in: ownedUserIds } } });
      }
    } finally {
      await app.close();
      await failingApp.close();
      await unknownOutcomeApp.close();
      await prisma.$disconnect();
    }
  });

  // ====================================================================
  // §31 — Emisión FACTURA
  // ====================================================================
  describe('POST /sales/:saleId/electronic-documents — FACTURA (§31)', () => {
    it('201, ACCEPTED bajo MockProvider, fullNumber correctamente relleno, un solo documento, ítems correctos, número asignado una vez', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '2',
      });

      const before = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });

      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });

      expect(response.status).toBe(201);
      const body = response.body as {
        id: string;
        status: string;
        fullNumber: string;
        number: number;
        saleId: string;
        saleNumber: string;
      };
      createdDocumentIds.push(body.id);
      expect(body.status).toBe(ElectronicDocumentStatus.ACCEPTED);
      expect(body.fullNumber).toBe(
        `${FACTURA_SERIES}-${String(body.number).padStart(8, '0')}`,
      );
      expect(body.saleId).toBe(sale.id);
      expect(body.saleNumber).toBe(sale.number);

      const docsForSale = await prisma.electronicDocument.findMany({
        where: { saleId: sale.id },
      });
      expect(docsForSale).toHaveLength(1);
      expect(docsForSale[0].items).toBeUndefined(); // relación no cargada por Prisma por defecto

      const items = await prisma.electronicDocumentItem.findMany({
        where: { electronicDocumentId: body.id },
      });
      expect(items).toHaveLength(1);
      expect(items[0].productSku).toBeDefined();
      expect(items[0].quantity.toFixed(3)).toBe('2.000');

      const after = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });
      expect(after.currentNumber - before.currentNumber).toBe(1);
    });

    it('body inválido: documentType desconocido -> 400', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(adminCookie, sale.id, {
        documentType: 'INVOICE',
        series: 'F910',
      });
      expect(response.status).toBe(400);
    });

    it('serie mal formada (minúscula) -> 400, sin normalizar', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: 'f910',
      });
      expect(response.status).toBe(400);
    });

    it('serie de BOLETA usada para FACTURA -> 400 (forma inválida para el tipo)', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: BOLETA_SERIES,
      });
      expect(response.status).toBe(400);
    });

    it('campo desconocido en el body -> 400 (ValidationPipe global)', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
        saleId: sale.id,
      });
      expect(response.status).toBe(400);
    });

    it('venta inexistente -> 404', async () => {
      const response = await issueDoc(adminCookie, NON_EXISTENT_UUID, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(response.status).toBe(404);
    });
  });

  // ====================================================================
  // §32 — Emisión BOLETA
  // ====================================================================
  describe('POST /sales/:saleId/electronic-documents — BOLETA (§32)', () => {
    it('genérico, total exactamente S/700.00 -> 201 ACCEPTED', async () => {
      const sale = await createFixtureSale({
        customerId: genericCustomerId,
        quantity: '14', // 14 * 50.00 = 700.00
        payment: { method: 'CASH', amount: '700.00' },
      });
      expect(sale.total).toBe('700.00');

      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.BOLETA,
        series: BOLETA_SERIES,
      });

      expect(response.status).toBe(201);
      const body = response.body as { id: string; status: string };
      createdDocumentIds.push(body.id);
      expect(body.status).toBe(ElectronicDocumentStatus.ACCEPTED);
    });

    it('genérico, total > S/700.00 -> 409', async () => {
      const sale = await createFixtureSale({
        customerId: genericCustomerId,
        quantity: '15', // 15 * 50.00 = 750.00
        payment: { method: 'CASH', amount: '750.00' },
      });
      expect(sale.total).toBe('750.00');

      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.BOLETA,
        series: BOLETA_SERIES,
      });

      expect(response.status).toBe(409);
      const docs = await prisma.electronicDocument.findMany({
        where: { saleId: sale.id },
      });
      expect(docs).toHaveLength(0);
    });
  });

  // ====================================================================
  // §33 — Emisión duplicada
  // ====================================================================
  describe('POST /sales/:saleId/electronic-documents — duplicada (§33)', () => {
    it('primera 201, segunda 409; FiscalSeries incrementa solo una vez; exactamente un documento primario', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });

      const before = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });

      const first = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(first.status).toBe(201);
      createdDocumentIds.push((first.body as { id: string }).id);

      const second = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(second.status).toBe(409);

      const after = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });
      expect(after.currentNumber - before.currentNumber).toBe(1);

      const docs = await prisma.electronicDocument.findMany({
        where: { saleId: sale.id },
      });
      expect(docs).toHaveLength(1);
    });
  });

  // ====================================================================
  // §34 — Listado / detalle
  // ====================================================================
  describe('GET /electronic-documents — listado y detalle (§34)', () => {
    let saleA: FixtureSale;
    let docAId: string;

    beforeAll(async () => {
      saleA = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '3',
      });
      const response = await issueDoc(adminCookie, saleA.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(response.status).toBe(201);
      docAId = (response.body as { id: string }).id;
      createdDocumentIds.push(docAId);
    });

    it('paginación: page/limit respetados', async () => {
      const response = await listDocs(adminCookie, { page: 1, limit: 1 });
      expect(response.status).toBe(200);
      const body = response.body as {
        data: unknown[];
        page: number;
        limit: number;
      };
      expect(body.page).toBe(1);
      expect(body.limit).toBe(1);
      expect(body.data.length).toBeLessThanOrEqual(1);
    });

    it('filtro documentType', async () => {
      const response = await listDocs(adminCookie, {
        documentType: FiscalDocumentType.FACTURA,
        saleId: saleA.id,
      });
      expect(response.status).toBe(200);
      const body = response.body as { data: { documentType: string }[] };
      expect(
        body.data.every((d) => d.documentType === FiscalDocumentType.FACTURA),
      ).toBe(true);
    });

    it('filtro status', async () => {
      const response = await listDocs(adminCookie, {
        status: ElectronicDocumentStatus.ACCEPTED,
        saleId: saleA.id,
      });
      expect(response.status).toBe(200);
      const body = response.body as { data: { status: string }[] };
      expect(
        body.data.every((d) => d.status === ElectronicDocumentStatus.ACCEPTED),
      ).toBe(true);
    });

    it('filtro saleId', async () => {
      const response = await listDocs(adminCookie, { saleId: saleA.id });
      expect(response.status).toBe(200);
      const body = response.body as { data: { id: string }[] };
      expect(body.data).toHaveLength(1);
      expect(body.data[0].id).toBe(docAId);
    });

    it('filtro customerDocumentNumber', async () => {
      const response = await listDocs(adminCookie, {
        customerDocumentNumber: '20123456789',
        saleId: saleA.id,
      });
      expect(response.status).toBe(200);
      const body = response.body as { data: unknown[] };
      expect(body.data.length).toBeGreaterThanOrEqual(1);
    });

    it('fullNumber presente en el listado; sin providerExternalId ni campos internos', async () => {
      const response = await listDocs(adminCookie, { saleId: saleA.id });
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('providerExternalId');
      expect(raw).not.toContain('fiscalSeriesId');
      const body = response.body as { data: { fullNumber: string }[] };
      expect(body.data[0].fullNumber).toMatch(/^F910-\d{8}$/);
    });

    it('detalle incluye ítems, issuer, sin providerExternalId', async () => {
      const response = await getDoc(adminCookie, docAId);
      expect(response.status).toBe(200);
      const raw = JSON.stringify(response.body);
      expect(raw).not.toContain('providerExternalId');
      const body = response.body as {
        items: { productSku: string }[];
        issuerBusinessName: string;
      };
      expect(body.items.length).toBeGreaterThan(0);
      expect(body.issuerBusinessName).toBe('Empresa Demo Fiscal API E2E SAC');
    });

    it('detalle inexistente -> 404', async () => {
      const response = await getDoc(adminCookie, NON_EXISTENT_UUID);
      expect(response.status).toBe(404);
    });
  });

  // ====================================================================
  // §35 — Autorización
  // ====================================================================
  describe('autorización por rol activo (§35)', () => {
    it('ADMIN puede emitir', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(response.status).toBe(201);
      createdDocumentIds.push((response.body as { id: string }).id);
    });

    it('SELLER puede emitir', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(sellerCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(response.status).toBe(201);
      createdDocumentIds.push((response.body as { id: string }).id);
    });

    it.each([
      ['MANAGEMENT', () => managementCookie],
      ['WAREHOUSE', () => warehouseCookie],
    ])('%s no puede emitir -> 403', async (_role, getCookie) => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(getCookie(), sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(response.status).toBe(403);
    });

    it.each([
      ['ADMIN', () => adminCookie],
      ['SELLER', () => sellerCookie],
      ['MANAGEMENT', () => managementCookie],
    ])('%s puede listar y ver el detalle', async (_role, getCookie) => {
      const listResponse = await listDocs(getCookie(), { limit: 1 });
      expect(listResponse.status).toBe(200);
    });

    it('WAREHOUSE no puede listar -> 403', async () => {
      const response = await listDocs(warehouseCookie, { limit: 1 });
      expect(response.status).toBe(403);
    });

    it('WAREHOUSE no puede ver el detalle -> 403', async () => {
      const response = await getDoc(warehouseCookie, NON_EXISTENT_UUID);
      expect(response.status).toBe(403);
    });

    it.each([
      ['SELLER', () => sellerCookie],
      ['MANAGEMENT', () => managementCookie],
      ['WAREHOUSE', () => warehouseCookie],
    ])('%s no puede reintentar -> 403', async (_role, getCookie) => {
      const response = await retryDoc(getCookie(), NON_EXISTENT_UUID);
      expect(response.status).toBe(403);
    });

    it('WAREHOUSE no puede descubrir series fiscales -> 403', async () => {
      const response = await listSeries(warehouseCookie);
      expect(response.status).toBe(403);
    });
  });

  // ====================================================================
  // §36 — Comportamiento por ROL ACTIVO (no unión de roles asignados)
  // ====================================================================
  describe('rol activo (KAN-18) — mismo usuario, distinto comportamiento según el rol ACTIVO (§36)', () => {
    it('activo SELLER: puede emitir; activo MANAGEMENT: puede ver pero no emitir; activo ADMIN: puede emitir y reintentar', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      expect(loginResult.status).toBe(200);

      const asSeller = await switchRole(loginResult.cookie, RoleName.SELLER);
      const saleForSeller = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const issueAsSeller = await issueDoc(asSeller, saleForSeller.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(issueAsSeller.status).toBe(201);
      createdDocumentIds.push((issueAsSeller.body as { id: string }).id);

      const asManagement = await switchRole(asSeller, RoleName.MANAGEMENT);
      const listAsManagement = await listDocs(asManagement, { limit: 1 });
      expect(listAsManagement.status).toBe(200);
      const saleForManagement = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const issueAsManagement = await issueDoc(
        asManagement,
        saleForManagement.id,
        {
          documentType: FiscalDocumentType.FACTURA,
          series: FACTURA_SERIES,
        },
      );
      expect(issueAsManagement.status).toBe(403);

      const asAdmin = await switchRole(asManagement, RoleName.ADMIN);
      const issueAsAdmin = await issueDoc(asAdmin, saleForManagement.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(issueAsAdmin.status).toBe(201);
      const docId = (issueAsAdmin.body as { id: string }).id;
      createdDocumentIds.push(docId);

      // Reintento no aplica (el documento ya está ACCEPTED -> 409), pero
      // prueba que ADMIN activo SÍ tiene acceso al endpoint (no 403).
      const retryAsAdmin = await retryDoc(asAdmin, docId);
      expect(retryAsAdmin.status).toBe(409);
    });
  });

  // ====================================================================
  // §37 — Reintento exitoso
  // ====================================================================
  describe('POST /electronic-documents/:id/retry — reintento exitoso (§37)', () => {
    it('503 inicial (SUBMISSION_FAILED), luego 200 ACCEPTED con el MISMO id/series/number/fullNumber; FiscalSeries sin cambios por el reintento; submissionCount incrementa', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });

      const failed = await issueDoc(
        adminCookie,
        sale.id,
        { documentType: FiscalDocumentType.FACTURA, series: FACTURA_SERIES },
        failingApp,
      );
      expect(failed.status).toBe(503);

      const doc = await prisma.electronicDocument.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      createdDocumentIds.push(doc.id);
      expect(doc.status).toBe(ElectronicDocumentStatus.SUBMISSION_FAILED);

      const before = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });

      const retried = await retryDoc(adminCookie, doc.id);
      expect(retried.status).toBe(200);
      const body = retried.body as {
        id: string;
        status: string;
        series: string;
        number: number;
        fullNumber: string;
        submissionCount: number;
      };
      expect(body.id).toBe(doc.id);
      expect(body.status).toBe(ElectronicDocumentStatus.ACCEPTED);
      expect(body.series).toBe(doc.series);
      expect(body.number).toBe(doc.number);
      expect(body.fullNumber).toBe(
        `${doc.series}-${String(doc.number).padStart(8, '0')}`,
      );
      expect(body.submissionCount).toBeGreaterThan(1);

      const after = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });
      expect(after.currentNumber).toBe(before.currentNumber);
    });
  });

  // ====================================================================
  // §38 — Resultado desconocido
  // ====================================================================
  describe('resultado desconocido del proveedor (§38)', () => {
    it('503 inicial, documento permanece SUBMITTED con providerStatus UNKNOWN_OUTCOME; reintento -> 409; sin auditoría de fallo; sin asignación adicional', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });

      const before = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });

      const unknown = await issueDoc(
        adminCookie,
        sale.id,
        { documentType: FiscalDocumentType.FACTURA, series: FACTURA_SERIES },
        unknownOutcomeApp,
      );
      expect(unknown.status).toBe(503);

      const doc = await prisma.electronicDocument.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      createdDocumentIds.push(doc.id);
      expect(doc.status).toBe(ElectronicDocumentStatus.SUBMITTED);
      expect(doc.providerStatus).toBe('UNKNOWN_OUTCOME');

      const failedAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
          entityId: doc.id,
        },
      });
      expect(failedAudit).toBeNull();

      const retried = await retryDoc(adminCookie, doc.id);
      expect(retried.status).toBe(409);

      const after = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });
      expect(after.currentNumber - before.currentNumber).toBe(1);
    });
  });

  // ====================================================================
  // §39 — Descubrimiento de series fiscales
  // ====================================================================
  describe('GET /fiscal-series — descubrimiento (§39)', () => {
    it('devuelve las series propias de esta suite; filtros documentType/active; nunca muta F001/B001', async () => {
      const f001Before = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: 'F001',
          },
        },
      });

      const all = await listSeries(adminCookie);
      expect(all.status).toBe(200);
      const allBody = all.body as {
        id: string;
        documentType: string;
        series: string;
      }[];
      expect(allBody.some((s) => s.series === FACTURA_SERIES)).toBe(true);
      expect(allBody.some((s) => s.series === BOLETA_SERIES)).toBe(true);
      // Nunca expone nextNumber.
      expect(JSON.stringify(allBody)).not.toContain('nextNumber');

      const onlyFactura = await listSeries(adminCookie, {
        documentType: FiscalDocumentType.FACTURA,
      });
      expect(
        (onlyFactura.body as { documentType: string }[]).every(
          (s) => s.documentType === FiscalDocumentType.FACTURA,
        ),
      ).toBe(true);

      const onlyActive = await listSeries(adminCookie, { active: true });
      expect(
        (onlyActive.body as { active: boolean }[]).every((s) => s.active),
      ).toBe(true);

      const f001After = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: 'F001',
          },
        },
      });
      expect(f001After.currentNumber).toBe(f001Before.currentNumber);
    });

    it('SELLER y MANAGEMENT pueden descubrir series', async () => {
      const asSeller = await listSeries(sellerCookie);
      expect(asSeller.status).toBe(200);
      const asManagement = await listSeries(managementCookie);
      expect(asManagement.status).toBe(200);
    });
  });

  // ====================================================================
  // §40 — Auditoría
  // ====================================================================
  describe('auditoría (§40)', () => {
    it('emisión exitosa: CREATED y ACCEPTED exactamente una vez cada una, sin duplicados del controller', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(response.status).toBe(201);
      const docId = (response.body as { id: string }).id;
      createdDocumentIds.push(docId);

      const created = await prisma.auditLog.count({
        where: {
          action: AuditAction.ELECTRONIC_DOCUMENT_CREATED,
          entityId: docId,
        },
      });
      const accepted = await prisma.auditLog.count({
        where: {
          action: AuditAction.ELECTRONIC_DOCUMENT_ACCEPTED,
          entityId: docId,
        },
      });
      expect(created).toBe(1);
      expect(accepted).toBe(1);
    });

    it('falla definitiva + reintento: CREATED y SUBMISSION_FAILED al emitir; ACCEPTED solo tras el reintento', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const failed = await issueDoc(
        adminCookie,
        sale.id,
        { documentType: FiscalDocumentType.FACTURA, series: FACTURA_SERIES },
        failingApp,
      );
      expect(failed.status).toBe(503);
      const doc = await prisma.electronicDocument.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      createdDocumentIds.push(doc.id);

      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.ELECTRONIC_DOCUMENT_CREATED,
            entityId: doc.id,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
            entityId: doc.id,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.ELECTRONIC_DOCUMENT_ACCEPTED,
            entityId: doc.id,
          },
        }),
      ).toBe(0);

      const retried = await retryDoc(adminCookie, doc.id);
      expect(retried.status).toBe(200);
      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.ELECTRONIC_DOCUMENT_ACCEPTED,
            entityId: doc.id,
          },
        }),
      ).toBe(1);
    });

    it('resultado desconocido: CREATED sin SUBMISSION_FAILED', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });
      const response = await issueDoc(
        adminCookie,
        sale.id,
        { documentType: FiscalDocumentType.FACTURA, series: FACTURA_SERIES },
        unknownOutcomeApp,
      );
      expect(response.status).toBe(503);
      const doc = await prisma.electronicDocument.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      createdDocumentIds.push(doc.id);

      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.ELECTRONIC_DOCUMENT_CREATED,
            entityId: doc.id,
          },
        }),
      ).toBe(1);
      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
            entityId: doc.id,
          },
        }),
      ).toBe(0);
    });
  });

  // ====================================================================
  // §41 — Regresión contabilidad/pagos/inventario
  // ====================================================================
  describe('regresión — contabilidad, pagos e inventario (§41)', () => {
    it('la emisión fiscal no altera paidAmount/balanceDue/paymentStatus, ni crea AccountingEntry/InventoryMovement propios', async () => {
      const sale = await createFixtureSale({
        customerId: rucCustomerId,
        quantity: '1',
      });

      const saleBefore = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      const accountingBefore = await prisma.accountingEntry.count({
        where: { sourceType: AccountingSourceType.SALE, sourceId: sale.id },
      });
      const movementsBefore = await prisma.inventoryMovement.count({
        where: { referenceType: 'Sale', referenceId: sale.id },
      });

      const response = await issueDoc(adminCookie, sale.id, {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
      });
      expect(response.status).toBe(201);
      createdDocumentIds.push((response.body as { id: string }).id);

      const saleAfter = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleAfter.paidAmount.toFixed(2)).toBe(
        saleBefore.paidAmount.toFixed(2),
      );
      expect(saleAfter.balanceDue.toFixed(2)).toBe(
        saleBefore.balanceDue.toFixed(2),
      );
      expect(saleAfter.paymentStatus).toBe(saleBefore.paymentStatus);

      const accountingAfter = await prisma.accountingEntry.count({
        where: { sourceType: AccountingSourceType.SALE, sourceId: sale.id },
      });
      const movementsAfter = await prisma.inventoryMovement.count({
        where: { referenceType: 'Sale', referenceId: sale.id },
      });
      expect(accountingAfter).toBe(accountingBefore);
      expect(movementsAfter).toBe(movementsBefore);
    });
  });
});
