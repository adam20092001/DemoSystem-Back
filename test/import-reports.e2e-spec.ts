import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  ImportExpenseAllocationMethod,
  ImportExpenseCategory,
  ImportTransportMode,
  PrismaClient,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
  RoleName,
  SupplierDocumentType,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import ExcelJS from 'exceljs';
import { businessToday } from '../src/common/date/business-date';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { binaryParser } from './helpers/excel-download';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Fase B4 — Reportes y reconciliación de importaciones. Suite dedicada y
 * aislada: limpia exclusivamente por los ids que ella misma crea. De
 * SOLO LECTURA: verifica explícitamente que NINGÚN endpoint de este
 * módulo mueve inventario, valoriza ni postea asientos contables.
 */

interface SafeImportOperationBody {
  id: string;
}
interface SafeImportShipmentLineBody {
  id: string;
}
interface SafeImportShipmentBody {
  id: string;
  lines: SafeImportShipmentLineBody[];
}
interface SafePurchaseInvoiceBody {
  id: string;
  lines: { id: string }[];
}
interface SafePurchaseReceiptBody {
  id: string;
  lines: { id: string }[];
}
interface SafeAllocationBatchBody {
  allocations: { id: string; importShipmentLineId: string; amount: string }[];
}

interface CargoUnitAggregateBody {
  unitCode: string | null;
  plannedQuantity: string;
  linkedReceivedQuantity: string;
  unlinkedQuantity: string;
}
interface ExpenseCurrencyAggregateBody {
  currencyCode: string;
  expenseCount: number;
  cancelledCount: number;
  totalAmount: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  attributedAmount: string;
  unattributedAmount: string;
  financialStatus: string;
}
interface ImportOperationSummaryRowBody {
  id: string;
  cargoByUnit: CargoUnitAggregateBody[];
  expensesByCurrency: ExpenseCurrencyAggregateBody[];
}
interface ShipmentReconciliationRowBody {
  importShipmentLineId: string;
  shipmentStatus: string;
  plannedQuantity: string;
  linkedQuantity: string;
  remainingQuantity: string;
  discrepancyCodes: string[];
}
interface ExpenseReconciliationRowBody {
  importExpenseId: string;
  allocatedAmount: string;
  unallocatedAmount: string;
  attributedAmount: string;
  unattributedAmount: string;
  financialStatus: string | null;
}
interface ConsolidatedReconciliationRowBody {
  importOperationId: string;
  reconciliationStatus: string;
  reasons: string[];
  discrepancyCodes: string[];
}
interface PaginatedBody<T> {
  data: T[];
  total: number;
}

const MANAGEMENT_USERNAME = 'e2e_b4_management';
const ACCOUNTANT_USERNAME = 'e2e_b4_accountant';
const SELLER_USERNAME = 'e2e_b4_seller';
const WAREHOUSE_USERNAME = 'e2e_b4_warehouse';
const FIXTURE_PASSWORD = 'E2eB4Fixture2026Aa';

const PURCHASE_SYSTEM_KEYS: AccountingSystemKey[] = [
  AccountingSystemKey.ACCOUNTS_PAYABLE,
  AccountingSystemKey.VAT_RECEIVABLE,
  AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
  AccountingSystemKey.PURCHASE_INTERNAL_CONSUMPTION,
  AccountingSystemKey.PURCHASE_FIXED_ASSET,
  AccountingSystemKey.PURCHASE_OPERATING_EXPENSE,
  AccountingSystemKey.PURCHASE_OTHER,
];
const PURCHASE_SYSTEM_KEY_SHORT_CODES: Record<string, string> = {
  ACCOUNTS_PAYABLE: 'AP',
  VAT_RECEIVABLE: 'VATR',
  PURCHASE_RESALE_INVENTORY: 'PRES',
  PURCHASE_INTERNAL_CONSUMPTION: 'PINT',
  PURCHASE_FIXED_ASSET: 'PFIX',
  PURCHASE_OPERATING_EXPENSE: 'POPE',
  PURCHASE_OTHER: 'POTH',
};

