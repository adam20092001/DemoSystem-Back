import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSourceType,
  AccountingSystemKey,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
  RoleName,
  SupplierDocumentType,
  WarehouseStatus,
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
import { createProductRow, deleteProductRows } from './helpers/stock-fixtures';

/**
 * Fase A5.2b — Recepciones físicas de mercadería. Suite dedicada y
 * aislada (mismo criterio ya usado por purchase-invoices.e2e-spec.ts):
 * limpia exclusivamente por los ids que ella misma crea. Reutiliza el
 * mismo patrón de activación de mapeos SINTÉTICOS de A5.2a para poder
 * confirmar facturas reales dentro de esta suite.
 */

interface SafePurchaseReceiptLineBody {
  id: string;
  purchaseInvoiceLineId: string;
  quantity: string;
  reclassifiedAmount: string | null;
}

interface SafePurchaseReceiptBody {
  id: string;
  purchaseInvoiceId: string;
  receivedDate: string;
  status: 'ACTIVE' | 'CANCELLED';
  idempotencyKey: string | null;
  notes: string | null;
  createdByUserId: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  reclassificationEntryId: string | null;
  lines: SafePurchaseReceiptLineBody[];
}

interface PurchaseInvoiceReceiptsSummaryBody {
  purchaseInvoiceId: string;
  receipts: SafePurchaseReceiptBody[];
  lines: {
    purchaseInvoiceLineId: string;
    invoicedQuantity: string;
    receivedQuantity: string;
    pendingQuantity: string;
    status: 'PENDING' | 'PARTIAL' | 'COMPLETE';
  }[];
}

interface SafePurchaseInvoiceBody {
  id: string;
  status: string;
  lines: {
    id: string;
    productId: string | null;
    isReceiptEligible: boolean | null;
  }[];
}

interface SafeAccountBody {
  id: string;
  code: string;
}

const ACCOUNTANT_USERNAME = 'e2e_a52b_accountant';
const MANAGEMENT_USERNAME = 'e2e_a52b_management';
const SELLER_USERNAME = 'e2e_a52b_seller';
const WAREHOUSE_USERNAME = 'e2e_a52b_warehouse';
const FIXTURE_PASSWORD = 'E2eA52bFixture2026Aa';
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

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

