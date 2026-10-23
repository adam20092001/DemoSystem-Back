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
 * Fase B3 — Vínculos de recepción de importación y previsualización de
 * atribución de costo. Suite dedicada y aislada: limpia exclusivamente
 * por los ids que ella misma crea. Verifica explícitamente que NINGUNA
 * acción de este módulo mueve inventario, valoriza ni postea asientos
 * contables — el único efecto persistente es la propia fila
 * ImportReceiptLink.
 */

interface SafeImportOperationBody {
  id: string;
  status: string;
}

interface SafeImportShipmentLineBody {
  id: string;
  purchaseInvoiceLineId: string | null;
}

interface SafeImportShipmentBody {
  id: string;
  status: string;
  lines: SafeImportShipmentLineBody[];
}

interface SafePurchaseInvoiceBody {
  id: string;
  status: string;
  lines: { id: string; productId: string | null }[];
}

interface SafePurchaseReceiptLineBody {
  id: string;
  purchaseInvoiceLineId: string;
  quantity: string;
}

interface SafePurchaseReceiptBody {
  id: string;
  status: 'ACTIVE' | 'CANCELLED';
  lines: SafePurchaseReceiptLineBody[];
}

interface SafeImportReceiptLinkBody {
  id: string;
  importShipmentLineId: string;
  purchaseReceiptLineId: string;
  linkedQuantity: string;
  status: 'ACTIVE' | 'CANCELLED';
}

interface SafeShipmentLineReceptionSummaryBody {
  importShipmentLineId: string;
  shippedQuantity: string;
  linkedReceivedQuantity: string;
  remainingQuantity: string;
  receptionStatus: 'PENDING' | 'PARTIALLY_RECEIVED' | 'FULLY_RECEIVED';
  links: SafeImportReceiptLinkBody[];
}

interface SafeCostAttributionPreviewBody {
  importExpenseAllocationId: string;
  currencyCode: string;
  allocatedAmount: string;
  lines: {
    purchaseReceiptLineId: string;
    importReceiptLinkId: string;
    receivedQuantity: string;
    attributedAmount: string;
  }[];
  unattributedAmount: string;
  financialStatus: 'PENDING_FX' | 'PENDING_ACCOUNTING_POLICY';
}

interface SafeAllocationBatchBody {
  allocations: { id: string; importShipmentLineId: string; amount: string }[];
}

const ADMIN_READ_PATH = (id: string) =>
  `/api/v1/import-shipment-lines/${id}/receipt-links`;

const MANAGEMENT_USERNAME = 'e2e_b3_management';
const ACCOUNTANT_USERNAME = 'e2e_b3_accountant';
const SELLER_USERNAME = 'e2e_b3_seller';
const WAREHOUSE_USERNAME = 'e2e_b3_warehouse';
const FIXTURE_PASSWORD = 'E2eB3Fixture2026Aa';

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

