import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  CategoryStatus,
  ImportOperationStatus,
  ImportShipmentStatus,
  ImportTransportMode,
  PrismaClient,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
  RoleName,
  SupplierDocumentType,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { businessToday } from '../src/common/date/business-date';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Fase B1 — Operaciones de importación y seguimiento de embarques. Suite
 * dedicada y aislada: limpia exclusivamente por los ids que ella misma
 * crea. Nunca llama a StockMovementEngine/InventoryValuationEngine/
 * AccountingEngine — verificado explícitamente en varias pruebas.
 */

interface SafeImportOperationBody {
  id: string;
  reference: string;
  status: ImportOperationStatus;
}

interface SafeImportShipmentBody {
  id: string;
  status: ImportShipmentStatus;
  lines: { id: string; purchaseInvoiceLineId: string | null }[];
}

interface SafePurchaseInvoiceBody {
  id: string;
  status: string;
  lines: { id: string; productId: string | null }[];
}

const MANAGEMENT_USERNAME = 'e2e_b1_management';
const ACCOUNTANT_USERNAME = 'e2e_b1_accountant';
const SELLER_USERNAME = 'e2e_b1_seller';
const WAREHOUSE_USERNAME = 'e2e_b1_warehouse';
const FIXTURE_PASSWORD = 'E2eB1Fixture2026Aa';