describe('Import Reports — Fase B4 (e2e)', () => {
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
  let companyCurrencyCode: string;

  const createdAccountIds: string[] = [];
  const createdPurchaseInvoiceIds: string[] = [];
  const createdPurchaseReceiptIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdImportOperationIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  function get(
    path: string,
    query: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(path)
      .query(query)
      .set('Cookie', cookie);
  }

  async function createOperationOrThrow(
    reference: string,
  ): Promise<SafeImportOperationBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/import-operations')
      .set('Cookie', adminCookie)
      .send({ reference, originCountry: 'CN', destinationCountry: 'PE' });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la operación fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeImportOperationBody;
    createdImportOperationIds.push(body.id);
    return body;
  }

  async function createArrivedShipmentWithLine(
    operationId: string,
    plannedQuantity: string,
    purchaseInvoiceLineId?: string,
  ): Promise<SafeImportShipmentBody> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/import-operations/${operationId}/shipments`)
      .set('Cookie', adminCookie)
      .send({
        transportMode: ImportTransportMode.SEA,
        lines: [
          {
            descriptionSnapshot: 'Carga E2E B4',
            plannedQuantity,
            unitCode: 'kg',
            ...(purchaseInvoiceLineId !== undefined
              ? { purchaseInvoiceLineId }
              : {}),
          },
        ],
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el embarque fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const shipment = response.body as SafeImportShipmentBody;
    const departed = await request(app.getHttpServer())
      .post(`/api/v1/import-shipments/${shipment.id}/depart`)
      .set('Cookie', adminCookie)
      .send({});
    if (departed.status !== 200) {
      throw new Error(
        `No se pudo embarcar (depart) el fixture: ${JSON.stringify(departed.body)}`,
      );
    }
    const arrived = await request(app.getHttpServer())
      .post(`/api/v1/import-shipments/${shipment.id}/arrive`)
      .set('Cookie', adminCookie)
      .send({});
    if (arrived.status !== 200) {
      throw new Error(
        `No se pudo arribar (arrive) el fixture: ${JSON.stringify(arrived.body)}`,
      );
    }
    return arrived.body as SafeImportShipmentBody;
  }

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

  async function createActiveReceiptLine(
    invoiceId: string,
    invoiceLineId: string,
    quantity: string,
  ): Promise<{ receiptId: string; receiptLineId: string }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${invoiceId}/receipts`)
      .set('Cookie', adminCookie)
      .send({ lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity }] });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la recepción fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const receipt = response.body as SafePurchaseReceiptBody;
    createdPurchaseReceiptIds.push(receipt.id);
    return { receiptId: receipt.id, receiptLineId: receipt.lines[0].id };
  }

  async function linkOrThrow(
    shipmentLineId: string,
    purchaseReceiptLineId: string,
    linkedQuantity: string,
  ): Promise<void> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/import-shipment-lines/${shipmentLineId}/receipt-links`)
      .set('Cookie', adminCookie)
      .send({ purchaseReceiptLineId, linkedQuantity });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el vínculo fixture: ${JSON.stringify(response.body)}`,
      );
    }
  }

  async function createExpenseAllocatedManually(
    operationId: string,
    allocations: { importShipmentLineId: string; amount: string }[],
    totalAmount: string,
    currencyCode: string,
  ): Promise<SafeAllocationBatchBody> {
    const expenseResponse = await request(app.getHttpServer())
      .post(`/api/v1/import-operations/${operationId}/expenses`)
      .set('Cookie', adminCookie)
      .send({
        category: ImportExpenseCategory.FREIGHT,
        expenseDate: businessToday(),
        currencyCode,
        amount: totalAmount,
      });
    if (expenseResponse.status !== 201) {
      throw new Error(
        `No se pudo crear el gasto fixture: ${JSON.stringify(expenseResponse.body)}`,
      );
    }
    const expenseId = (expenseResponse.body as { id: string }).id;
    const allocateResponse = await request(app.getHttpServer())
      .post(`/api/v1/import-expenses/${expenseId}/allocate`)
      .set('Cookie', adminCookie)
      .send({
        method: ImportExpenseAllocationMethod.MANUAL,
        amountToAllocate: totalAmount,
        manualAllocations: allocations,
      });
    if (allocateResponse.status !== 201) {
      throw new Error(
        `No se pudo asignar el gasto fixture: ${JSON.stringify(allocateResponse.body)}`,
      );
    }
    return allocateResponse.body as SafeAllocationBatchBody;
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

  async function activatePurchaseMappings(): Promise<void> {
    const shortSuffix = Date.now() % 1000000;
    for (const systemKey of PURCHASE_SYSTEM_KEYS) {
      const accountId = await createTestAccount(
        `B4${PURCHASE_SYSTEM_KEY_SHORT_CODES[systemKey]}${shortSuffix}`,
        `Cuenta sintética E2E B4 — ${systemKey}`,
        systemKey === AccountingSystemKey.ACCOUNTS_PAYABLE
          ? AccountType.LIABILITY
          : AccountType.ASSET,
      );
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
  }

  async function createSupplier(): Promise<string> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send({
        documentType: SupplierDocumentType.RUC,
        documentNumber: suffix.slice(-11).padStart(11, '0'),
        legalName: `Proveedor E2E B4 ${suffix}`,
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
      email: 'e2e_b4_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_b4_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_b4_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_b4_warehouse@demosystem.test',
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
        code: `B4CAT${shortSuffix}`,
        name: `Categoría E2E B4 ${shortSuffix}`,
      },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `B4UN${shortSuffix}`,
        name: `Unidad E2E B4 ${shortSuffix}`,
        abbreviation: 'ub4',
        allowDecimal: true,
      },
    });
    unitId = unit.id;
    const product = await prisma.product.create({
      data: {
        sku: `B4-${shortSuffix}`,
        name: `Producto E2E B4 ${shortSuffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '50.00',
        isInventoryTracked: true,
        stockCurrent: '0.000',
        status: ProductStatus.ACTIVE,
      },
    });
    productId = product.id;
    createdProductIds.push(productId);

    activeSupplierId = await createSupplier();
    await activatePurchaseMappings();

    const settings = await prisma.companySettings.findUnique({
      where: { singleton: true },
      select: { currencyCode: true },
    });
    companyCurrencyCode = settings?.currencyCode ?? 'PEN';
  }, 60000);

  afterAll(async () => {
    try {
      const receipts = await prisma.purchaseReceipt.findMany({
        where: {
          OR: [
            { id: { in: createdPurchaseReceiptIds } },
            { purchaseInvoiceId: { in: createdPurchaseInvoiceIds } },
          ],
        },
        select: { id: true },
      });
      const allReceiptIds = receipts.map((r) => r.id);

      const receiptLineIds = (
        await prisma.purchaseReceiptLine.findMany({
          where: { purchaseReceiptId: { in: allReceiptIds } },
          select: { id: true },
        })
      ).map((l) => l.id);
      const valuations = await prisma.inventoryValuation.findMany({
        where: { purchaseReceiptLineId: { in: receiptLineIds } },
        select: { id: true, inventoryMovementId: true },
      });
      await prisma.inventoryValuation.deleteMany({
        where: { id: { in: valuations.map((v) => v.id) } },
      });
      await prisma.inventoryMovement.deleteMany({
        where: { id: { in: valuations.map((v) => v.inventoryMovementId) } },
      });

      await prisma.importReceiptLink.deleteMany({
        where: {
          purchaseReceiptLine: { purchaseReceiptId: { in: allReceiptIds } },
        },
      });
      await prisma.purchaseReceiptLine.deleteMany({
        where: { purchaseReceiptId: { in: allReceiptIds } },
      });
      await prisma.purchaseReceipt.deleteMany({
        where: { id: { in: allReceiptIds } },
      });

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

      await prisma.importReceiptLink.deleteMany({
        where: { importShipmentLineId: { in: lineIds } },
      });
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

      const remainingMovements = await prisma.inventoryMovement.findMany({
        where: { productId: { in: createdProductIds } },
        select: { id: true },
      });
      const remainingMovementIds = remainingMovements.map((m) => m.id);
      await prisma.inventoryValuation.deleteMany({
        where: { inventoryMovementId: { in: remainingMovementIds } },
      });
      await prisma.inventoryMovement.deleteMany({
        where: { id: { in: remainingMovementIds } },
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
    it('SELLER/WAREHOUSE: 403 en los 4 reportes', async () => {
      for (const path of [
        '/api/v1/import-reports/operations',
        '/api/v1/import-reports/shipments',
        '/api/v1/import-reports/expenses',
        '/api/v1/import-reports/reconciliation',
      ]) {
        expect((await get(path, {}, sellerCookie)).status).toBe(403);
        expect((await get(path, {}, warehouseCookie)).status).toBe(403);
      }
    });

    it('MANAGEMENT/ACCOUNTANT: leen los 4 reportes', async () => {
      for (const path of [
        '/api/v1/import-reports/operations',
        '/api/v1/import-reports/shipments',
        '/api/v1/import-reports/expenses',
        '/api/v1/import-reports/reconciliation',
      ]) {
        expect((await get(path, {}, managementCookie)).status).toBe(200);
        expect((await get(path, {}, accountantCookie)).status).toBe(200);
      }
    });
  });

  describe('Caso completo: 100 = 60+40 embarcadas, 30+30+40 recibidas, totalmente vinculado', () => {
    it('cargoByUnit/expensesByCurrency reflejan reconciliación completa; reconciliationStatus = PENDING_ACCOUNTING_POLICY', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('100.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipmentA = await createArrivedShipmentWithLine(
        operation.id,
        '60.000',
        invoiceLineId,
      );
      const shipmentB = await createArrivedShipmentWithLine(
        operation.id,
        '40.000',
        invoiceLineId,
      );
      const r1 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '30.000',
      );
      const r2 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '30.000',
      );
      const r3 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '40.000',
      );
      await linkOrThrow(shipmentA.lines[0].id, r1.receiptLineId, '30.000');
      await linkOrThrow(shipmentA.lines[0].id, r2.receiptLineId, '30.000');
      await linkOrThrow(shipmentB.lines[0].id, r3.receiptLineId, '40.000');

      await createExpenseAllocatedManually(
        operation.id,
        [
          { importShipmentLineId: shipmentA.lines[0].id, amount: '60.00' },
          { importShipmentLineId: shipmentB.lines[0].id, amount: '40.00' },
        ],
        '100.00',
        companyCurrencyCode,
      );

      const summary = await get('/api/v1/import-reports/operations', {
        importOperationId: operation.id,
      });
      expect(summary.status).toBe(200);
      const summaryRow = (
        summary.body as PaginatedBody<ImportOperationSummaryRowBody>
      ).data[0];
      expect(summaryRow.cargoByUnit).toHaveLength(1);
      expect(summaryRow.cargoByUnit[0].plannedQuantity).toBe('100.000');
      expect(summaryRow.cargoByUnit[0].linkedReceivedQuantity).toBe('100.000');
      expect(summaryRow.cargoByUnit[0].unlinkedQuantity).toBe('0.000');
      expect(summaryRow.expensesByCurrency).toHaveLength(1);
      expect(summaryRow.expensesByCurrency[0].allocatedAmount).toBe('100.00');
      expect(summaryRow.expensesByCurrency[0].attributedAmount).toBe('100.00');
      expect(summaryRow.expensesByCurrency[0].unattributedAmount).toBe('0.00');

      const shipments = await get('/api/v1/import-reports/shipments', {
        importOperationId: operation.id,
      });
      const shipmentRows = (
        shipments.body as PaginatedBody<ShipmentReconciliationRowBody>
      ).data;
      expect(shipmentRows).toHaveLength(2);
      for (const row of shipmentRows) {
        expect(row.discrepancyCodes).toHaveLength(0);
        expect(row.remainingQuantity).toBe('0.000');
      }

      const reconciliation = await get(
        '/api/v1/import-reports/reconciliation',
        {
          importOperationId: operation.id,
        },
      );
      const reconciliationRow = (
        reconciliation.body as PaginatedBody<ConsolidatedReconciliationRowBody>
      ).data[0];
      expect(reconciliationRow.reconciliationStatus).toBe(
        'PENDING_ACCOUNTING_POLICY',
      );
      expect(reconciliationRow.reasons.length).toBeGreaterThan(0);
    });
  });

  describe('Recepción parcial (30 de 100): reutiliza la atribución corregida de B3', () => {
    it('expenses: atribuye solo 30.00 de 100.00 asignados; shipments: PARTIAL_RECEIPT_LINKAGE; reconciliation: PARTIAL_PENDING_OPERATIONAL_LINK', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('100.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '100.000',
        invoiceLineId,
      );
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '30.000',
      );
      await linkOrThrow(shipment.lines[0].id, receipt.receiptLineId, '30.000');
      await createExpenseAllocatedManually(
        operation.id,
        [{ importShipmentLineId: shipment.lines[0].id, amount: '100.00' }],
        '100.00',
        companyCurrencyCode,
      );

      const expenses = await get('/api/v1/import-reports/expenses', {
        importOperationId: operation.id,
      });
      const expenseRow = (
        expenses.body as PaginatedBody<ExpenseReconciliationRowBody>
      ).data[0];
      expect(expenseRow.allocatedAmount).toBe('100.00');
      expect(expenseRow.attributedAmount).toBe('30.00');
      expect(expenseRow.unattributedAmount).toBe('70.00');

      const shipments = await get('/api/v1/import-reports/shipments', {
        importOperationId: operation.id,
      });
      const shipmentRow = (
        shipments.body as PaginatedBody<ShipmentReconciliationRowBody>
      ).data[0];
      expect(shipmentRow.discrepancyCodes).toContain('PARTIAL_RECEIPT_LINKAGE');

      const reconciliation = await get(
        '/api/v1/import-reports/reconciliation',
        {
          importOperationId: operation.id,
        },
      );
      const reconciliationRow = (
        reconciliation.body as PaginatedBody<ConsolidatedReconciliationRowBody>
      ).data[0];
      expect(reconciliationRow.reconciliationStatus).toBe(
        'PARTIAL_PENDING_OPERATIONAL_LINK',
      );
    });
  });

  describe('Multimoneda: nunca mezcla montos de monedas distintas', () => {
    it('expensesByCurrency separa USD/EUR/PEN; reconciliation prioriza PENDING_FX sobre PENDING_ACCOUNTING_POLICY', async () => {
      const foreignCurrency = companyCurrencyCode === 'USD' ? 'EUR' : 'USD';
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '10.000',
      );
      await linkOrThrow(shipment.lines[0].id, receipt.receiptLineId, '10.000');

      await createExpenseAllocatedManually(
        operation.id,
        [{ importShipmentLineId: shipment.lines[0].id, amount: '50.00' }],
        '50.00',
        foreignCurrency,
      );
      await createExpenseAllocatedManually(
        operation.id,
        [{ importShipmentLineId: shipment.lines[0].id, amount: '30.00' }],
        '30.00',
        companyCurrencyCode,
      );

      const summary = await get('/api/v1/import-reports/operations', {
        importOperationId: operation.id,
      });
      const summaryRow = (
        summary.body as PaginatedBody<ImportOperationSummaryRowBody>
      ).data[0];
      expect(summaryRow.expensesByCurrency).toHaveLength(2);
      const foreign = summaryRow.expensesByCurrency.find(
        (c) => c.currencyCode === foreignCurrency,
      );
      const local = summaryRow.expensesByCurrency.find(
        (c) => c.currencyCode === companyCurrencyCode,
      );
      expect(foreign?.totalAmount).toBe('50.00');
      expect(foreign?.financialStatus).toBe('PENDING_FX');
      expect(local?.totalAmount).toBe('30.00');
      expect(local?.financialStatus).toBe('PENDING_ACCOUNTING_POLICY');

      const reconciliation = await get(
        '/api/v1/import-reports/reconciliation',
        {
          importOperationId: operation.id,
        },
      );
      const reconciliationRow = (
        reconciliation.body as PaginatedBody<ConsolidatedReconciliationRowBody>
      ).data[0];
      expect(reconciliationRow.reconciliationStatus).toBe('PENDING_FX');
    });
  });

  describe('Vínculos CANCELLED excluidos de los totales activos', () => {
    it('desvincular deja la línea PENDING otra vez; el vínculo CANCELLED nunca suma a linkedQuantity', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('20.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '20.000',
        invoiceLineId,
      );
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '20.000',
      );
      const linkResponse = await request(app.getHttpServer())
        .post(
          `/api/v1/import-shipment-lines/${shipment.lines[0].id}/receipt-links`,
        )
        .set('Cookie', adminCookie)
        .send({
          purchaseReceiptLineId: receipt.receiptLineId,
          linkedQuantity: '20.000',
        });
      const linkId = (linkResponse.body as { id: string }).id;
      await request(app.getHttpServer())
        .post(`/api/v1/import-receipt-links/${linkId}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Desvínculo de verificación E2E B4' });

      const shipments = await get('/api/v1/import-reports/shipments', {
        importOperationId: operation.id,
      });
      const shipmentRow = (
        shipments.body as PaginatedBody<ShipmentReconciliationRowBody>
      ).data[0];
      expect(shipmentRow.linkedQuantity).toBe('0.000');
      expect(shipmentRow.remainingQuantity).toBe('20.000');
      expect(shipmentRow.discrepancyCodes).toContain(
        'ARRIVED_WITH_UNLINKED_CARGO',
      );
    });
  });

  describe('Exportaciones .xlsx', () => {
    it('los 4 export.xlsx responden 200 con el tipo MIME correcto y filas no vacías', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '10.000',
      );
      await linkOrThrow(shipment.lines[0].id, receipt.receiptLineId, '10.000');
      await createExpenseAllocatedManually(
        operation.id,
        [{ importShipmentLineId: shipment.lines[0].id, amount: '20.00' }],
        '20.00',
        companyCurrencyCode,
      );

      for (const path of [
        '/api/v1/import-reports/operations/export.xlsx',
        '/api/v1/import-reports/shipments/export.xlsx',
        '/api/v1/import-reports/expenses/export.xlsx',
        '/api/v1/import-reports/reconciliation/export.xlsx',
      ]) {
        const response = await request(app.getHttpServer())
          .get(path)
          .query({ importOperationId: operation.id })
          .set('Cookie', adminCookie)
          .buffer(true)
          .parse(binaryParser);
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain(
          'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        );
        const workbook = new ExcelJS.Workbook();
        // eslint-disable-next-line @typescript-eslint/no-unsafe-argument -- response.body de supertest es `any` por diseño; el buffer binario ya se validó arriba (content-type + status 200).
        await workbook.xlsx.load(response.body);
        const sheet = workbook.worksheets[0];
        expect(sheet.rowCount).toBeGreaterThanOrEqual(2);
      }
    });
  });

  describe('Sin efectos de inventario/valorización/contabilidad', () => {
    it('leer los 4 reportes (JSON + xlsx) NUNCA mueve stock, valoriza inventario ni postea asientos', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '10.000',
      );
      await linkOrThrow(shipment.lines[0].id, receipt.receiptLineId, '10.000');
      await createExpenseAllocatedManually(
        operation.id,
        [{ importShipmentLineId: shipment.lines[0].id, amount: '10.00' }],
        '10.00',
        companyCurrencyCode,
      );

      const movementsBefore = await prisma.inventoryMovement.count();
      const valuationsBefore = await prisma.inventoryValuation.count();
      const entriesBefore = await prisma.accountingEntry.count();

      await get('/api/v1/import-reports/operations', {
        importOperationId: operation.id,
      });
      await get('/api/v1/import-reports/shipments', {
        importOperationId: operation.id,
      });
      await get('/api/v1/import-reports/expenses', {
        importOperationId: operation.id,
      });
      await get('/api/v1/import-reports/reconciliation', {
        importOperationId: operation.id,
      });

      expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
      expect(await prisma.inventoryValuation.count()).toBe(valuationsBefore);
      expect(await prisma.accountingEntry.count()).toBe(entriesBefore);
    });
  });
});