describe('Import Receipt Links — Fase B3 (e2e)', () => {
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

  function departShipment(
    shipmentId: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-shipments/${shipmentId}/depart`)
      .set('Cookie', cookie)
      .send({});
  }

  function arriveShipment(
    shipmentId: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-shipments/${shipmentId}/arrive`)
      .set('Cookie', cookie)
      .send({});
  }

  function createInvoice(
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/purchase-invoices')
      .set('Cookie', cookie)
      .send(body);
  }

  function confirmInvoice(
    id: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set('Cookie', cookie)
      .send({});
  }

  function createReceipt(
    invoiceId: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${invoiceId}/receipts`)
      .set('Cookie', cookie)
      .send(body);
  }

  function cancelReceipt(
    id: string,
    reason: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-receipts/${id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  function createLink(
    shipmentLineId: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-shipment-lines/${shipmentLineId}/receipt-links`)
      .set('Cookie', cookie)
      .send(body);
  }

  function listLinks(
    shipmentLineId: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(ADMIN_READ_PATH(shipmentLineId))
      .set('Cookie', cookie);
  }

  function cancelLink(
    linkId: string,
    reason: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/import-receipt-links/${linkId}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  function previewCostAttribution(
    allocationId: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(
        `/api/v1/import-expense-allocations/${allocationId}/cost-attribution-preview`,
      )
      .set('Cookie', cookie);
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
        `B3${PURCHASE_SYSTEM_KEY_SHORT_CODES[systemKey]}${shortSuffix}`,
        `Cuenta sintética E2E B3 — ${systemKey}`,
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
        legalName: `Proveedor E2E B3 ${suffix}`,
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

  /** Factura CONFIRMED con UNA línea GOOD+producto fixture, cantidad configurable. */
  async function createConfirmedInvoiceLine(quantity: string): Promise<string> {
    const suffix = nextSuffix();
    const draft = await createInvoice({
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

    const confirmed = await confirmInvoice(invoice.id);
    if (confirmed.status !== 200) {
      throw new Error(
        `No se pudo confirmar la factura fixture: ${JSON.stringify(confirmed.body)}`,
      );
    }
    return (confirmed.body as SafePurchaseInvoiceBody).lines[0].id;
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

  /** Embarque con UNA línea, opcionalmente vinculada a una factura, y lo lleva a ARRIVED. */
  async function createArrivedShipmentWithLine(
    operationId: string,
    plannedQuantity: string,
    purchaseInvoiceLineId?: string,
  ): Promise<SafeImportShipmentBody> {
    const response = await createShipment(operationId, {
      transportMode: ImportTransportMode.SEA,
      lines: [
        {
          descriptionSnapshot: 'Carga E2E B3',
          plannedQuantity,
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
    const departed = await departShipment(shipment.id);
    if (departed.status !== 200) {
      throw new Error(
        `No se pudo embarcar (depart) el fixture: ${JSON.stringify(departed.body)}`,
      );
    }
    const arrived = await arriveShipment(shipment.id);
    if (arrived.status !== 200) {
      throw new Error(
        `No se pudo arribar (arrive) el fixture: ${JSON.stringify(arrived.body)}`,
      );
    }
    return arrived.body as SafeImportShipmentBody;
  }

  async function createActiveReceiptLine(
    invoiceId: string,
    invoiceLineId: string,
    quantity: string,
  ): Promise<{ receiptId: string; receiptLineId: string }> {
    const response = await createReceipt(invoiceId, {
      lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity }],
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la recepción fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const receipt = response.body as SafePurchaseReceiptBody;
    createdPurchaseReceiptIds.push(receipt.id);
    return { receiptId: receipt.id, receiptLineId: receipt.lines[0].id };
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
      email: 'e2e_b3_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_b3_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_b3_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_b3_warehouse@demosystem.test',
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
        code: `B3CAT${shortSuffix}`,
        name: `Categoría E2E B3 ${shortSuffix}`,
      },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `B3UN${shortSuffix}`,
        name: `Unidad E2E B3 ${shortSuffix}`,
        abbreviation: 'ub3',
        allowDecimal: true,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: `B3-${shortSuffix}`,
        name: `Producto E2E B3 ${shortSuffix}`,
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

      await prisma.importReceiptLink.deleteMany({
        where: {
          purchaseReceiptLine: { purchaseReceiptId: { in: allReceiptIds } },
        },
      });

      // La recepción física (A5.2b, ajena a B3) valoriza inventario vía
      // InventoryValuationEngine — hay que soltar esas filas (y el
      // InventoryMovement que cada una referencia con Restrict) antes de
      // poder borrar las líneas de recepción y, más adelante, el producto.
      const receiptLineIds = await prisma.purchaseReceiptLine.findMany({
        where: { purchaseReceiptId: { in: allReceiptIds } },
        select: { id: true },
      });
      const valuations = await prisma.inventoryValuation.findMany({
        where: {
          purchaseReceiptLineId: { in: receiptLineIds.map((l) => l.id) },
        },
        select: { id: true, inventoryMovementId: true },
      });
      const valuationMovementIds = valuations.map((v) => v.inventoryMovementId);
      await prisma.inventoryValuation.deleteMany({
        where: { id: { in: valuations.map((v) => v.id) } },
      });
      await prisma.inventoryMovement.deleteMany({
        where: { id: { in: valuationMovementIds } },
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

      // Red de seguridad: cualquier movimiento/valorización residual del
      // producto fixture que no haya quedado cubierto arriba.
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
    it('SELLER/WAREHOUSE: 403 en lectura y escritura', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const { receiptLineId } = await createActiveReceiptLine(
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1],
        invoiceLineId,
        '10.000',
      );

      const list = await listLinks(shipment.lines[0].id, sellerCookie);
      expect(list.status).toBe(403);

      const create = await createLink(
        shipment.lines[0].id,
        { purchaseReceiptLineId: receiptLineId, linkedQuantity: '10.000' },
        warehouseCookie,
      );
      expect(create.status).toBe(403);
    });

    it('MANAGEMENT/ACCOUNTANT: leen pero no pueden vincular', async () => {
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const { receiptLineId } = await createActiveReceiptLine(
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1],
        invoiceLineId,
        '10.000',
      );

      const list = await listLinks(shipment.lines[0].id, managementCookie);
      expect(list.status).toBe(200);

      const create = await createLink(
        shipment.lines[0].id,
        { purchaseReceiptLineId: receiptLineId, linkedQuantity: '10.000' },
        accountantCookie,
      );
      expect(create.status).toBe(403);
    });
  });

  describe('Caso completo: dos embarques, tres recepciones parciales (100 = 60+40 = 30+30+40)', () => {
    it('vincula sin duplicar cantidades y deriva el estado de recepción correctamente', async () => {
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

      const receipt1 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '30.000',
      );
      const receipt2 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '30.000',
      );
      const receipt3 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '40.000',
      );

      const link1 = await createLink(shipmentA.lines[0].id, {
        purchaseReceiptLineId: receipt1.receiptLineId,
        linkedQuantity: '30.000',
      });
      expect(link1.status).toBe(201);

      const summaryAfterFirst = (await listLinks(shipmentA.lines[0].id))
        .body as SafeShipmentLineReceptionSummaryBody;
      expect(summaryAfterFirst.receptionStatus).toBe('PARTIALLY_RECEIVED');
      expect(summaryAfterFirst.linkedReceivedQuantity).toBe('30.000');
      expect(summaryAfterFirst.remainingQuantity).toBe('30.000');

      const link2 = await createLink(shipmentA.lines[0].id, {
        purchaseReceiptLineId: receipt2.receiptLineId,
        linkedQuantity: '30.000',
      });
      expect(link2.status).toBe(201);

      const summaryShipmentA = (await listLinks(shipmentA.lines[0].id))
        .body as SafeShipmentLineReceptionSummaryBody;
      expect(summaryShipmentA.receptionStatus).toBe('FULLY_RECEIVED');
      expect(summaryShipmentA.linkedReceivedQuantity).toBe('60.000');
      expect(summaryShipmentA.remainingQuantity).toBe('0.000');

      const link3 = await createLink(shipmentB.lines[0].id, {
        purchaseReceiptLineId: receipt3.receiptLineId,
        linkedQuantity: '40.000',
      });
      expect(link3.status).toBe(201);

      const summaryShipmentB = (await listLinks(shipmentB.lines[0].id))
        .body as SafeShipmentLineReceptionSummaryBody;
      expect(summaryShipmentB.receptionStatus).toBe('FULLY_RECEIVED');
      expect(summaryShipmentB.linkedReceivedQuantity).toBe('40.000');
    });
  });

  describe('Guardias de cantidad, estado y consistencia', () => {
    it('excede la cantidad embarcada de la línea: 409, nunca crea el vínculo', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('50.000');
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
        '50.000',
      );

      const result = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '30.000',
      });
      expect(result.status).toBe(409);
    });

    it('excede la cantidad físicamente recibida de la recepción: 409', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('50.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '50.000',
        invoiceLineId,
      );
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '20.000',
      );

      const result = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '30.000',
      });
      expect(result.status).toBe(409);
    });

    it('embarque todavía no ARRIVED: 409', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipmentResponse = await createShipment(operation.id, {
        transportMode: ImportTransportMode.SEA,
        lines: [
          {
            descriptionSnapshot: 'Sin arribar',
            plannedQuantity: '10.000',
            purchaseInvoiceLineId: invoiceLineId,
          },
        ],
      });
      expect(shipmentResponse.status).toBe(201);
      const shipment = shipmentResponse.body as SafeImportShipmentBody;
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '10.000',
      );

      const result = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '10.000',
      });
      expect(result.status).toBe(409);
    });

    it('recepción CANCELLED: 409', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '10.000',
      );
      const cancelled = await cancelReceipt(
        receipt.receiptId,
        'Anulación válida sin vínculos activos',
      );
      expect(cancelled.status).toBe(200);

      const result = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '10.000',
      });
      expect(result.status).toBe(409);
    });

    it('factura distinta entre línea de embarque y recepción: 400', async () => {
      const invoiceLineA = await createConfirmedInvoiceLine('10.000');
      const invoiceLineB = await createConfirmedInvoiceLine('10.000');
      const invoiceIdB =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineA,
      );
      const receipt = await createActiveReceiptLine(
        invoiceIdB,
        invoiceLineB,
        '10.000',
      );

      const result = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '10.000',
      });
      expect(result.status).toBe(400);
    });

    it('idempotencyKey repetida: devuelve el mismo vínculo, nunca crea otro', async () => {
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
      const key = `idem-${nextSuffix()}`;

      const first = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '20.000',
        idempotencyKey: key,
      });
      expect(first.status).toBe(201);
      const firstId = (first.body as SafeImportReceiptLinkBody).id;

      const replay = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '20.000',
        idempotencyKey: key,
      });
      expect(replay.status).toBe(201);
      expect((replay.body as SafeImportReceiptLinkBody).id).toBe(firstId);

      const summary = (await listLinks(shipment.lines[0].id))
        .body as SafeShipmentLineReceptionSummaryBody;
      expect(summary.links).toHaveLength(1);
    });

    it('vínculo ACTIVO duplicado entre la misma línea de embarque y recepción: 409', async () => {
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

      const first = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '10.000',
      });
      expect(first.status).toBe(201);

      const duplicate = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '5.000',
      });
      expect(duplicate.status).toBe(409);
    });

    it('dos vinculaciones concurrentes que juntas exceden lo embarcado: exactamente una se rechaza', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('15.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const receiptX = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '6.000',
      );
      const receiptY = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '6.000',
      );

      const [first, second] = await Promise.all([
        createLink(shipment.lines[0].id, {
          purchaseReceiptLineId: receiptX.receiptLineId,
          linkedQuantity: '6.000',
        }),
        createLink(shipment.lines[0].id, {
          purchaseReceiptLineId: receiptY.receiptLineId,
          linkedQuantity: '6.000',
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
    });
  });

  describe('Desvínculo explícito y guardia de anulación de recepción', () => {
    it('anular una recepción con vínculo ACTIVO: 409; desvincular primero y luego anular: 200', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('15.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '15.000',
        invoiceLineId,
      );
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '15.000',
      );
      const link = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '15.000',
      });
      expect(link.status).toBe(201);
      const linkId = (link.body as SafeImportReceiptLinkBody).id;

      const blockedCancel = await cancelReceipt(
        receipt.receiptId,
        'Intento de anulación con vínculo activo',
      );
      expect(blockedCancel.status).toBe(409);

      const unlink = await cancelLink(linkId, 'Desvínculo previo a anulación');
      expect(unlink.status).toBe(200);
      expect((unlink.body as SafeImportReceiptLinkBody).status).toBe(
        'CANCELLED',
      );

      const allowedCancel = await cancelReceipt(
        receipt.receiptId,
        'Anulación válida tras desvincular',
      );
      expect(allowedCancel.status).toBe(200);
    });

    it('cancelar un vínculo ya CANCELLED: 409', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('5.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '5.000',
        invoiceLineId,
      );
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '5.000',
      );
      const link = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '5.000',
      });
      const linkId = (link.body as SafeImportReceiptLinkBody).id;

      const firstCancel = await cancelLink(linkId, 'motivo');
      expect(firstCancel.status).toBe(200);

      const secondCancel = await cancelLink(linkId, 'motivo repetido');
      expect(secondCancel.status).toBe(409);
    });
  });

  describe('Previsualización de atribución de costo (reutiliza el cálculo de B2)', () => {
    async function createExpenseAllocatedTo(
      operationId: string,
      shipmentLineId: string,
      amount: string,
      currencyCode: string,
    ): Promise<string> {
      const expenseResponse = await request(app.getHttpServer())
        .post(`/api/v1/import-operations/${operationId}/expenses`)
        .set('Cookie', adminCookie)
        .send({
          category: ImportExpenseCategory.FREIGHT,
          expenseDate: businessToday(),
          currencyCode,
          amount,
        });
      expect(expenseResponse.status).toBe(201);
      const expenseId = (expenseResponse.body as { id: string }).id;

      const allocateResponse = await request(app.getHttpServer())
        .post(`/api/v1/import-expenses/${expenseId}/allocate`)
        .set('Cookie', adminCookie)
        .send({
          method: ImportExpenseAllocationMethod.MANUAL,
          amountToAllocate: amount,
          manualAllocations: [{ importShipmentLineId: shipmentLineId, amount }],
        });
      expect(allocateResponse.status).toBe(201);
      return (allocateResponse.body as SafeAllocationBatchBody).allocations[0]
        .id;
    }

    it('reparte el monto asignado proporcionalmente a las recepciones vinculadas (suma exacta)', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('100.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '100.000',
        invoiceLineId,
      );
      const receipt1 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '30.000',
      );
      const receipt2 = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '70.000',
      );
      await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt1.receiptLineId,
        linkedQuantity: '30.000',
      });
      await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt2.receiptLineId,
        linkedQuantity: '70.000',
      });

      const allocationId = await createExpenseAllocatedTo(
        operation.id,
        shipment.lines[0].id,
        '100.00',
        companyCurrencyCode,
      );

      const preview = await previewCostAttribution(allocationId);
      expect(preview.status).toBe(200);
      const body = preview.body as SafeCostAttributionPreviewBody;
      expect(body.lines).toHaveLength(2);
      const sum = body.lines.reduce(
        (s, l) => s + Number(l.attributedAmount),
        0,
      );
      expect(sum.toFixed(2)).toBe('100.00');
      expect(body.unattributedAmount).toBe('0.00');
      expect(body.financialStatus).toBe('PENDING_ACCOUNTING_POLICY');
    });

    it('recepción PARCIAL (30 de 100 embarcadas): nunca atribuye el gasto completo a las primeras unidades recibidas', async () => {
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
      await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '30.000',
      });

      const allocationId = await createExpenseAllocatedTo(
        operation.id,
        shipment.lines[0].id,
        '100.00',
        companyCurrencyCode,
      );

      const preview = await previewCostAttribution(allocationId);
      expect(preview.status).toBe(200);
      const body = preview.body as SafeCostAttributionPreviewBody;
      expect(body.allocatedAmount).toBe('100.00');
      expect(body.lines).toHaveLength(1);
      expect(body.lines[0].attributedAmount).toBe('30.00');
      expect(body.unattributedAmount).toBe('70.00');
    });

    it('moneda del gasto distinta de la moneda de la empresa: financialStatus PENDING_FX', async () => {
      const foreignCurrency = companyCurrencyCode === 'USD' ? 'EUR' : 'USD';
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );

      const allocationId = await createExpenseAllocatedTo(
        operation.id,
        shipment.lines[0].id,
        '50.00',
        foreignCurrency,
      );

      const preview = await previewCostAttribution(allocationId);
      expect(preview.status).toBe(200);
      expect(
        (preview.body as SafeCostAttributionPreviewBody).financialStatus,
      ).toBe('PENDING_FX');
    });

    it('sin vínculos ACTIVE: lines vacío, nunca falla', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const allocationId = await createExpenseAllocatedTo(
        operation.id,
        shipment.lines[0].id,
        '30.00',
        companyCurrencyCode,
      );

      const preview = await previewCostAttribution(allocationId);
      expect(preview.status).toBe(200);
      expect(
        (preview.body as SafeCostAttributionPreviewBody).lines,
      ).toHaveLength(0);
    });

    it('SELLER/WAREHOUSE sin acceso a la previsualización: 403', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const allocationId = await createExpenseAllocatedTo(
        operation.id,
        shipment.lines[0].id,
        '30.00',
        companyCurrencyCode,
      );

      expect(
        (await previewCostAttribution(allocationId, sellerCookie)).status,
      ).toBe(403);
      expect(
        (await previewCostAttribution(allocationId, warehouseCookie)).status,
      ).toBe(403);
      expect(
        (await previewCostAttribution(allocationId, managementCookie)).status,
      ).toBe(200);
      expect(
        (await previewCostAttribution(allocationId, accountantCookie)).status,
      ).toBe(200);
    });
  });

  describe('Sin efectos de inventario/valorización/contabilidad y auditoría', () => {
    it('vincular y desvincular NUNCA mueve stock, valoriza inventario ni postea asientos; audita ambas acciones', async () => {
      const invoiceLineId = await createConfirmedInvoiceLine('10.000');
      const invoiceId =
        createdPurchaseInvoiceIds[createdPurchaseInvoiceIds.length - 1];
      const operation = await createOperationOrThrow(`IMP-${nextSuffix()}`);
      const shipment = await createArrivedShipmentWithLine(
        operation.id,
        '10.000',
        invoiceLineId,
      );
      const receipt = await createActiveReceiptLine(
        invoiceId,
        invoiceLineId,
        '10.000',
      );

      // La propia RECEPCIÓN física ya mueve stock/valoriza (A5.2b, ajeno a
      // B3) — las cuentas "before" se toman DESPUÉS de ese efecto legítimo,
      // para aislar exclusivamente el efecto de vincular/desvincular.
      const movementsBefore = await prisma.inventoryMovement.count();
      const valuationsBefore = await prisma.inventoryValuation.count();
      const entriesBefore = await prisma.accountingEntry.count();

      const link = await createLink(shipment.lines[0].id, {
        purchaseReceiptLineId: receipt.receiptLineId,
        linkedQuantity: '10.000',
      });
      expect(link.status).toBe(201);
      const linkId = (link.body as SafeImportReceiptLinkBody).id;

      const unlink = await cancelLink(linkId, 'Desvínculo de verificación');
      expect(unlink.status).toBe(200);

      expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
      expect(await prisma.inventoryValuation.count()).toBe(valuationsBefore);
      expect(await prisma.accountingEntry.count()).toBe(entriesBefore);

      const auditRows = await prisma.auditLog.findMany({
        where: { entityType: 'ImportReceiptLink', entityId: linkId },
        select: { action: true },
      });
      const actions = auditRows.map((r) => r.action).sort();
      expect(actions).toEqual(
        ['IMPORT_RECEIPT_LINK_CANCELLED', 'IMPORT_RECEIPT_LINK_CREATED'].sort(),
      );
    });
  });
});