describe('Import Operations — Fase B1 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let activeSupplierId: string;

  const createdAccountIds: string[] = [];
  const createdPurchaseInvoiceIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdImportOperationIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  function createOperation(
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/import-operations')
      .set('Cookie', cookie)
      .send(body);
  }

  function createShipment(
    operationId: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-operations/${operationId}/shipments`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function createOperationOrThrow(
    reference: string,
  ): Promise<SafeImportOperationBody> {
    const response = await createOperation({
      reference,
      originCountry: 'CN',
      destinationCountry: 'PE',
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la operación fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeImportOperationBody;
    createdImportOperationIds.push(body.id);
    return body;
  }

  async function createSupplier(): Promise<string> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send({
        documentType: SupplierDocumentType.RUC,
        documentNumber: suffix.slice(-11).padStart(11, '0'),
        legalName: `Proveedor E2E B1 ${suffix}`,
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el proveedor fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as { id: string };
    createdSupplierIds.push(body.id);
    return body.id;
  }

  async function createTestAccount(
    code: string,
    name: string,
    type: AccountType,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/chart-of-accounts')
      .set('Cookie', adminCookie)
      .send({ code, name, type, isPostable: true });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la cuenta fixture ${code}: ${JSON.stringify(response.body)}`,
      );
    }
    const created = response.body as { id: string };
    createdAccountIds.push(created.id);
    return created.id;
  }

  async function activateSystemKey(
    systemKey: AccountingSystemKey,
    accountId: string,
  ): Promise<void> {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/chart-of-accounts/system-keys/${systemKey}`)
      .set('Cookie', adminCookie)
      .send({ accountId });
    if (response.status !== 200) {
      throw new Error(
        `No se pudo activar el mapeo sintético ${systemKey}: ${JSON.stringify(response.body)}`,
      );
    }
  }

  /** Factura CONFIRMED con una línea RESALE_INVENTORY del producto fixture. */
  async function createConfirmedInvoiceLine(quantity: string): Promise<string> {
    const suffix = nextSuffix();
    const draft = await request(app.getHttpServer())
      .post('/api/v1/purchase-invoices')
      .set('Cookie', adminCookie)
      .send({
        supplierId: activeSupplierId,
        documentType: PurchaseInvoiceDocumentType.FACTURA,
        documentSeries: 'F900',
        documentNumber: suffix.slice(-8),
        issueDate: businessToday(),
        lines: [
          {
            productId,
            acquisitionKind: 'GOOD',
            purchasePurpose: 'RESALE_INVENTORY',
            quantity,
            unitCost: '10.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });
    if (draft.status !== 201) {
      throw new Error(
        `No se pudo crear la factura fixture: ${JSON.stringify(draft.body)}`,
      );
    }
    const invoice = draft.body as SafePurchaseInvoiceBody;
    createdPurchaseInvoiceIds.push(invoice.id);

    const confirmed = await request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${invoice.id}/confirm`)
      .set('Cookie', adminCookie)
      .send({});
    if (confirmed.status !== 200) {
      throw new Error(
        `No se pudo confirmar la factura fixture: ${JSON.stringify(confirmed.body)}`,
      );
    }
    const confirmedBody = confirmed.body as SafePurchaseInvoiceBody;
    return confirmedBody.lines[0].id;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

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

    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_b1_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_b1_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_b1_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_b1_warehouse@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    accountantCookie = (
      await login(app.getHttpServer(), ACCOUNTANT_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, FIXTURE_PASSWORD)
    ).cookie;

    const shortSuffix = Date.now() % 1000000;
    const category = await prisma.category.create({
      data: {
        code: `B1CAT${shortSuffix}`,
        name: `Categoría E2E B1 ${shortSuffix}`,
        status: CategoryStatus.ACTIVE,
      },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `B1UN${shortSuffix}`,
        name: `Unidad E2E B1 ${shortSuffix}`,
        abbreviation: 'ub1',
        allowDecimal: true,
        status: UnitStatus.ACTIVE,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: `B1-${shortSuffix}`,
        name: `Producto E2E B1 ${shortSuffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '50.00',
        isInventoryTracked: true,
        stockCurrent: '20.000',
        status: ProductStatus.ACTIVE,
      },
    });
    productId = product.id;
    createdProductIds.push(productId);

    activeSupplierId = await createSupplier();

    const apAccountId = await createTestAccount(
      `B1AP${shortSuffix}`,
      'Cuentas por pagar sintética E2E B1',
      AccountType.LIABILITY,
    );
    await activateSystemKey(AccountingSystemKey.ACCOUNTS_PAYABLE, apAccountId);
    const resaleAccountId = await createTestAccount(
      `B1RES${shortSuffix}`,
      'Compras para reventa sintética E2E B1',
      AccountType.ASSET,
    );
    await activateSystemKey(
      AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
      resaleAccountId,
    );
  }, 60000);

  afterAll(async () => {
    try {
      const shipments = await prisma.importShipment.findMany({
        where: { importOperationId: { in: createdImportOperationIds } },
        select: { id: true },
      });
      const shipmentIds = shipments.map((s) => s.id);
      await prisma.importShipmentLine.deleteMany({
        where: { importShipmentId: { in: shipmentIds } },
      });
      await prisma.importShipment.deleteMany({
        where: { id: { in: shipmentIds } },
      });
      await prisma.importOperation.deleteMany({
        where: { id: { in: createdImportOperationIds } },
      });

      const posted = await prisma.purchaseInvoice.findMany({
        where: {
          id: { in: createdPurchaseInvoiceIds },
          postedEntryId: { not: null },
        },
        select: { postedEntryId: true },
      });
      const postedEntryIds = posted
        .map((row) => row.postedEntryId)
        .filter((id): id is string => id !== null);
      await prisma.purchaseInvoice.deleteMany({
        where: { id: { in: createdPurchaseInvoiceIds } },
      });
      if (postedEntryIds.length > 0) {
        await prisma.accountingEntryLine.deleteMany({
          where: { entryId: { in: postedEntryIds } },
        });
        await prisma.accountingEntry.deleteMany({
          where: { id: { in: postedEntryIds } },
        });
      }

      await prisma.supplier.deleteMany({
        where: { id: { in: createdSupplierIds } },
      });
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
      await prisma.category.deleteMany({ where: { id: categoryId } });
      await prisma.unit.deleteMany({ where: { id: unitId } });
      await prisma.account.deleteMany({
        where: { id: { in: createdAccountIds } },
      });

      await prisma.userRole.deleteMany({
        where: {
          user: {
            username: {
              in: [
                MANAGEMENT_USERNAME,
                ACCOUNTANT_USERNAME,
                SELLER_USERNAME,
                WAREHOUSE_USERNAME,
              ],
            },
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          username: {
            in: [
              MANAGEMENT_USERNAME,
              ACCOUNTANT_USERNAME,
              SELLER_USERNAME,
              WAREHOUSE_USERNAME,
            ],
          },
        },
      });
    } finally {
      await app.close();
    }
  }, 60000);

  describe('RBAC', () => {
    it('SELLER/WAREHOUSE: 403 en lectura y escritura', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/import-operations')
        .set('Cookie', sellerCookie);
      expect(list.status).toBe(403);
      const create = await createOperation(
        {
          reference: `RBAC-${nextSuffix()}`,
          originCountry: 'CN',
          destinationCountry: 'PE',
        },
        warehouseCookie,
      );
      expect(create.status).toBe(403);
    });

    it('MANAGEMENT/ACCOUNTANT: leen pero no pueden crear', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/import-operations')
        .set('Cookie', managementCookie);
      expect(list.status).toBe(200);
      const create = await createOperation(
        {
          reference: `RBAC-${nextSuffix()}`,
          originCountry: 'CN',
          destinationCountry: 'PE',
        },
        accountantCookie,
      );
      expect(create.status).toBe(403);
    });
  });

  describe('Operación con múltiples embarques y líneas, sin factura confirmada', () => {
    it('crea la operación DRAFT, dos embarques con varias líneas cada uno, y transiciona a IN_PROGRESS', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      expect(operation.status).toBe(ImportOperationStatus.DRAFT);

      const shipment1 = await createShipment(operation.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          {
            descriptionSnapshot: 'Repuesto genérico A',
            plannedQuantity: '10.000',
          },
          {
            descriptionSnapshot: 'Repuesto genérico B',
            plannedQuantity: '5.000',
          },
        ],
      });
      expect(shipment1.status).toBe(201);
      const shipment1Body = shipment1.body as SafeImportShipmentBody;
      expect(shipment1Body.lines).toHaveLength(2);

      const afterFirst = await request(app.getHttpServer())
        .get(`/api/v1/import-operations/${operation.id}`)
        .set('Cookie', adminCookie);
      expect((afterFirst.body as SafeImportOperationBody).status).toBe(
        ImportOperationStatus.IN_PROGRESS,
      );

      const shipment2 = await createShipment(operation.id, {
        transportMode: ImportTransportMode.AIR,
        lines: [
          { descriptionSnapshot: 'Repuesto urgente', plannedQuantity: '1.000' },
        ],
      });
      expect(shipment2.status).toBe(201);

      const list = await request(app.getHttpServer())
        .get(`/api/v1/import-operations/${operation.id}/shipments`)
        .set('Cookie', adminCookie);
      expect((list.body as { total: number }).total).toBe(2);
    });
  });

  describe('Vínculo opcional a factura de compra CONFIRMED', () => {
    it('dos embarques parciales (operaciones distintas) de la MISMA línea de factura nunca exceden lo facturado', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');

      const operationA = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const firstShipment = await createShipment(operationA.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          {
            productId,
            plannedQuantity: '6.000',
            purchaseInvoiceLineId: invoiceLineId,
          },
        ],
      });
      expect(firstShipment.status).toBe(201);

      const operationB = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const withinLimit = await createShipment(operationB.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          {
            productId,
            plannedQuantity: '4.000',
            purchaseInvoiceLineId: invoiceLineId,
          },
        ],
      });
      expect(withinLimit.status).toBe(201);

      const overAllocated = await createShipment(operationB.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          {
            productId,
            plannedQuantity: '1.000',
            purchaseInvoiceLineId: invoiceLineId,
          },
        ],
      });
      expect(overAllocated.status).toBe(409);
    });

    it('dos solicitudes concurrentes contra la MISMA línea de factura: exactamente una se bloquea por sobre-asignación', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);

      const [first, second] = await Promise.all([
        createShipment(operation.id, {
          transportMode: ImportTransportMode.SEA,
          lines: [
            {
              productId,
              plannedQuantity: '6.000',
              purchaseInvoiceLineId: invoiceLineId,
            },
          ],
        }),
        createShipment(operation.id, {
          transportMode: ImportTransportMode.SEA,
          lines: [
            {
              productId,
              plannedQuantity: '6.000',
              purchaseInvoiceLineId: invoiceLineId,
            },
          ],
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('Transiciones de embarque y separación con inventario/contabilidad', () => {
    it('PLANNED -> IN_TRANSIT -> ARRIVED -> completar operación, sin mover stock ni generar ningún efecto contable/valorización', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const created = await createShipment(operation.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [{ productId, plannedQuantity: '3.000' }],
      });
      expect(created.status).toBe(201);
      const shipmentId = (created.body as SafeImportShipmentBody).id;

      const before = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      const entriesBefore = await prisma.accountingEntry.count();
      const valuationsBefore = await prisma.inventoryValuation.count();
      const movementsBefore = await prisma.inventoryMovement.count({
        where: { productId },
      });

      const departed = await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipmentId}/depart`)
        .set('Cookie', adminCookie)
        .send({});
      expect(departed.status).toBe(200);
      expect((departed.body as SafeImportShipmentBody).status).toBe(
        ImportShipmentStatus.IN_TRANSIT,
      );

      const arrived = await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipmentId}/arrive`)
        .set('Cookie', adminCookie)
        .send({});
      expect(arrived.status).toBe(200);
      expect((arrived.body as SafeImportShipmentBody).status).toBe(
        ImportShipmentStatus.ARRIVED,
      );

      const completed = await request(app.getHttpServer())
        .post(`/api/v1/import-operations/${operation.id}/complete`)
        .set('Cookie', adminCookie)
        .send({});
      expect(completed.status).toBe(200);
      expect((completed.body as SafeImportOperationBody).status).toBe(
        ImportOperationStatus.COMPLETED,
      );

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(after.stockCurrent.toFixed(3)).toBe(
        before.stockCurrent.toFixed(3),
      );
      expect(await prisma.accountingEntry.count()).toBe(entriesBefore);
      expect(await prisma.inventoryValuation.count()).toBe(valuationsBefore);
      expect(
        await prisma.inventoryMovement.count({ where: { productId } }),
      ).toBe(movementsBefore);
    });

    it('transición inválida (ARRIVED -> depart): 409', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const created = await createShipment(operation.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          { descriptionSnapshot: 'Carga suelta', plannedQuantity: '1.000' },
        ],
      });
      const shipmentId = (created.body as SafeImportShipmentBody).id;
      await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipmentId}/arrive`)
        .set('Cookie', adminCookie)
        .send({});

      const invalidDepart = await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipmentId}/depart`)
        .set('Cookie', adminCookie)
        .send({});
      expect(invalidDepart.status).toBe(409);
    });

    it('completar una operación con un embarque todavía PLANNED: 409', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      await createShipment(operation.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          { descriptionSnapshot: 'Carga pendiente', plannedQuantity: '1.000' },
        ],
      });
      const completed = await request(app.getHttpServer())
        .post(`/api/v1/import-operations/${operation.id}/complete`)
        .set('Cookie', adminCookie)
        .send({});
      expect(completed.status).toBe(409);
    });

    it('anular la operación cuando un embarque ya está ARRIVED: 409', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const created = await createShipment(operation.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          { descriptionSnapshot: 'Carga llegada', plannedQuantity: '1.000' },
        ],
      });
      const shipmentId = (created.body as SafeImportShipmentBody).id;
      await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipmentId}/arrive`)
        .set('Cookie', adminCookie)
        .send({});

      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/import-operations/${operation.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Intento de anulación inválido' });
      expect(cancelled.status).toBe(409);
    });
  });

  describe('Auditoría', () => {
    it('registra IMPORT_OPERATION_CREATED e IMPORT_SHIPMENT_CREATED', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      await createShipment(operation.id, {
        transportMode: ImportTransportMode.LAND,
        lines: [
          { descriptionSnapshot: 'Carga terrestre', plannedQuantity: '2.000' },
        ],
      });

      const logs = await prisma.auditLog.findMany({
        where: {
          action: {
            in: ['IMPORT_OPERATION_CREATED', 'IMPORT_SHIPMENT_CREATED'],
          },
          entityId: { not: null },
        },
        orderBy: { createdAt: 'desc' },
        take: 10,
      });
      const actions = logs.map((l) => l.action);
      expect(actions).toContain('IMPORT_OPERATION_CREATED');
      expect(actions).toContain('IMPORT_SHIPMENT_CREATED');
    });
  });
});
