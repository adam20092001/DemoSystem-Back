import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  CategoryStatus,
  ImportExpenseAllocationMethod,
  ImportExpenseCategory,
  ImportExpenseStatus,
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
 * Fase B2 — Gastos de importación y asignación de costo. Suite dedicada y
 * aislada: limpia exclusivamente por los ids que ella misma crea. Nunca
 * genera movimientos de inventario, valorización ni asientos contables —
 * verificado explícitamente.
 */

interface SafeImportOperationBody {
  id: string;
  status: string;
}

interface SafeImportShipmentBody {
  id: string;
  lines: { id: string; purchaseInvoiceLineId: string | null }[];
}

interface SafeImportExpenseBody {
  id: string;
  status: ImportExpenseStatus;
  amount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  currencyCode: string;
}

interface SafeAllocationBatchBody {
  id: string;
  requestedAmount: string;
  allocations: { importShipmentLineId: string; amount: string }[];
}

interface SafePurchaseInvoiceBody {
  id: string;
  lines: { id: string; productId: string | null }[];
}

const MANAGEMENT_USERNAME = 'e2e_b2_management';
const ACCOUNTANT_USERNAME = 'e2e_b2_accountant';
const SELLER_USERNAME = 'e2e_b2_seller';
const WAREHOUSE_USERNAME = 'e2e_b2_warehouse';
const FIXTURE_PASSWORD = 'E2eB2Fixture2026Aa';

