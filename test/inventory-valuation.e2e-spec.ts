import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  InventoryValuationMethod,
  Prisma,
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
 * Fase A6.1 — Inventario valorizado. Suite dedicada y aislada (mismo
 * criterio que purchase-receipts.e2e-spec.ts): limpia exclusivamente por
 * los ids que ella misma crea. `Product.valuationMethod` se activa
 * siempre vía escritura DIRECTA de Prisma (configuración sintética,
 * nunca por un endpoint HTTP — A6.1 no expone ninguno a propósito, ver
 * CLAUDE.md §11).
 */

interface SafePurchaseInvoiceBody {
  id: string;
  status: string;
  lines: { id: string; productId: string | null }[];
}

interface SafePurchaseReceiptBody {
  id: string;
  status: 'ACTIVE' | 'CANCELLED';
}

const MANAGEMENT_USERNAME = 'e2e_a61_management';
const ACCOUNTANT_USERNAME = 'e2e_a61_accountant';
const SELLER_USERNAME = 'e2e_a61_seller';
const WAREHOUSE_USERNAME = 'e2e_a61_warehouse';
const FIXTURE_PASSWORD = 'E2eA61Fixture2026Aa';

describe('Inventory Valuation — Fase A6.1 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;
  let activeSupplierId: string;

  const createdAccountIds: string[] = [];
  const createdPurchaseInvoiceIds: string[] = [];
  const createdPurchaseReceiptIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdProductIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  function createInvoice(
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/purchase-invoices')
      .set('Cookie', adminCookie)
      .send(body);
  }

  function confirmInvoice(id: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set('Cookie', adminCookie)
      .send({});
  }

  function createReceipt(
    invoiceId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${invoiceId}/receipts`)
      .set('Cookie', adminCookie)
      .send(body);
  }

  function cancelReceipt(
    id: string,
    reason: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-receipts/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason });
  }

  function getValuation(
    query: Record<string, string> = {},
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/inventory/valuation')
      .query(query)
      .set('Cookie', cookie);
  }

  function getPendingValuation(
    query: Record<string, string> = {},
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/inventory/valuation/pending')
      .query(query)
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

  async function createSupplier(): Promise<string> {
    const suffix = nextSuffix();
    const response = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send({
        documentType: SupplierDocumentType.RUC,
        documentNumber: suffix.slice(-11).padStart(11, '0'),
        legalName: `Proveedor E2E A6.1 ${suffix}`,
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

  async function createTrackedProduct(
    valuationMethod: InventoryValuationMethod | null = null,
  ): Promise<string> {
    const suffix = nextSuffix();
    const product = await prisma.product.create({
      data: {
        sku: `A61-${suffix}`,
        name: `Producto E2E A6.1 ${suffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '50.00',
        isInventoryTracked: true,
        stockCurrent: '0.000',
        status: ProductStatus.ACTIVE,
        valuationMethod,
      },
    });
    createdProductIds.push(product.id);
    return product.id;
  }

  async function createConfirmedInvoiceWithGoodLine(
    quantity: string,
    unitCost: string,
    productId: string,
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

  async function createReceiptForLine(
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
      email: 'e2e_a61_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_a61_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a61_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a61_warehouse@demosystem.test',
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
        code: `A61CAT${shortSuffix}`,
        name: `Categoría E2E A6.1 ${shortSuffix}`,
      },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `A61UN${shortSuffix}`,
        name: `Unidad E2E A6.1 ${shortSuffix}`,
        abbreviation: 'u61',
        allowDecimal: true,
      },
    });
    unitId = unit.id;

    activeSupplierId = await createSupplier();

    const apAccountId = await createTestAccount(
      `A61AP${shortSuffix}`,
      'Cuentas por pagar sintética E2E A6.1',
      AccountType.LIABILITY,
    );
    await activateSystemKey(AccountingSystemKey.ACCOUNTS_PAYABLE, apAccountId);
    const resaleAccountId = await createTestAccount(
      `A61RES${shortSuffix}`,
      'Compras para reventa sintética E2E A6.1',
      AccountType.ASSET,
    );
    await activateSystemKey(
      AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
      resaleAccountId,
    );
  }, 60000);

  afterAll(async () => {
    try {
      const valuationsByProduct = await prisma.inventoryValuation.findMany({
        where: { productId: { in: createdProductIds } },
        select: { id: true },
      });
      await prisma.inventoryValuation.deleteMany({
        where: { id: { in: valuationsByProduct.map((v) => v.id) } },
      });

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

      if (postedEntryIds.length > 0) {
        const reversals = await prisma.accountingEntry.findMany({
          where: { reversesEntryId: { in: postedEntryIds } },
          select: { id: true },
        });
        const allEntryIds = [...postedEntryIds, ...reversals.map((r) => r.id)];
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
      await prisma.$disconnect();
    }
  }, 60000);

  // ====================================================================
  // RBAC
  // ====================================================================
  describe('RBAC', () => {
    it('SELLER/WAREHOUSE: 403 (expone costo, nunca accesible aunque WAREHOUSE tenga acceso general a inventario)', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        expect((await getValuation({}, cookie)).status).toBe(403);
        expect((await getPendingValuation({}, cookie)).status).toBe(403);
      }
    });

    it('ADMIN/MANAGEMENT/ACCOUNTANT: 200', async () => {
      for (const cookie of [adminCookie, managementCookie, accountantCookie]) {
        expect((await getValuation({}, cookie)).status).toBe(200);
        expect((await getPendingValuation({}, cookie)).status).toBe(200);
      }
    });
  });

  // ====================================================================
  // Producto SIN valorización habilitada: cero cambio de comportamiento
  // ====================================================================
  describe('producto sin valuationMethod', () => {
    it('recibir no genera ningún InventoryValuation; el producto no aparece en el listado valorizado', async () => {
      const productId = await createTrackedProduct(null);
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('10.000', '10.00', productId);
      await createReceiptForLine(invoiceId, invoiceLineId, '10.000');

      const valuationCount = await prisma.inventoryValuation.count({
        where: { productId },
      });
      expect(valuationCount).toBe(0);

      const response = await getValuation({ productId });
      const body = response.body as { data: unknown[] };
      expect(body.data).toHaveLength(0);
    });
  });

  // ====================================================================
  // Producto CON valorización habilitada (sintética, solo pos_db_test)
  // ====================================================================
  describe('producto con valuationMethod MOVING_WEIGHTED_AVERAGE', () => {
    it('recepción completa: un evento ORIGINAL con el costo exacto; reflejado en el listado', async () => {
      const productId = await createTrackedProduct(
        InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      );
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('10.000', '10.00', productId);
      await createReceiptForLine(invoiceId, invoiceLineId, '10.000');

      const valuations = await prisma.inventoryValuation.findMany({
        where: { productId },
      });
      expect(valuations).toHaveLength(1);
      expect(valuations[0].totalCost.toFixed(2)).toBe('100.00');

      const response = await getValuation({ productId });
      const body = response.body as {
        data: {
          valuedQuantity: string;
          totalValue: string;
          weightedAverageUnitCost: string;
        }[];
      };
      expect(body.data[0].valuedQuantity).toBe('10.000');
      expect(body.data[0].totalValue).toBe('100.00');
      expect(body.data[0].weightedAverageUnitCost).toBe('10.000000');
    });

    it('promedio ponderado real: dos facturas a costos distintos combinan correctamente (nunca un promedio simple)', async () => {
      const productId = await createTrackedProduct(
        InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      );
      const first = await createConfirmedInvoiceWithGoodLine(
        '10.000',
        '10.00',
        productId,
      );
      await createReceiptForLine(
        first.invoiceId,
        first.invoiceLineId,
        '10.000',
      );
      const second = await createConfirmedInvoiceWithGoodLine(
        '5.000',
        '40.00',
        productId,
      );
      await createReceiptForLine(
        second.invoiceId,
        second.invoiceLineId,
        '5.000',
      );

      // (10×10.00 + 5×40.00) / 15 = 300/15 = 20.00
      const response = await getValuation({ productId });
      const body = response.body as {
        data: {
          valuedQuantity: string;
          totalValue: string;
          weightedAverageUnitCost: string;
        }[];
      };
      expect(body.data[0].valuedQuantity).toBe('15.000');
      expect(body.data[0].totalValue).toBe('300.00');
      expect(body.data[0].weightedAverageUnitCost).toBe('20.000000');
    });

    it('tres recepciones parciales (1+1+1 de 3): la suma capitalizada coincide exactamente con el monto elegible, sin drift', async () => {
      const productId = await createTrackedProduct(
        InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      );
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('3.000', '10.00', productId);
      await createReceiptForLine(invoiceId, invoiceLineId, '1.000');
      await createReceiptForLine(invoiceId, invoiceLineId, '1.000');
      await createReceiptForLine(invoiceId, invoiceLineId, '1.000');

      const valuations = await prisma.inventoryValuation.findMany({
        where: { productId },
        orderBy: { createdAt: 'asc' },
      });
      expect(valuations).toHaveLength(3);
      const sum = valuations.reduce(
        (acc, v) => acc.plus(v.totalCost),
        new Prisma.Decimal(0),
      );
      const invoiceLine = await prisma.purchaseInvoiceLine.findUniqueOrThrow({
        where: { id: invoiceLineId },
        select: { taxableBaseAmount: true },
      });
      expect(sum.toFixed(2)).toBe(invoiceLine.taxableBaseAmount.toFixed(2));
    });

    it('idempotencyKey repetida: nunca duplica el evento de valorización', async () => {
      const productId = await createTrackedProduct(
        InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      );
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('4.000', '10.00', productId);
      const key = `retry-${nextSuffix()}`;
      const first = await createReceiptForLine(
        invoiceId,
        invoiceLineId,
        '4.000',
        {
          idempotencyKey: key,
        },
      );
      const retryResponse = await createReceipt(invoiceId, {
        lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity: '4.000' }],
        idempotencyKey: key,
      });
      expect(retryResponse.status).toBe(201);
      expect((retryResponse.body as SafePurchaseReceiptBody).id).toBe(first.id);

      const valuationCount = await prisma.inventoryValuation.count({
        where: { productId },
      });
      expect(valuationCount).toBe(1);
    });

    it('cancelación: crea un REVERSAL que libera exactamente lo capitalizado por esa recepción', async () => {
      const productId = await createTrackedProduct(
        InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      );
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('6.000', '15.00', productId);
      const receipt = await createReceiptForLine(
        invoiceId,
        invoiceLineId,
        '6.000',
      );

      let response = await getValuation({ productId });
      let body = response.body as {
        data: { totalValue: string; valuedQuantity: string }[];
      };
      expect(body.data[0].totalValue).toBe('90.00');

      const cancelResponse = await cancelReceipt(
        receipt.id,
        'Mercadería dañada',
      );
      expect(cancelResponse.status).toBe(200);

      const valuations = await prisma.inventoryValuation.findMany({
        where: { productId },
      });
      expect(valuations).toHaveLength(2);
      expect(valuations.map((v) => v.eventType).sort()).toEqual([
        'ORIGINAL',
        'REVERSAL',
      ]);

      response = await getValuation({ productId });
      body = response.body as {
        data: { totalValue: string; valuedQuantity: string }[];
      };
      // El producto sigue apareciendo (valuationMethod sigue configurado),
      // pero con cantidad/valor en cero — la reversión anuló exactamente
      // lo que esta recepción había capitalizado.
      expect(body.data[0].valuedQuantity).toBe('0.000');
      expect(body.data[0].totalValue).toBe('0.00');
    });

    it('doble cancelación concurrente de la misma recepción: exactamente una reversión, nunca dos', async () => {
      const productId = await createTrackedProduct(
        InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      );
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('2.000', '25.00', productId);
      const receipt = await createReceiptForLine(
        invoiceId,
        invoiceLineId,
        '2.000',
      );

      const [first, second] = await Promise.all([
        cancelReceipt(receipt.id, 'intento 1'),
        cancelReceipt(receipt.id, 'intento 2'),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const reversalCount = await prisma.inventoryValuation.count({
        where: { productId, eventType: 'REVERSAL' },
      });
      expect(reversalCount).toBe(1);
    });
  });

  // ====================================================================
  // Pendientes de valorización
  // ====================================================================
  describe('pendientes de valorización', () => {
    it('producto con valorización habilitada DESPUÉS de recibir: el movimiento histórico aparece como pendiente', async () => {
      const productId = await createTrackedProduct(null);
      const { invoiceId, invoiceLineId } =
        await createConfirmedInvoiceWithGoodLine('3.000', '12.00', productId);
      await createReceiptForLine(invoiceId, invoiceLineId, '3.000');

      // Activación sintética DESPUÉS del hecho (nunca vía HTTP — A6.1 no
      // expone ese endpoint a propósito).
      await prisma.product.update({
        where: { id: productId },
        data: {
          valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
        },
      });

      const response = await getPendingValuation({ productId });
      const body = response.body as { data: { productId: string }[] };
      expect(body.data.some((r) => r.productId === productId)).toBe(true);

      // Limpieza del cambio sintético para no afectar otras aserciones si el archivo se re-ejecuta.
      await prisma.product.update({
        where: { id: productId },
        data: { valuationMethod: null },
      });
    });
  });
});