describe('Purchase Receipts — Fase A5.2b (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;
  let trackedProductId: string;
  let serviceProductId: string;
  let activeSupplierId: string;
  let resaleInventoryAccountId: string;
  let finalInventoryAccountId: string | null = null;

  const createdAccountIds: string[] = [];
  const createdPurchaseInvoiceIds: string[] = [];
  const createdPurchaseReceiptIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdWarehouseIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
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

  function cancelInvoice(
    id: string,
    reason: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
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

  function listReceipts(
    invoiceId: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/purchase-invoices/${invoiceId}/receipts`)
      .set('Cookie', cookie);
  }

  function getReceipt(
    id: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/purchase-receipts/${id}`)
      .set('Cookie', cookie);
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

  async function createTestAccount(
    code: string,
    name: string,
    type: AccountType = AccountType.ASSET,
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
    const created = response.body as SafeAccountBody;
    createdAccountIds.push(created.id);
    return created.id;
  }

  async function activatePurchaseMappings(): Promise<void> {
    const shortSuffix = Date.now() % 1000000;
    for (const systemKey of PURCHASE_SYSTEM_KEYS) {
      const accountId = await createTestAccount(
        `A52B${PURCHASE_SYSTEM_KEY_SHORT_CODES[systemKey]}${shortSuffix}`,
        `Cuenta sintética E2E A5.2b — ${systemKey}`,
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
      if (systemKey === AccountingSystemKey.PURCHASE_RESALE_INVENTORY) {
        resaleInventoryAccountId = accountId;
      }
    }
  }

  function validSupplierBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const suffix = nextSuffix();
    return {
      documentType: SupplierDocumentType.RUC,
      documentNumber: suffix.slice(-11).padStart(11, '0'),
      legalName: `Proveedor E2E A5.2b ${suffix}`,
      ...overrides,
    };
  }

  async function createSupplier(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send(validSupplierBody());
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el proveedor fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as { id: string };
    createdSupplierIds.push(body.id);
    return body.id;
  }

  /**
   * Producto rastreado DEDICADO (nunca el trackedProductId compartido):
   * necesario en pruebas que afirman un stockCurrent ABSOLUTO — el
   * compartido acumula stock de muchas otras pruebas de este archivo.
   */
  async function createDedicatedTrackedProduct(): Promise<string> {
    const suffix = nextSuffix();
    const product = await createProductRow(prisma, {
      data: {
        sku: `A52B-D-${suffix}`,
        name: `Producto dedicado E2E A5.2b ${suffix}`,
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
    return product.id;
  }

  /** Factura CONFIRMED con UNA línea GOOD+producto indicado, cantidad/costo configurables. */
  async function createConfirmedInvoiceWithGoodLine(
    quantity: string,
    unitCost = '10.00',
    productId: string = trackedProductId,
  ): Promise<{ invoiceId: string; invoiceLineId: string }> {
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
          unitCost,
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
    const confirmedBody = confirmed.body as SafePurchaseInvoiceBody;
    return { invoiceId: invoice.id, invoiceLineId: confirmedBody.lines[0].id };
  }

  async function createDefaultReceipt(
    invoiceId: string,
    invoiceLineId: string,
    quantity: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafePurchaseReceiptBody> {
    const response = await createReceipt(invoiceId, {
      lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity }],
      ...overrides,
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la recepción fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafePurchaseReceiptBody;
    createdPurchaseReceiptIds.push(body.id);
    return body;
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
      email: 'e2e_a52b_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_a52b_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a52b_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a52b_warehouse@demosystem.test',
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
        code: `A52BCAT${shortSuffix}`,
        name: `Categoría E2E A5.2b ${shortSuffix}`,
      },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `A52BUN${shortSuffix}`,
        name: `Unidad E2E A5.2b ${shortSuffix}`,
        abbreviation: 'u52b',
        allowDecimal: true,
      },
    });
    unitId = unit.id;

    const suffix = nextSuffix();
    const trackedProduct = await createProductRow(prisma, {
      data: {
        sku: `A52B-T-${suffix}`,
        name: `Producto rastreado E2E A5.2b ${suffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '50.00',
        isInventoryTracked: true,
        stockCurrent: '0.000',
        status: ProductStatus.ACTIVE,
      },
    });
    trackedProductId = trackedProduct.id;
    createdProductIds.push(trackedProductId);

    const serviceProduct = await createProductRow(prisma, {
      data: {
        sku: `A52B-S-${suffix}`,
        name: `Servicio E2E A5.2b ${suffix}`,
        productType: ProductType.SERVICE,
        categoryId,
        unitId,
        salePrice: '30.00',
        isInventoryTracked: false,
        status: ProductStatus.ACTIVE,
      },
    });
    serviceProductId = serviceProduct.id;
    createdProductIds.push(serviceProductId);

    activeSupplierId = await createSupplier();

    await activatePurchaseMappings();
  }, 60000);

  afterAll(async () => {
    try {
      // Recepciones: soltar reclassificationEntryId -> AccountingEntry
      // (RESTRICT) antes de poder borrar el propio asiento. Red de
      // seguridad: además de los ids explícitamente rastreados, busca por
      // purchaseInvoiceId (la propia FK que bloquearía el borrado de la
      // factura) para que un id de recepción no rastreado por error en
      // algún test nunca deje un huérfano que rompa este afterAll.
      const receipts = await prisma.purchaseReceipt.findMany({
        where: {
          OR: [
            { id: { in: createdPurchaseReceiptIds } },
            { purchaseInvoiceId: { in: createdPurchaseInvoiceIds } },
          ],
        },
        select: { id: true, reclassificationEntryId: true },
      });
      const allReceiptIds = receipts.map((r) => r.id);
      const reclassificationEntryIds = receipts
        .map((r) => r.reclassificationEntryId)
        .filter((id): id is string => id !== null);

      await prisma.purchaseReceiptLine.deleteMany({
        where: { purchaseReceiptId: { in: allReceiptIds } },
      });
      await prisma.purchaseReceipt.deleteMany({
        where: { id: { in: allReceiptIds } },
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

      const allOriginalIds = [...postedEntryIds, ...reclassificationEntryIds];
      if (allOriginalIds.length > 0) {
        const reversals = await prisma.accountingEntry.findMany({
          where: { reversesEntryId: { in: allOriginalIds } },
          select: { id: true },
        });
        const allEntryIds = [...allOriginalIds, ...reversals.map((r) => r.id)];
        await prisma.accountingEntryLine.deleteMany({
          where: { entryId: { in: allEntryIds } },
        });
        await prisma.accountingEntry.deleteMany({
          where: { id: { in: allEntryIds } },
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
      if (createdWarehouseIds.length > 0) {
        const locations = await prisma.warehouseLocation.findMany({
          where: { warehouseId: { in: createdWarehouseIds } },
          select: { id: true },
        });
        await prisma.auditLog.deleteMany({
          where: {
            entityId: {
              in: [...createdWarehouseIds, ...locations.map((l) => l.id)],
            },
          },
        });
        await prisma.warehouseLocation.deleteMany({
          where: { warehouseId: { in: createdWarehouseIds } },
        });
        await prisma.warehouse.deleteMany({
          where: { id: { in: createdWarehouseIds } },
        });
      }
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
      await prisma.$disconnect();
    }
  }, 60000);

  // ====================================================================
  // RBAC
  // ====================================================================
  describe('RBAC', () => {
    it('SELLER: 403 en todos los endpoints', async () => {
      const cookie = sellerCookie;
      expect((await listReceipts(NON_EXISTENT_UUID, cookie)).status).toBe(403);
      expect((await getReceipt(NON_EXISTENT_UUID, cookie)).status).toBe(403);
      expect(
        (
          await createReceipt(
            NON_EXISTENT_UUID,
            {
              lines: [
                {
                  purchaseInvoiceLineId: NON_EXISTENT_UUID,
                  quantity: '1.000',
                },
              ],
            },
            cookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (await cancelReceipt(NON_EXISTENT_UUID, 'motivo', cookie)).status,
      ).toBe(403);
    });

    it('R1: WAREHOUSE lee y registra la recepción física (atraviesa la guardia: 404 por ids inexistentes), pero nunca la anula (403)', async () => {
      const cookie = warehouseCookie;
      expect((await listReceipts(NON_EXISTENT_UUID, cookie)).status).toBe(404);
      expect((await getReceipt(NON_EXISTENT_UUID, cookie)).status).toBe(404);
      expect(
        (
          await createReceipt(
            NON_EXISTENT_UUID,
            {
              lines: [
                {
                  purchaseInvoiceLineId: NON_EXISTENT_UUID,
                  quantity: '1.000',
                },
              ],
            },
            cookie,
          )
        ).status,
      ).toBe(404);
      expect(
        (await cancelReceipt(NON_EXISTENT_UUID, 'motivo', cookie)).status,
      ).toBe(403);
    });

    it('MANAGEMENT/ACCOUNTANT: leen pero nunca escriben', async () => {
      for (const cookie of [managementCookie, accountantCookie]) {
        expect((await listReceipts(NON_EXISTENT_UUID, cookie)).status).toBe(
          404,
        );
        expect(
          (
            await createReceipt(
              NON_EXISTENT_UUID,
              {
                lines: [
                  {
                    purchaseInvoiceLineId: NON_EXISTENT_UUID,
                    quantity: '1.000',
                  },
                ],
              },
              cookie,
            )
          ).status,
        ).toBe(403);
        expect(
          (await cancelReceipt(NON_EXISTENT_UUID, 'motivo', cookie)).status,
        ).toBe(403);
      }
    });
  });

  // ====================================================================
  // create — validaciones
  // ====================================================================
  describe('create', () => {
    it('factura inexistente: 404', async () => {
      const response = await createReceipt(NON_EXISTENT_UUID, {
        lines: [
          { purchaseInvoiceLineId: NON_EXISTENT_UUID, quantity: '1.000' },
        ],
      });
      expect(response.status).toBe(404);
    });

    it('factura todavía DRAFT (no CONFIRMED): 409', async () => {
      const suffix = nextSuffix();
      const draft = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentNumber: suffix.slice(-8),
        issueDate: businessToday(),
        lines: [
          {
            productId: trackedProductId,
            acquisitionKind: 'GOOD',
            purchasePurpose: 'RESALE_INVENTORY',
            quantity: '5.000',
            unitCost: '10.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });
      const invoice = draft.body as SafePurchaseInvoiceBody;
      createdPurchaseInvoiceIds.push(invoice.id);

      const response = await createReceipt(invoice.id, {
        lines: [
          { purchaseInvoiceLineId: invoice.lines[0].id, quantity: '1.000' },
        ],
      });
      expect(response.status).toBe(409);
    });

    it('línea no elegible (servicio, isReceiptEligible=false): 400', async () => {
      const suffix = nextSuffix();
      const draft = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentNumber: suffix.slice(-8),
        issueDate: businessToday(),
        lines: [
          {
            productId: serviceProductId,
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '30.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });
      const invoice = draft.body as SafePurchaseInvoiceBody;
      createdPurchaseInvoiceIds.push(invoice.id);
      await confirmInvoice(invoice.id);

      const confirmedResponse = await request(app.getHttpServer())
        .get(`/api/v1/purchase-invoices/${invoice.id}`)
        .set('Cookie', adminCookie);
      const confirmedInvoice =
        confirmedResponse.body as SafePurchaseInvoiceBody;

      const response = await createReceipt(invoice.id, {
        lines: [
          {
            purchaseInvoiceLineId: confirmedInvoice.lines[0].id,
            quantity: '1.000',
          },
        ],
      });
      expect(response.status).toBe(400);
    });

    it('recepción parcial 4+6 de 10: ambas se aceptan, suman exactamente lo facturado', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('10.000');

      const first = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '4.000',
      );
      expect(first.lines[0].quantity).toBe('4.000');

      const second = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '6.000',
      );
      expect(second.lines[0].quantity).toBe('6.000');

      const summary = await listReceipts(invoiceId);
      const body = summary.body as PurchaseInvoiceReceiptsSummaryBody;
      const lineSummary = body.lines.find(
        (l) => l.purchaseInvoiceLineId === invoiceLineId,
      );
      expect(lineSummary?.receivedQuantity).toBe('10.000');
      expect(lineSummary?.pendingQuantity).toBe('0.000');
      expect(lineSummary?.status).toBe('COMPLETE');
    });

    it('sobre-recepción (4 ya recibidas + 7 nuevas > 10 facturadas): 409, la segunda nunca se crea', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('10.000');
      await createDefaultReceipt(invoiceId, invoiceLineId, '4.000');

      const response = await createReceipt(invoiceId, {
        lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity: '7.000' }],
      });
      expect(response.status).toBe(409);
    });

    it('registra un InventoryMovement ENTRY real y actualiza Product.stockCurrent', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('5.000');
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: trackedProductId },
      });

      await createDefaultReceipt(invoiceId, invoiceLineId, '5.000');

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: trackedProductId },
      });
      expect(after.stockCurrent.minus(before.stockCurrent).toFixed(3)).toBe(
        '5.000',
      );
      const movement = await prisma.inventoryMovement.findFirst({
        where: { productId: trackedProductId, origin: 'PURCHASE_RECEIPT' },
        orderBy: { createdAt: 'desc' },
      });
      expect(movement).not.toBeNull();
      expect(movement?.quantity.toFixed(3)).toBe('5.000');
    });

    it('idempotencyKey reenviada: devuelve la MISMA recepción, sin duplicar el movimiento de stock', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('5.000');
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: trackedProductId },
      });

      const idempotencyKey = `retry-${nextSuffix()}`;
      const first = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '5.000',
        { idempotencyKey },
      );
      const secondResponse = await createReceipt(invoiceId, {
        lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity: '5.000' }],
        idempotencyKey,
      });
      expect(secondResponse.status).toBe(201);
      expect((secondResponse.body as SafePurchaseReceiptBody).id).toBe(
        first.id,
      );

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: trackedProductId },
      });
      expect(after.stockCurrent.minus(before.stockCurrent).toFixed(3)).toBe(
        '5.000',
      );
    });

    it('concurrencia real: dos recepciones simultáneas que juntas exceden lo facturado — exactamente una 201, la otra 409', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('10.000');

      const body = {
        lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity: '6.000' }],
      };
      const [first, second] = await Promise.all([
        createReceipt(invoiceId, body),
        createReceipt(invoiceId, body),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const winner = first.status === 201 ? first : second;
      createdPurchaseReceiptIds.push(
        (winner.body as SafePurchaseReceiptBody).id,
      );

      const totalReceived = await prisma.purchaseReceiptLine.aggregate({
        where: {
          purchaseInvoiceLineId: invoiceLineId,
          purchaseReceipt: { status: 'ACTIVE' },
        },
        _sum: { quantity: true },
      });
      expect(totalReceived._sum.quantity?.toFixed(3)).toBe('6.000');
    });
  });

  // ====================================================================
  // cancel
  // ====================================================================
  describe('cancel', () => {
    it('no existe: 404', async () => {
      expect((await cancelReceipt(NON_EXISTENT_UUID, 'motivo')).status).toBe(
        404,
      );
    });

    it('reason en blanco: 400', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('3.000');
      const receipt = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '3.000',
      );
      const response = await cancelReceipt(receipt.id, '   ');
      expect(response.status).toBe(400);
    });

    it('camino feliz: EXIT compensatorio real, restituye Product.stockCurrent, marca CANCELLED', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('5.000');
      const before = await prisma.product.findUniqueOrThrow({
        where: { id: trackedProductId },
      });
      const receipt = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '5.000',
      );

      const response = await cancelReceipt(
        receipt.id,
        'Mercadería dañada, se revierte el ingreso',
      );
      expect(response.status).toBe(200);
      expect((response.body as SafePurchaseReceiptBody).status).toBe(
        'CANCELLED',
      );

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: trackedProductId },
      });
      expect(after.stockCurrent.toFixed(3)).toBe(
        before.stockCurrent.toFixed(3),
      );

      const exitMovement = await prisma.inventoryMovement.findFirst({
        where: {
          productId: trackedProductId,
          origin: 'PURCHASE_RECEIPT_CANCELLATION',
        },
      });
      expect(exitMovement).not.toBeNull();
    });

    it('doble anulación: 409 en el segundo intento', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('3.000');
      const receipt = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '3.000',
      );

      const first = await cancelReceipt(receipt.id, 'primer motivo');
      expect(first.status).toBe(200);
      const second = await cancelReceipt(receipt.id, 'segundo motivo');
      expect(second.status).toBe(409);
    });

    it('stock insuficiente para la reversa (ya consumido por otra salida): 409, nunca deja stock negativo', async () => {
      // Producto DEDICADO (nunca el compartido): esta prueba depende de un
      // stock exactamente en cero tras el ajuste, y el producto compartido
      // acumula stock de muchas otras pruebas de este archivo.
      const dedicatedProductId = await createDedicatedTrackedProduct();
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine(
          '5.000',
          '10.00',
          dedicatedProductId,
        );
      const receipt = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '5.000',
      );

      // Consume la mercadería recién recibida con una salida manual real.
      const adjustOut = await request(app.getHttpServer())
        .post('/api/v1/inventory/adjustments/out')
        .set('Cookie', adminCookie)
        .send({
          productId: dedicatedProductId,
          quantity: '5.000',
          reason: 'Consumo E2E A5.2b para forzar stock insuficiente',
        });
      expect(adjustOut.status).toBe(201);

      const response = await cancelReceipt(
        receipt.id,
        'Intento de anulación con stock ya consumido',
      );
      expect(response.status).toBe(409);

      const stillActive = await prisma.purchaseReceipt.findUniqueOrThrow({
        where: { id: receipt.id },
      });
      expect(stillActive.status).toBe('ACTIVE');
    });
  });

  // ====================================================================
  // Factura con recepción activa — guardia de cancelación de factura
  // ====================================================================
  describe('cancelación de factura con recepciones activas', () => {
    it('factura con recepción ACTIVE: 409 al intentar anularla; tras anular la recepción, sí se puede', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('4.000');
      const receipt = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '4.000',
      );

      const blocked = await cancelInvoice(
        invoiceId,
        'Intento con recepción activa',
      );
      expect(blocked.status).toBe(409);

      const cancelledReceipt = await cancelReceipt(
        receipt.id,
        'Liberando la factura para su anulación',
      );
      expect(cancelledReceipt.status).toBe(200);

      const allowed = await cancelInvoice(
        invoiceId,
        'Ahora sin recepciones activas',
      );
      expect(allowed.status).toBe(200);
    });
  });

  // ====================================================================
  // Reclasificación contable opcional (configuración SINTÉTICA, nunca real)
  // ====================================================================
  describe('reclasificación contable por recepción', () => {
    afterEach(async () => {
      if (finalInventoryAccountId !== null) {
        await prisma.account.update({
          where: { id: resaleInventoryAccountId },
          data: { receiptReclassificationTargetAccountId: null },
        });
        finalInventoryAccountId = null;
      }
    });

    it('sin ninguna cuenta configurada como tránsito: la recepción nunca genera AccountingEntry (caso predeterminado)', async () => {
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('4.000');
      const receipt = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '4.000',
      );

      expect(receipt.reclassificationEntryId).toBeNull();
      const entryCount = await prisma.accountingEntry.count({
        where: { sourceType: 'PURCHASE_RECEIPT', sourceId: receipt.id },
      });
      expect(entryCount).toBe(0);
    });

    it('cuenta configurada SINTÉTICAMENTE como tránsito: postea la reclasificación proporcional y la revierte exactamente al cancelar', async () => {
      finalInventoryAccountId = await createTestAccount(
        `A52BFIN${Date.now() % 1000000}`,
        'Inventario final sintético E2E A5.2b',
      );
      await prisma.account.update({
        where: { id: resaleInventoryAccountId },
        data: {
          receiptReclassificationTargetAccountId: finalInventoryAccountId,
        },
      });

      // unitCost=10.00, quantity=10 -> destinationAmount=100.00 (UNAFFECTED, sin IGV)
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('10.000', '10.00');
      const receipt = await createDefaultReceipt(
        invoiceId,
        invoiceLineId,
        '4.000',
      );

      expect(receipt.reclassificationEntryId).not.toBeNull();
      const entry = await prisma.accountingEntry.findUniqueOrThrow({
        where: { id: receipt.reclassificationEntryId as string },
        include: { lines: true },
      });
      expect(entry.sourceType).toBe(AccountingSourceType.PURCHASE_RECEIPT);
      const totalDebit = entry.lines.reduce(
        (sum, l) => sum.plus(l.debitAmount),
        new Prisma.Decimal(0),
      );
      const totalCredit = entry.lines.reduce(
        (sum, l) => sum.plus(l.creditAmount),
        new Prisma.Decimal(0),
      );
      expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));
      // 4/10 de 100.00 = 40.00
      expect(totalDebit.toFixed(2)).toBe('40.00');

      const cancelled = await cancelReceipt(
        receipt.id,
        'Revirtiendo reclasificación sintética E2E',
      );
      expect(cancelled.status).toBe(200);
      const reversal = await prisma.accountingEntry.findFirst({
        where: { reversesEntryId: entry.id },
      });
      expect(reversal).not.toBeNull();
    });

    it('tres recepciones parciales (2+2+3 de 7) con fracción de céntimo: la suma reclasificada coincide exactamente con el monto sujeto a reclasificación', async () => {
      const dedicatedProductId = await createDedicatedTrackedProduct();
      finalInventoryAccountId = await createTestAccount(
        `A52BFN3${Date.now() % 1000000}`,
        'Inventario final sintético 3 E2E A5.2b',
      );
      await prisma.account.update({
        where: { id: resaleInventoryAccountId },
        data: {
          receiptReclassificationTargetAccountId: finalInventoryAccountId,
        },
      });

      // quantity=7.000, unitCost=14.29 -> destinationAmount=100.03
      // (UNAFFECTED, sin IGV); 2/7 y 3/7 no son fracciones exactas de
      // céntimo, exactamente el caso que la corrección de redondeo cubre.
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine(
          '7.000',
          '14.29',
          dedicatedProductId,
        );

      const reclassifiedAmounts: string[] = [];
      for (const quantity of ['2.000', '2.000', '3.000']) {
        const receipt = await createDefaultReceipt(
          invoiceId,
          invoiceLineId,
          quantity,
        );
        const line = receipt.lines.find(
          (l) => l.purchaseInvoiceLineId === invoiceLineId,
        );
        expect(line?.reclassifiedAmount).not.toBeNull();
        reclassifiedAmounts.push(line?.reclassifiedAmount as string);
      }

      const total = reclassifiedAmounts.reduce(
        (sum, v) => sum.plus(v),
        new Prisma.Decimal(0),
      );
      expect(total.toFixed(2)).toBe('100.03');

      // La última recepción (la que completa la línea) ajusta el saldo
      // pendiente exacto, sin importar el redondeo de las dos anteriores.
      const summary = await listReceipts(invoiceId);
      const body = summary.body as PurchaseInvoiceReceiptsSummaryBody;
      const lineSummary = body.lines.find(
        (l) => l.purchaseInvoiceLineId === invoiceLineId,
      );
      expect(lineSummary?.status).toBe('COMPLETE');
    });

    it('mapeo contable cambiado desde la confirmación (cuenta origen ya no coincide con la realmente debitada): 409, bloquea TODA la recepción', async () => {
      const dedicatedProductId = await createDedicatedTrackedProduct();
      const otherAccountId = await createTestAccount(
        `A52BOTH${Date.now() % 1000000}`,
        'Cuenta sintética de reemplazo E2E A5.2b',
      );
      finalInventoryAccountId = await createTestAccount(
        `A52BFN2${Date.now() % 1000000}`,
        'Inventario final sintético 2 E2E A5.2b',
      );
      await prisma.account.update({
        where: { id: resaleInventoryAccountId },
        data: {
          receiptReclassificationTargetAccountId: finalInventoryAccountId,
        },
      });
      // La cuenta de REEMPLAZO también debe quedar marcada como tránsito:
      // de lo contrario el servicio nunca intenta reclasificar (ver el
      // caso predeterminado probado arriba) y el desajuste nunca se
      // detecta. El objetivo exacto es irrelevante para esta prueba.
      await prisma.account.update({
        where: { id: otherAccountId },
        data: {
          receiptReclassificationTargetAccountId: finalInventoryAccountId,
        },
      });

      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine(
          '5.000',
          '10.00',
          dedicatedProductId,
        );

      // Reasigna el systemKey DESPUÉS de confirmar: la cuenta que ahora
      // resuelve PURCHASE_RESALE_INVENTORY ya no es la que el asiento
      // ORIGINAL realmente debitó.
      const reassign = await request(app.getHttpServer())
        .patch(
          `/api/v1/chart-of-accounts/system-keys/${AccountingSystemKey.PURCHASE_RESALE_INVENTORY}`,
        )
        .set('Cookie', adminCookie)
        .send({ accountId: otherAccountId });
      expect(reassign.status).toBe(200);

      try {
        const response = await createReceipt(invoiceId, {
          lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity: '5.000' }],
        });
        // Defensivo: si el supuesto de la prueba fallara y la recepción se
        // creara de todos modos, su id queda rastreado para limpieza.
        if (response.status === 201) {
          createdPurchaseReceiptIds.push(
            (response.body as SafePurchaseReceiptBody).id,
          );
        }
        expect(response.status).toBe(409);

        const stockAfter = await prisma.product.findUniqueOrThrow({
          where: { id: dedicatedProductId },
        });
        const movements = await prisma.inventoryMovement.count({
          where: { productId: dedicatedProductId, origin: 'PURCHASE_RECEIPT' },
        });
        // Ninguna recepción debe haber quedado a medias: ni stock movido
        // ni movimiento creado para esta factura bloqueada.
        expect(movements).toBe(0);
        expect(stockAfter.stockCurrent.toFixed(3)).toBe('0.000');
      } finally {
        const restore = await request(app.getHttpServer())
          .patch(
            `/api/v1/chart-of-accounts/system-keys/${AccountingSystemKey.PURCHASE_RESALE_INVENTORY}`,
          )
          .set('Cookie', adminCookie)
          .send({ accountId: resaleInventoryAccountId });
        expect(restore.status).toBe(200);
      }
    });
  });

  // ====================================================================
  // R2-B2 — ubicación de destino por línea
  // ====================================================================
  describe('R2-B2: ubicación por línea', () => {
    interface LocationBody {
      id: string;
      code: string;
      name: string;
      warehouse: { id: string; code: string };
    }
    interface LocatedLineBody extends SafePurchaseReceiptLineBody {
      location: LocationBody | null;
    }
    interface LocatedReceiptBody extends SafePurchaseReceiptBody {
      lines: LocatedLineBody[];
    }

    let locA: string;
    let locB: string;
    let defaultLocationId: string;

    async function createWarehouseWithLocations(
      count: number,
    ): Promise<{ warehouseId: string; locationIds: string[] }> {
      const suffix = nextSuffix();
      const created = await request(app.getHttpServer())
        .post('/api/v1/warehouses')
        .set('Cookie', adminCookie)
        .send({ code: `B2W${suffix}`.slice(0, 20), name: 'Almacén e2e B2' });
      if (created.status !== 201) {
        throw new Error(`fixture almacén: ${JSON.stringify(created.body)}`);
      }
      const warehouseId = (created.body as { id: string }).id;
      createdWarehouseIds.push(warehouseId);
      const locationIds: string[] = [];
      for (let i = 0; i < count; i += 1) {
        const loc = await request(app.getHttpServer())
          .post(`/api/v1/warehouses/${warehouseId}/locations`)
          .set('Cookie', adminCookie)
          .send({ code: `B2L${i}${suffix}`.slice(0, 20), name: `Ubic ${i}` });
        if (loc.status !== 201) {
          throw new Error(`fixture ubicación: ${JSON.stringify(loc.body)}`);
        }
        locationIds.push((loc.body as { id: string }).id);
      }
      return { warehouseId, locationIds };
    }

    async function balances(productId: string): Promise<Map<string, string>> {
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      const rows = await prisma.stockBalance.findMany({ where: { productId } });
      const sum = rows.reduce(
        (acc, b) => acc.plus(b.quantity),
        new Prisma.Decimal(0),
      );
      // Conciliación: producto = suma de ubicaciones, sin negativos.
      expect(sum.toFixed(3)).toBe(product.stockCurrent.toFixed(3));
      for (const b of rows) expect(b.quantity.gte(0)).toBe(true);
      return new Map(rows.map((b) => [b.locationId, b.quantity.toFixed(3)]));
    }

    /** Factura CONFIRMED con una línea GOOD por producto indicado (cantidad 10 c/u por defecto). */
    async function createConfirmedInvoiceWithProducts(
      products: { productId: string; quantity: string }[],
    ): Promise<{ invoiceId: string; lineIdByProduct: Map<string, string> }> {
      const suffix = nextSuffix();
      const draft = await createInvoice({
        supplierId: activeSupplierId,
        documentType: PurchaseInvoiceDocumentType.FACTURA,
        documentSeries: 'F901',
        documentNumber: suffix.slice(-8),
        issueDate: businessToday(),
        lines: products.map((p) => ({
          productId: p.productId,
          acquisitionKind: 'GOOD',
          purchasePurpose: 'RESALE_INVENTORY',
          quantity: p.quantity,
          unitCost: '10.00',
          taxCategory: 'UNAFFECTED',
        })),
      });
      if (draft.status !== 201) {
        throw new Error(`factura fixture: ${JSON.stringify(draft.body)}`);
      }
      const invoice = draft.body as SafePurchaseInvoiceBody;
      createdPurchaseInvoiceIds.push(invoice.id);
      const confirmed = await confirmInvoice(invoice.id);
      if (confirmed.status !== 200) {
        throw new Error(`confirmar fixture: ${JSON.stringify(confirmed.body)}`);
      }
      const body = confirmed.body as SafePurchaseInvoiceBody;
      return {
        invoiceId: invoice.id,
        lineIdByProduct: new Map(
          body.lines.map((l) => [l.productId as string, l.id]),
        ),
      };
    }

    async function receive(
      invoiceId: string,
      lines: Record<string, unknown>[],
      extra: Record<string, unknown> = {},
      cookie: string = adminCookie,
    ): Promise<request.Response> {
      const response = await createReceipt(
        invoiceId,
        { lines, ...extra },
        cookie,
      );
      if (response.status === 201) {
        createdPurchaseReceiptIds.push((response.body as { id: string }).id);
      }
      return response;
    }

    beforeAll(async () => {
      defaultLocationId = (
        await prisma.warehouseLocation.findFirstOrThrow({
          where: { isDefault: true, warehouse: { isDefault: true } },
        })
      ).id;
      const wh = await createWarehouseWithLocations(2);
      [locA, locB] = wh.locationIds;
    }, 60000);

    it('1. sin locationId: ingresa a MAIN/DEFAULT y la respuesta lo informa', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const res = await receive(invoiceId, [
        {
          purchaseInvoiceLineId: lineIdByProduct.get(productId),
          quantity: '4.000',
        },
      ]);
      expect(res.status).toBe(201);
      const body = res.body as LocatedReceiptBody;
      expect(body.lines[0].location?.id).toBe(defaultLocationId);
      expect(body.lines[0].location?.code).toBe('DEFAULT');
      expect(body.lines[0].location?.warehouse.code).toBe('MAIN');
      expect((await balances(productId)).get(defaultLocationId)).toBe('4.000');
    });

    it('2. DEFAULT explícito equivale a omitirlo', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const res = await receive(invoiceId, [
        {
          purchaseInvoiceLineId: lineIdByProduct.get(productId),
          quantity: '3.000',
          locationId: defaultLocationId,
        },
      ]);
      expect(res.status).toBe(201);
      expect((await balances(productId)).get(defaultLocationId)).toBe('3.000');
    });

    it('3. ubicación distinta: stock, línea y movimiento quedan en ella', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const res = await receive(invoiceId, [
        {
          purchaseInvoiceLineId: lineIdByProduct.get(productId),
          quantity: '6.000',
          locationId: locA,
        },
      ]);
      expect(res.status).toBe(201);
      const body = res.body as LocatedReceiptBody;
      expect(body.lines[0].location?.id).toBe(locA);
      const map = await balances(productId);
      expect(map.get(locA)).toBe('6.000');
      expect(map.has(defaultLocationId)).toBe(false);
      const movement = await prisma.inventoryMovement.findFirstOrThrow({
        where: { productId, origin: 'PURCHASE_RECEIPT' },
      });
      expect(movement.locationId).toBe(locA);
      const persisted = await prisma.purchaseReceiptLine.findFirstOrThrow({
        where: { purchaseReceiptId: body.id },
      });
      expect(persisted.locationId).toBe(locA);
    });

    it('4. varias líneas en ubicaciones distintas, enviadas en orden inverso al productId', async () => {
      const p1 = await createDedicatedTrackedProduct();
      const p2 = await createDedicatedTrackedProduct();
      const [low, high] = [p1, p2].sort();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId: low, quantity: '10.000' },
          { productId: high, quantity: '10.000' },
        ]);
      // Orden de envío: primero el producto ALTO, luego el BAJO.
      const res = await receive(invoiceId, [
        {
          purchaseInvoiceLineId: lineIdByProduct.get(high),
          quantity: '2.000',
          locationId: locB,
        },
        {
          purchaseInvoiceLineId: lineIdByProduct.get(low),
          quantity: '5.000',
          locationId: locA,
        },
      ]);
      expect(res.status).toBe(201);
      const body = res.body as LocatedReceiptBody;
      const byInvoiceLine = new Map(
        body.lines.map((l) => [l.purchaseInvoiceLineId, l.location?.id]),
      );
      expect(byInvoiceLine.get(lineIdByProduct.get(high) as string)).toBe(locB);
      expect(byInvoiceLine.get(lineIdByProduct.get(low) as string)).toBe(locA);
      const mHigh = await balances(high);
      const mLow = await balances(low);
      expect(mHigh.get(locB)).toBe('2.000');
      expect(mHigh.has(locA)).toBe(false);
      expect(mLow.get(locA)).toBe('5.000');
      expect(mLow.has(locB)).toBe(false);
    });

    it('5. recepciones parciales en ubicaciones distintas y cantidad excedida', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '15.000' },
        ]);
      const lineId = lineIdByProduct.get(productId);
      expect(
        (
          await receive(invoiceId, [
            {
              purchaseInvoiceLineId: lineId,
              quantity: '10.000',
              locationId: locA,
            },
          ])
        ).status,
      ).toBe(201);
      expect(
        (
          await receive(invoiceId, [
            { purchaseInvoiceLineId: lineId, quantity: '5.000' },
          ])
        ).status,
      ).toBe(201);
      const map = await balances(productId);
      expect(map.get(locA)).toBe('10.000');
      expect(map.get(defaultLocationId)).toBe('5.000');
      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('15.000');

      const excess = await receive(invoiceId, [
        { purchaseInvoiceLineId: lineId, quantity: '1.000', locationId: locB },
      ]);
      expect(excess.status).toBe(409);
      expect((await balances(productId)).has(locB)).toBe(false);
    });

    it('6. una línea de factura repetida en la misma recepción sigue rechazándose (400)', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const lineId = lineIdByProduct.get(productId);
      const res = await receive(invoiceId, [
        { purchaseInvoiceLineId: lineId, quantity: '1.000', locationId: locA },
        { purchaseInvoiceLineId: lineId, quantity: '1.000', locationId: locB },
      ]);
      expect(res.status).toBe(400);
      expect((await balances(productId)).size).toBe(0);
    });

    describe('errores de ubicación (sin efectos)', () => {
      async function expectNoEffects(
        productId: string,
        invoiceId: string,
      ): Promise<void> {
        expect((await balances(productId)).size).toBe(0);
        expect(
          await prisma.purchaseReceipt.count({
            where: { purchaseInvoiceId: invoiceId },
          }),
        ).toBe(0);
        expect(
          await prisma.inventoryMovement.count({ where: { productId } }),
        ).toBe(0);
      }

      async function setup() {
        const productId = await createDedicatedTrackedProduct();
        const { invoiceId, lineIdByProduct } =
          await createConfirmedInvoiceWithProducts([
            { productId, quantity: '10.000' },
          ]);
        return {
          productId,
          invoiceId,
          lineId: lineIdByProduct.get(productId) as string,
        };
      }

      it('7. locationId malformado → 400', async () => {
        const { productId, invoiceId, lineId } = await setup();
        const res = await receive(invoiceId, [
          {
            purchaseInvoiceLineId: lineId,
            quantity: '1.000',
            locationId: 'no-es-uuid',
          },
        ]);
        expect(res.status).toBe(400);
        await expectNoEffects(productId, invoiceId);
      });

      it('8. ubicación inexistente → 404', async () => {
        const { productId, invoiceId, lineId } = await setup();
        const res = await receive(invoiceId, [
          {
            purchaseInvoiceLineId: lineId,
            quantity: '1.000',
            locationId: NON_EXISTENT_UUID,
          },
        ]);
        expect(res.status).toBe(404);
        await expectNoEffects(productId, invoiceId);
      });

      it('9. ubicación inactiva → 409', async () => {
        const { productId, invoiceId, lineId } = await setup();
        const wh = await createWarehouseWithLocations(1);
        await prisma.warehouseLocation.update({
          where: { id: wh.locationIds[0] },
          data: { status: WarehouseStatus.INACTIVE },
        });
        const res = await receive(invoiceId, [
          {
            purchaseInvoiceLineId: lineId,
            quantity: '1.000',
            locationId: wh.locationIds[0],
          },
        ]);
        expect(res.status).toBe(409);
        await expectNoEffects(productId, invoiceId);
      });

      it('10. almacén inactivo → 409', async () => {
        const { productId, invoiceId, lineId } = await setup();
        const wh = await createWarehouseWithLocations(1);
        await prisma.warehouse.update({
          where: { id: wh.warehouseId },
          data: { status: WarehouseStatus.INACTIVE },
        });
        const res = await receive(invoiceId, [
          {
            purchaseInvoiceLineId: lineId,
            quantity: '1.000',
            locationId: wh.locationIds[0],
          },
        ]);
        expect(res.status).toBe(409);
        await expectNoEffects(productId, invoiceId);
      });

      it('11. una línea inválida entre varias no deja ninguna recepción parcial', async () => {
        const { productId, invoiceId, lineId } = await setup();
        const other = await createDedicatedTrackedProduct();
        const second = await createConfirmedInvoiceWithProducts([
          { productId: other, quantity: '10.000' },
        ]);
        expect(second.invoiceId).toBeDefined();
        const res = await receive(invoiceId, [
          {
            purchaseInvoiceLineId: lineId,
            quantity: '1.000',
            locationId: locA,
          },
          {
            purchaseInvoiceLineId: second.lineIdByProduct.get(other),
            quantity: '1.000',
          },
        ]);
        expect(res.status).toBe(400);
        await expectNoEffects(productId, invoiceId);
      });
    });

    it('12. idempotencia: el reintento con otra ubicación devuelve la recepción original sin mover stock', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const lineId = lineIdByProduct.get(productId);
      const key = `b2-idem-${nextSuffix()}`;
      const first = await receive(
        invoiceId,
        [
          {
            purchaseInvoiceLineId: lineId,
            quantity: '4.000',
            locationId: locA,
          },
        ],
        { idempotencyKey: key },
      );
      expect(first.status).toBe(201);
      const retry = await receive(
        invoiceId,
        [
          {
            purchaseInvoiceLineId: lineId,
            quantity: '4.000',
            locationId: locB,
          },
        ],
        { idempotencyKey: key },
      );
      expect(retry.status).toBe(201);
      const retryBody = retry.body as LocatedReceiptBody;
      expect(retryBody.id).toBe((first.body as LocatedReceiptBody).id);
      expect(retryBody.lines[0].location?.id).toBe(locA);
      const map = await balances(productId);
      expect(map.get(locA)).toBe('4.000');
      expect(map.has(locB)).toBe(false);
      expect(
        await prisma.inventoryMovement.count({
          where: { productId, origin: 'PURCHASE_RECEIPT' },
        }),
      ).toBe(1);
    });

    it('13. consultas (detalle y listado) y anulación exponen la ubicación original', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const created = await receive(invoiceId, [
        {
          purchaseInvoiceLineId: lineIdByProduct.get(productId),
          quantity: '5.000',
          locationId: locA,
        },
      ]);
      const receiptId = (created.body as LocatedReceiptBody).id;

      const detail = await getReceipt(receiptId);
      expect((detail.body as LocatedReceiptBody).lines[0].location?.id).toBe(
        locA,
      );
      const list = await listReceipts(invoiceId);
      const summary = list.body as { receipts: LocatedReceiptBody[] };
      expect(summary.receipts[0].lines[0].location?.id).toBe(locA);

      const cancelled = await cancelReceipt(receiptId, 'Anulación e2e B2');
      expect(cancelled.status).toBe(200);
      const cancelledBody = cancelled.body as LocatedReceiptBody;
      expect(cancelledBody.status).toBe('CANCELLED');
      expect(cancelledBody.lines[0].location?.id).toBe(locA);
      const map = await balances(productId);
      expect(map.get(locA) ?? '0.000').toBe('0.000');
      expect(map.has(defaultLocationId)).toBe(false);
      const exit = await prisma.inventoryMovement.findFirstOrThrow({
        where: { productId, origin: 'PURCHASE_RECEIPT_CANCELLATION' },
      });
      expect(exit.locationId).toBe(locA);
    });

    it('14. anular con saldo insuficiente en la ubicación original → 409, sin tomar de otra ubicación ni dejar efectos parciales', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '20.000' },
        ]);
      const lineId = lineIdByProduct.get(productId);
      const receiptA = await receive(invoiceId, [
        { purchaseInvoiceLineId: lineId, quantity: '10.000', locationId: locA },
      ]);
      // Stock abundante en otra ubicación: NO debe usarse como sustituto.
      expect(
        (
          await receive(invoiceId, [
            {
              purchaseInvoiceLineId: lineId,
              quantity: '10.000',
              locationId: locB,
            },
          ])
        ).status,
      ).toBe(201);
      const exit = await request(app.getHttpServer())
        .post('/api/v1/inventory/exits')
        .set('Cookie', adminCookie)
        .send({
          productId,
          quantity: '8.000',
          reason: 'Consumo e2e B2',
          locationId: locA,
        });
      expect(exit.status).toBe(201);
      const before = await balances(productId);

      const cancel = await cancelReceipt(
        (receiptA.body as LocatedReceiptBody).id,
        'Anulación insuficiente',
      );
      expect(cancel.status).toBe(409);
      const after = await balances(productId);
      expect(after.get(locA)).toBe(before.get(locA));
      expect(after.get(locB)).toBe(before.get(locB));
      const stillActive = await prisma.purchaseReceipt.findUniqueOrThrow({
        where: { id: (receiptA.body as LocatedReceiptBody).id },
      });
      expect(stillActive.status).toBe('ACTIVE');
    });

    it('15. roles: WAREHOUSE crea con ubicación y no ve importes; no anula; MANAGEMENT/ACCOUNTANT/SELLER no crean', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const lineId = lineIdByProduct.get(productId);
      const body = [
        { purchaseInvoiceLineId: lineId, quantity: '2.000', locationId: locA },
      ];
      for (const cookie of [managementCookie, accountantCookie, sellerCookie]) {
        expect((await receive(invoiceId, body, {}, cookie)).status).toBe(403);
      }
      const created = await receive(invoiceId, body, {}, warehouseCookie);
      expect(created.status).toBe(201);
      const receipt = created.body as LocatedReceiptBody;
      expect(receipt.lines[0].location?.id).toBe(locA);
      expect('reclassifiedAmount' in receipt.lines[0]).toBe(false);
      expect('reclassificationEntryId' in receipt).toBe(false);
      expect(
        (await cancelReceipt(receipt.id, 'motivo', warehouseCookie)).status,
      ).toBe(403);
      const read = await getReceipt(receipt.id, warehouseCookie);
      expect((read.body as LocatedReceiptBody).lines[0].location?.id).toBe(
        locA,
      );
      expect(
        'reclassifiedAmount' in (read.body as LocatedReceiptBody).lines[0],
      ).toBe(false);
    });

    it('16. concurrencia: dos recepciones con productos compartidos y ubicaciones cruzadas, en orden opuesto', async () => {
      const p1 = await createDedicatedTrackedProduct();
      const p2 = await createDedicatedTrackedProduct();
      const inv1 = await createConfirmedInvoiceWithProducts([
        { productId: p1, quantity: '10.000' },
        { productId: p2, quantity: '10.000' },
      ]);
      const inv2 = await createConfirmedInvoiceWithProducts([
        { productId: p1, quantity: '10.000' },
        { productId: p2, quantity: '10.000' },
      ]);
      const [r1, r2] = await Promise.all([
        receive(inv1.invoiceId, [
          {
            purchaseInvoiceLineId: inv1.lineIdByProduct.get(p1),
            quantity: '3.000',
            locationId: locA,
          },
          {
            purchaseInvoiceLineId: inv1.lineIdByProduct.get(p2),
            quantity: '4.000',
            locationId: locB,
          },
        ]),
        receive(inv2.invoiceId, [
          {
            purchaseInvoiceLineId: inv2.lineIdByProduct.get(p2),
            quantity: '5.000',
            locationId: locA,
          },
          {
            purchaseInvoiceLineId: inv2.lineIdByProduct.get(p1),
            quantity: '6.000',
            locationId: locB,
          },
        ]),
      ]);
      expect(r1.status).toBe(201);
      expect(r2.status).toBe(201);
      const m1 = await balances(p1);
      const m2 = await balances(p2);
      expect(m1.get(locA)).toBe('3.000');
      expect(m1.get(locB)).toBe('6.000');
      expect(m2.get(locB)).toBe('4.000');
      expect(m2.get(locA)).toBe('5.000');
    });

    it('17. el stock por ubicación (R2-B1b) refleja la recepción y los costos/factura no cambian', async () => {
      const productId = await createDedicatedTrackedProduct();
      const { invoiceId, lineIdByProduct } =
        await createConfirmedInvoiceWithProducts([
          { productId, quantity: '10.000' },
        ]);
      const invoiceBefore = await prisma.purchaseInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      const productBefore = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      await receive(invoiceId, [
        {
          purchaseInvoiceLineId: lineIdByProduct.get(productId),
          quantity: '7.000',
          locationId: locB,
        },
      ]);
      const res = await request(app.getHttpServer())
        .get(`/api/v1/inventory/products/${productId}/stock-by-location`)
        .set('Cookie', adminCookie);
      expect(res.status).toBe(200);
      const body = res.body as {
        stockCurrent: string;
        locations: { location: { id: string }; quantity: string }[];
      };
      expect(body.stockCurrent).toBe('7.000');
      expect(body.locations).toHaveLength(1);
      expect(body.locations[0].location.id).toBe(locB);
      const invoiceAfter = await prisma.purchaseInvoice.findUniqueOrThrow({
        where: { id: invoiceId },
      });
      expect(invoiceAfter.totalAmount.toFixed(2)).toBe(
        invoiceBefore.totalAmount.toFixed(2),
      );
      expect(invoiceAfter.status).toBe(invoiceBefore.status);
      const productAfter = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(productAfter.salePrice.toFixed(2)).toBe(
        productBefore.salePrice.toFixed(2),
      );
    });
  });

  // ====================================================================
  // Regresión
  // ====================================================================
  describe('regresión', () => {
    it('GET /api/v1/purchase-invoices y GET /api/v1/inventory/low-stock siguen respondiendo normalmente', async () => {
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/purchase-invoices')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/inventory/low-stock')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
    });
  });
});