describe('Import Expenses — Fase B2 (e2e)', () => {
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
  let forwarderSupplierId: string;

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

  function createExpense(
    operationId: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-operations/${operationId}/expenses`)
      .set('Cookie', cookie)
      .send(body);
  }

  function allocate(
    expenseId: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-expenses/${expenseId}/allocate`)
      .set('Cookie', cookie)
      .send(body);
  }

  function previewAllocation(
    expenseId: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-expenses/${expenseId}/allocate/preview`)
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

  async function createShipmentWithLinesOrThrow(
    operationId: string,
    lines: Record<string, unknown>[],
  ): Promise<SafeImportShipmentBody> {
    const response = await createShipment(operationId, {
      transportMode: ImportTransportMode.SEA,
      lines,
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el embarque fixture: ${JSON.stringify(response.body)}`,
      );
    }
    return response.body as SafeImportShipmentBody;
  }

  async function createExpenseOrThrow(
    operationId: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeImportExpenseBody> {
    const response = await createExpense(operationId, {
      category: ImportExpenseCategory.FREIGHT,
      expenseDate: businessToday(),
      currencyCode: 'USD',
      amount: '1000.00',
      ...overrides,
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el gasto fixture: ${JSON.stringify(response.body)}`,
      );
    }
    return response.body as SafeImportExpenseBody;
  }

  async function createSupplier(): Promise<string> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send({
        documentType: SupplierDocumentType.RUC,
        documentNumber: suffix.slice(-11).padStart(11, '0'),
        legalName: `Proveedor E2E B2 ${suffix}`,
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
    return (confirmed.body as SafePurchaseInvoiceBody).lines[0].id;
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
      email: 'e2e_b2_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_b2_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_b2_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_b2_warehouse@demosystem.test',
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
        code: `B2CAT${shortSuffix}`,
        name: `Categoría E2E B2 ${shortSuffix}`,
        status: CategoryStatus.ACTIVE,
      },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `B2UN${shortSuffix}`,
        name: `Unidad E2E B2 ${shortSuffix}`,
        abbreviation: 'ub2',
        allowDecimal: true,
        status: UnitStatus.ACTIVE,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: `B2-${shortSuffix}`,
        name: `Producto E2E B2 ${shortSuffix}`,
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
    forwarderSupplierId = await createSupplier();

    const apAccountId = await createTestAccount(
      `B2AP${shortSuffix}`,
      'Cuentas por pagar sintética E2E B2',
      AccountType.LIABILITY,
    );
    await activateSystemKey(AccountingSystemKey.ACCOUNTS_PAYABLE, apAccountId);
    const resaleAccountId = await createTestAccount(
      `B2RES${shortSuffix}`,
      'Compras para reventa sintética E2E B2',
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
      const lines = await prisma.importShipmentLine.findMany({
        where: { importShipmentId: { in: shipmentIds } },
        select: { id: true },
      });
      const lineIds = lines.map((l) => l.id);

      await prisma.importExpenseAllocation.deleteMany({
        where: { importShipmentLineId: { in: lineIds } },
      });
      const expenses = await prisma.importExpense.findMany({
        where: { importOperationId: { in: createdImportOperationIds } },
        select: { id: true },
      });
      const expenseIds = expenses.map((e) => e.id);
      await prisma.importExpenseAllocationBatch.deleteMany({
        where: { importExpenseId: { in: expenseIds } },
      });
      await prisma.importExpense.deleteMany({
        where: { id: { in: expenseIds } },
      });

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
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const list = await request(app.getHttpServer())
        .get(`/api/v1/import-operations/${operation.id}/expenses`)
        .set('Cookie', sellerCookie);
      expect(list.status).toBe(403);
      const create = await createExpense(
        operation.id,
        {
          category: ImportExpenseCategory.FREIGHT,
          expenseDate: businessToday(),
          currencyCode: 'USD',
          amount: '100.00',
        },
        warehouseCookie,
      );
      expect(create.status).toBe(403);
    });

    it('MANAGEMENT/ACCOUNTANT: leen pero no pueden crear ni asignar', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const list = await request(app.getHttpServer())
        .get(`/api/v1/import-operations/${operation.id}/expenses`)
        .set('Cookie', managementCookie);
      expect(list.status).toBe(200);
      const create = await createExpense(
        operation.id,
        {
          category: ImportExpenseCategory.FREIGHT,
          expenseDate: businessToday(),
          currencyCode: 'USD',
          amount: '100.00',
        },
        accountantCookie,
      );
      expect(create.status).toBe(403);
    });
  });

  describe('Registro y proveedor independiente', () => {
    it('crea un gasto con proveedor DISTINTO al de la mercadería, sin asignar todavía', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const expense = await createExpenseOrThrow(operation.id, {
        category: ImportExpenseCategory.FREIGHT,
        supplierId: forwarderSupplierId,
        amount: '500.00',
      });
      expect(expense.status).toBe(ImportExpenseStatus.DRAFT);
      expect(expense.allocatedAmount).toBe('0.00');
      expect(expense.unallocatedAmount).toBe('500.00');
    });

    it('vínculo opcional a una línea de factura CONFIRMED: se preserva sin modificar la factura', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const expense = await createExpenseOrThrow(operation.id, {
        category: ImportExpenseCategory.CUSTOMS_DUTY,
        purchaseInvoiceLineId: invoiceLineId,
        amount: '200.00',
      });
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/import-expenses/${expense.id}`)
        .set('Cookie', adminCookie);
      expect(
        (
          detail.body as SafeImportExpenseBody & {
            purchaseInvoiceLineId: string;
          }
        ).purchaseInvoiceLineId,
      ).toBe(invoiceLineId);
    });
  });

  describe('Métodos de asignación y redondeo exacto', () => {
    it('QUANTITY entre embarques distintos de la MISMA operación: la suma coincide exactamente', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment1 = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'Carga 1', plannedQuantity: '10.000' },
      ]);
      const shipment2 = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'Carga 2', plannedQuantity: '30.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        amount: '400.00',
      });

      const result = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '400.00',
        shipmentLineIds: [shipment1.lines[0].id, shipment2.lines[0].id],
      });
      expect(result.status).toBe(201);
      const batch = result.body as SafeAllocationBatchBody;
      const sum = batch.allocations.reduce((s, l) => s + Number(l.amount), 0);
      expect(sum.toFixed(2)).toBe('400.00');

      const updatedExpense = await request(app.getHttpServer())
        .get(`/api/v1/import-expenses/${expense.id}`)
        .set('Cookie', adminCookie);
      expect(
        (updatedExpense.body as SafeImportExpenseBody).allocatedAmount,
      ).toBe('400.00');
      expect(
        (updatedExpense.body as SafeImportExpenseBody).unallocatedAmount,
      ).toBe('0.00');
    });

    it('WEIGHT sin weightValue en alguna línea objetivo: 400, nunca crea el lote', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        {
          descriptionSnapshot: 'Con peso',
          plannedQuantity: '1.000',
          weightValue: '100.000',
        },
        { descriptionSnapshot: 'Sin peso', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        category: ImportExpenseCategory.FREIGHT,
      });
      const result = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.WEIGHT,
        amountToAllocate: '100.00',
        shipmentLineIds: shipment.lines.map((l) => l.id),
      });
      expect(result.status).toBe(400);
    });

    it('VOLUME con ambas líneas con volumeValue: reparte correctamente', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        {
          descriptionSnapshot: 'Caja grande',
          plannedQuantity: '1.000',
          volumeValue: '3.000',
        },
        {
          descriptionSnapshot: 'Caja pequeña',
          plannedQuantity: '1.000',
          volumeValue: '1.000',
        },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        category: ImportExpenseCategory.STORAGE,
      });
      const result = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.VOLUME,
        amountToAllocate: '400.00',
        shipmentLineIds: shipment.lines.map((l) => l.id),
      });
      expect(result.status).toBe(201);
      const batch = result.body as SafeAllocationBatchBody;
      const byLine = new Map(
        batch.allocations.map((a) => [a.importShipmentLineId, a.amount]),
      );
      expect(byLine.get(shipment.lines[0].id)).toBe('300.00');
      expect(byLine.get(shipment.lines[1].id)).toBe('100.00');
    });

    it('MANUAL con suma exacta: crea el lote; con suma distinta: 400', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'Línea A', plannedQuantity: '1.000' },
        { descriptionSnapshot: 'Línea B', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        category: ImportExpenseCategory.OTHER,
      });

      const mismatch = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.MANUAL,
        amountToAllocate: '100.00',
        manualAllocations: [
          { importShipmentLineId: shipment.lines[0].id, amount: '40.00' },
          { importShipmentLineId: shipment.lines[1].id, amount: '40.00' },
        ],
      });
      expect(mismatch.status).toBe(400);

      const exact = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.MANUAL,
        amountToAllocate: '100.00',
        manualAllocations: [
          { importShipmentLineId: shipment.lines[0].id, amount: '60.00' },
          { importShipmentLineId: shipment.lines[1].id, amount: '40.00' },
        ],
      });
      expect(exact.status).toBe(201);
    });

    it('centavos fraccionarios entre tres líneas: el residual exacto cae en la última, suma exacta', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
        { descriptionSnapshot: 'L2', plannedQuantity: '1.000' },
        { descriptionSnapshot: 'L3', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        amount: '10.00',
      });
      const result = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '10.00',
        shipmentLineIds: shipment.lines.map((l) => l.id),
      });
      expect(result.status).toBe(201);
      const batch = result.body as SafeAllocationBatchBody;
      const sum = batch.allocations.reduce((s, l) => s + Number(l.amount), 0);
      expect(sum.toFixed(2)).toBe('10.00');
    });

    it('preview reutiliza el mismo cálculo y nunca persiste nada', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '10.000' },
        { descriptionSnapshot: 'L2', plannedQuantity: '30.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        amount: '400.00',
      });
      const preview = await previewAllocation(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '400.00',
        shipmentLineIds: shipment.lines.map((l) => l.id),
      });
      expect(preview.status).toBe(200);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/import-expenses/${expense.id}`)
        .set('Cookie', adminCookie);
      expect((detail.body as SafeImportExpenseBody).allocatedAmount).toBe(
        '0.00',
      );
    });
  });

  describe('Asignación parcial/incremental, concurrencia e idempotencia', () => {
    it('dos lotes consecutivos que juntos exceden el monto: el segundo exceso es rechazado', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        amount: '1000.00',
      });

      const first = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '400.00',
        shipmentLineIds: [shipment.lines[0].id],
      });
      expect(first.status).toBe(201);

      const exceeding = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '700.00',
        shipmentLineIds: [shipment.lines[0].id],
      });
      expect(exceeding.status).toBe(409);

      const exact = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '600.00',
        shipmentLineIds: [shipment.lines[0].id],
      });
      expect(exact.status).toBe(201);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/import-expenses/${expense.id}`)
        .set('Cookie', adminCookie);
      expect((detail.body as SafeImportExpenseBody).unallocatedAmount).toBe(
        '0.00',
      );
    });

    it('dos asignaciones concurrentes que juntas exceden el monto: exactamente una se rechaza', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        amount: '1000.00',
      });

      const [first, second] = await Promise.all([
        allocate(expense.id, {
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '600.00',
          shipmentLineIds: [shipment.lines[0].id],
        }),
        allocate(expense.id, {
          method: ImportExpenseAllocationMethod.QUANTITY,
          amountToAllocate: '600.00',
          shipmentLineIds: [shipment.lines[0].id],
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });

    it('idempotencyKey repetido: devuelve el mismo lote, nunca duplica', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {
        amount: '500.00',
      });
      const key = `idem-${nextSuffix()}`;

      const first = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '300.00',
        shipmentLineIds: [shipment.lines[0].id],
        idempotencyKey: key,
      });
      expect(first.status).toBe(201);
      const firstBatchId = (first.body as SafeAllocationBatchBody).id;

      const replay = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '300.00',
        shipmentLineIds: [shipment.lines[0].id],
        idempotencyKey: key,
      });
      expect(replay.status).toBe(201);
      expect((replay.body as SafeAllocationBatchBody).id).toBe(firstBatchId);

      const allocations = await request(app.getHttpServer())
        .get(`/api/v1/import-expenses/${expense.id}/allocations`)
        .set('Cookie', adminCookie);
      expect(allocations.body as SafeAllocationBatchBody[]).toHaveLength(1);
    });
  });

  describe('Rechazo cross-operation y protección de embarques con asignaciones', () => {
    it('línea de embarque de OTRA operación: 400', async () => {
      const operationA = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const operationB = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipmentB = await createShipmentWithLinesOrThrow(operationB.id, [
        { descriptionSnapshot: 'Ajena', plannedQuantity: '1.000' },
      ]);
      const expenseA = await createExpenseOrThrow(operationA.id, {});

      const result = await allocate(expenseA.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '100.00',
        shipmentLineIds: [shipmentB.lines[0].id],
      });
      expect(result.status).toBe(400);
    });

    it('anular o reemplazar líneas de un embarque con asignaciones activas: 409', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'Con gasto asignado', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {});
      await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '100.00',
        shipmentLineIds: [shipment.lines[0].id],
      });

      const cancelShipment = await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipment.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Intento de anulación con gasto asignado' });
      expect(cancelShipment.status).toBe(409);

      const replaceLines = await request(app.getHttpServer())
        .patch(`/api/v1/import-shipments/${shipment.id}`)
        .set('Cookie', adminCookie)
        .send({
          lines: [
            { descriptionSnapshot: 'Nueva carga', plannedQuantity: '5.000' },
          ],
        });
      expect(replaceLines.status).toBe(409);
    });
  });

  describe('Ciclo de vida del gasto y cierre logístico de la operación', () => {
    it('finalize() bloquea la edición de cabecera pero sigue permitiendo asignar', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {});

      const finalized = await request(app.getHttpServer())
        .post(`/api/v1/import-expenses/${expense.id}/finalize`)
        .set('Cookie', adminCookie)
        .send({});
      expect(finalized.status).toBe(200);
      expect((finalized.body as SafeImportExpenseBody).status).toBe(
        ImportExpenseStatus.FINALIZED,
      );

      const editAttempt = await request(app.getHttpServer())
        .patch(`/api/v1/import-expenses/${expense.id}`)
        .set('Cookie', adminCookie)
        .send({ remarks: 'no debería aplicarse' });
      expect(editAttempt.status).toBe(409);

      const allocationAfterFinalize = await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '100.00',
        shipmentLineIds: [shipment.lines[0].id],
      });
      expect(allocationAfterFinalize.status).toBe(201);
    });

    it('cancel() bloqueado una vez asignado; sin asignaciones, se anula correctamente', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      const expenseWithAllocation = await createExpenseOrThrow(
        operation.id,
        {},
      );
      await allocate(expenseWithAllocation.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '100.00',
        shipmentLineIds: [shipment.lines[0].id],
      });
      const blockedCancel = await request(app.getHttpServer())
        .post(`/api/v1/import-expenses/${expenseWithAllocation.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Intento de anulación con asignación' });
      expect(blockedCancel.status).toBe(409);

      const expenseWithoutAllocation = await createExpenseOrThrow(
        operation.id,
        {},
      );
      const allowedCancel = await request(app.getHttpServer())
        .post(`/api/v1/import-expenses/${expenseWithoutAllocation.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación válida sin asignaciones' });
      expect(allowedCancel.status).toBe(200);
      expect((allowedCancel.body as SafeImportExpenseBody).status).toBe(
        ImportExpenseStatus.CANCELLED,
      );
    });

    it('amount/currencyCode bloqueados tras existir un lote de asignación', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {});
      await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '100.00',
        shipmentLineIds: [shipment.lines[0].id],
      });
      const editAmount = await request(app.getHttpServer())
        .patch(`/api/v1/import-expenses/${expense.id}`)
        .set('Cookie', adminCookie)
        .send({ amount: '2000.00' });
      expect(editAmount.status).toBe(409);
    });

    it('completar la operación NUNCA bloquea el registro de nuevos gastos', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipment.id}/depart`)
        .set('Cookie', adminCookie)
        .send({});
      await request(app.getHttpServer())
        .post(`/api/v1/import-shipments/${shipment.id}/arrive`)
        .set('Cookie', adminCookie)
        .send({});
      const completed = await request(app.getHttpServer())
        .post(`/api/v1/import-operations/${operation.id}/complete`)
        .set('Cookie', adminCookie)
        .send({});
      expect(completed.status).toBe(200);

      const lateExpense = await createExpense(operation.id, {
        category: ImportExpenseCategory.PORT_HANDLING,
        expenseDate: businessToday(),
        currencyCode: 'USD',
        amount: '150.00',
      });
      expect(lateExpense.status).toBe(201);
    });
  });

  describe('Separación de monedas y ausencia de efectos de inventario/contabilidad', () => {
    it('dos gastos del mismo operation en monedas distintas preservan su moneda sin convertir', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const usdExpense = await createExpenseOrThrow(operation.id, {
        currencyCode: 'USD',
        amount: '100.00',
      });
      const eurExpense = await createExpenseOrThrow(operation.id, {
        currencyCode: 'EUR',
        amount: '90.00',
      });
      expect(usdExpense.currencyCode).toBe('USD');
      expect(eurExpense.currencyCode).toBe('EUR');
      expect(usdExpense.amount).toBe('100.00');
      expect(eurExpense.amount).toBe('90.00');
    });

    it('ninguna acción de B2 mueve stock, valoriza inventario ni postea asientos contables', async () => {
      const movementsBefore = await prisma.inventoryMovement.count();
      const valuationsBefore = await prisma.inventoryValuation.count();
      const entriesBefore = await prisma.accountingEntry.count();

      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createShipmentWithLinesOrThrow(operation.id, [
        { descriptionSnapshot: 'L1', plannedQuantity: '1.000' },
      ]);
      const expense = await createExpenseOrThrow(operation.id, {});
      await allocate(expense.id, {
        method: ImportExpenseAllocationMethod.QUANTITY,
        amountToAllocate: '100.00',
        shipmentLineIds: [shipment.lines[0].id],
      });
      await request(app.getHttpServer())
        .post(`/api/v1/import-expenses/${expense.id}/finalize`)
        .set('Cookie', adminCookie)
        .send({});

      expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
      expect(await prisma.inventoryValuation.count()).toBe(valuationsBefore);
      expect(await prisma.accountingEntry.count()).toBe(entriesBefore);
    });
  });
});
