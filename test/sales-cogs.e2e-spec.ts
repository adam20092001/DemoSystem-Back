import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSourceType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  InventoryValuationMethod,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
  PurchasePurpose,
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
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Fase A6.2 — Costo de ventas (COGS). Suite dedicada y aislada (mismo
 * criterio que inventory-valuation.e2e-spec.ts): limpia exclusivamente por
 * los ids que ella misma crea. Reutiliza el mismo patrón de fixtures
 * sintéticas (cuentas/proveedor/cliente/producto) — nunca activa una
 * política de valorización/mapeo contable real fuera de esta suite.
 */

interface SafePurchaseInvoiceBody {
  id: string;
  status: string;
  lines: { id: string; productId: string | null }[];
}

interface SafeSaleBody {
  id: string;
  number: string;
  status: string;
}

describe('Ventas — Costo de ventas (COGS, Fase A6.2) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;

  let categoryId: string;
  let unitId: string;
  let activeSupplierId: string;
  let customerId: string;
  let resaleAccountId: string;

  const createdAccountIds: string[] = [];
  const createdPurchaseInvoiceIds: string[] = [];
  const createdPurchaseReceiptIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdProductIds: string[] = [];
  const createdSaleIds: string[] = [];

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
    accountId: string | null,
  ): Promise<void> {
    const response = await request(app.getHttpServer())
      .patch(`/api/v1/chart-of-accounts/system-keys/${systemKey}`)
      .set('Cookie', adminCookie)
      .send({ accountId });
    if (response.status !== 200) {
      throw new Error(
        `No se pudo configurar el mapeo sintético ${systemKey}: ${JSON.stringify(response.body)}`,
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
        legalName: `Proveedor E2E A6.2 ${suffix}`,
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

  async function createValuedProduct(
    valuationMethod: InventoryValuationMethod | null = InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
  ): Promise<string> {
    const suffix = nextSuffix();
    const product = await prisma.product.create({
      data: {
        sku: `A62-${suffix}`,
        name: `Producto E2E A6.2 ${suffix}`,
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

  /** Factura CONFIRMED con una línea del `purpose` indicado; retorna invoiceId/invoiceLineId. */
  async function createConfirmedInvoiceWithGoodLine(
    quantity: string,
    unitCost: string,
    productId: string,
    purpose: PurchasePurpose = PurchasePurpose.RESALE_INVENTORY,
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
          purchasePurpose: purpose,
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

  async function receiveFullLine(
    invoiceId: string,
    invoiceLineId: string,
    quantity: string,
  ): Promise<void> {
    const response = await createReceipt(invoiceId, {
      lines: [{ purchaseInvoiceLineId: invoiceLineId, quantity }],
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la recepción fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as { id: string };
    createdPurchaseReceiptIds.push(body.id);
  }

  /** Seed completo: factura CONFIRMED + recepción total -> capa de valorización activa (totalCost = quantity*unitCost, sin impuesto). */
  async function seedValuedPurchase(
    productId: string,
    quantity: string,
    unitCost: string,
    purpose: PurchasePurpose = PurchasePurpose.RESALE_INVENTORY,
  ): Promise<void> {
    const { invoiceId, invoiceLineId } = await createConfirmedInvoiceWithGoodLine(
      quantity,
      unitCost,
      productId,
      purpose,
    );
    await receiveFullLine(invoiceId, invoiceLineId, quantity);
  }

  function createDirectSale(
    productId: string,
    quantity: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send({ customerId, items: [{ productId, quantity }] });
  }

  function cancelSale(id: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Anulación de prueba E2E A6.2' });
  }

  async function findCogsEntry(saleId: string) {
    return prisma.accountingEntry.findFirst({
      where: {
        sourceType: AccountingSourceType.COGS,
        sourceId: saleId,
        eventType: 'ORIGINAL',
      },
      include: { lines: true },
    });
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

    const shortSuffix = Date.now() % 1000000;
    const category = await prisma.category.create({
      data: {
        code: `A62CAT${shortSuffix}`,
        name: `Categoría E2E A6.2 ${shortSuffix}`,
      },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `A62UN${shortSuffix}`,
        name: `Unidad E2E A6.2 ${shortSuffix}`,
        abbreviation: 'u62',
        allowDecimal: true,
      },
    });
    unitId = unit.id;

    const customer = await prisma.customer.create({
      data: {
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        name: `Cliente E2E A6.2 ${shortSuffix}`,
        creditEnabled: true,
      } as Prisma.CustomerUncheckedCreateInput,
    });
    customerId = customer.id;

    // Secuencia NV propia del spec (mismo criterio defensivo que
    // sales.e2e-spec.ts): upsert, nunca eliminada en afterAll (compartida
    // globalmente, otras suites también la necesitan).
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

    activeSupplierId = await createSupplier();

    const apAccountId = await createTestAccount(
      `A62AP${shortSuffix}`,
      'Cuentas por pagar sintética E2E A6.2',
      AccountType.LIABILITY,
    );
    await activateSystemKey(AccountingSystemKey.ACCOUNTS_PAYABLE, apAccountId);

    // PURCHASE_RESALE_INVENTORY debe estar mapeado para poder confirmar
    // CUALQUIER factura con línea RESALE_INVENTORY (requisito general de
    // A5.2a, independiente de A6.2) — se activa aquí, en el beforeAll
    // EXTERNO, para que el describe "sin mapear todavía" (que deja
    // COST_OF_GOODS_SOLD sin configurar a propósito) pueda igual sembrar
    // su compra fixture.
    resaleAccountId = await createTestAccount(
      `A62RES${shortSuffix}`,
      'Compras para reventa sintética E2E A6.2',
      AccountType.ASSET,
    );
    await activateSystemKey(
      AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
      resaleAccountId,
    );
  }, 60000);

  afterAll(async () => {
    try {
      await prisma.inventoryValuation.deleteMany({
        where: { productId: { in: createdProductIds } },
      });

      const sales = await prisma.sale.findMany({
        where: { id: { in: createdSaleIds } },
        select: { id: true },
      });
      const saleIds = sales.map((s) => s.id);
      await prisma.payment.deleteMany({ where: { saleId: { in: saleIds } } });
      await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });

      const cogsEntries = await prisma.accountingEntry.findMany({
        where: { sourceType: AccountingSourceType.COGS, sourceId: { in: saleIds } },
        select: { id: true },
      });
      const saleEntries = await prisma.accountingEntry.findMany({
        where: {
          sourceType: { in: [AccountingSourceType.SALE, AccountingSourceType.PAYMENT] },
          sourceId: { in: saleIds },
        },
        select: { id: true },
      });
      const baseEntryIds = [
        ...cogsEntries.map((e) => e.id),
        ...saleEntries.map((e) => e.id),
      ];
      const reversals = await prisma.accountingEntry.findMany({
        where: { reversesEntryId: { in: baseEntryIds } },
        select: { id: true },
      });
      const allEntryIds = [...baseEntryIds, ...reversals.map((r) => r.id)];
      await prisma.accountingEntryLine.deleteMany({
        where: { entryId: { in: allEntryIds } },
      });
      await prisma.accountingEntry.deleteMany({
        where: { id: { in: allEntryIds } },
      });

      await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });

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
        const purchaseReversals = await prisma.accountingEntry.findMany({
          where: { reversesEntryId: { in: postedEntryIds } },
          select: { id: true },
        });
        const purchaseEntryIds = [
          ...postedEntryIds,
          ...purchaseReversals.map((r) => r.id),
        ];
        await prisma.accountingEntryLine.deleteMany({
          where: { entryId: { in: purchaseEntryIds } },
        });
        await prisma.accountingEntry.deleteMany({
          where: { id: { in: purchaseEntryIds } },
        });
      }

      await prisma.inventoryMovement.deleteMany({
        where: { productId: { in: createdProductIds } },
      });
      await prisma.supplier.deleteMany({
        where: { id: { in: createdSupplierIds } },
      });
      await prisma.customer.deleteMany({ where: { id: customerId } });
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
      await prisma.category.deleteMany({ where: { id: categoryId } });
      await prisma.unit.deleteMany({ where: { id: unitId } });
      await prisma.account.deleteMany({
        where: { id: { in: createdAccountIds } },
      });
    } finally {
      await app.close();
    }
  }, 60000);

  describe('COST_OF_GOODS_SOLD sin mapear todavía', () => {
    it('venta de un producto valorizado: 409, sin ningún efecto persistente (nunca crea la venta ni mueve stock)', async () => {
      const productId = await createValuedProduct();
      await seedValuedPurchase(productId, '10.000', '10.00');

      const before = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });

      const response = await createDirectSale(productId, '3.000');

      expect(response.status).toBe(409);
      expect(JSON.stringify(response.body)).toContain('COST_OF_GOODS_SOLD');

      const after = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(after.stockCurrent.toFixed(3)).toBe(before.stockCurrent.toFixed(3));
      const sales = await prisma.sale.findMany({ where: { customerId } });
      expect(sales).toHaveLength(0);
    });
  });

  describe('con COST_OF_GOODS_SOLD y PURCHASE_RESALE_INVENTORY mapeados', () => {
    beforeAll(async () => {
      const shortSuffix = Date.now() % 1000000;
      const cogsAccountId = await createTestAccount(
        `A62COGS${shortSuffix}`,
        'Costo de ventas sintético E2E A6.2',
        AccountType.COST,
      );
      await activateSystemKey(
        AccountingSystemKey.COST_OF_GOODS_SOLD,
        cogsAccountId,
      );
    });

    it('venta de 3 unidades (promedio ponderado 10.00): postea COGS debitando COST_OF_GOODS_SOLD y acreditando la cuenta de inventario histórica, exactamente 30.00', async () => {
      const productId = await createValuedProduct();
      await seedValuedPurchase(productId, '10.000', '10.00');

      const response = await createDirectSale(productId, '3.000');
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      const valuation = await prisma.inventoryValuation.findFirst({
        where: { productId, sourceType: 'SALE', eventType: 'ORIGINAL' },
      });
      expect(valuation).not.toBeNull();
      expect(valuation?.totalCost.toFixed(2)).toBe('30.00');

      const cogsEntry = await findCogsEntry(sale.id);
      expect(cogsEntry).not.toBeNull();
      const totalDebit = cogsEntry!.lines.reduce(
        (sum, l) => sum.plus(l.debitAmount),
        new Prisma.Decimal(0),
      );
      const totalCredit = cogsEntry!.lines.reduce(
        (sum, l) => sum.plus(l.creditAmount),
        new Prisma.Decimal(0),
      );
      expect(totalDebit.toFixed(2)).toBe('30.00');
      expect(totalCredit.toFixed(2)).toBe('30.00');
      const creditLine = cogsEntry!.lines.find((l) =>
        l.creditAmount.greaterThan(0),
      );
      expect(creditLine?.accountId).toBe(resaleAccountId);

      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('7.000');
    });

    it('anulación de la venta: revierte EXACTAMENTE el costo consumido (asiento COGS invertido + valorización REVERSAL), restaura stock', async () => {
      const productId = await createValuedProduct();
      await seedValuedPurchase(productId, '10.000', '10.00');

      const created = await createDirectSale(productId, '4.000');
      expect(created.status).toBe(201);
      const sale = created.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      const originalValuation = await prisma.inventoryValuation.findFirstOrThrow({
        where: { productId, sourceType: 'SALE', eventType: 'ORIGINAL' },
      });

      const cancelled = await cancelSale(sale.id);
      expect(cancelled.status).toBe(200);

      const reversalValuation = await prisma.inventoryValuation.findFirst({
        where: {
          productId,
          sourceType: 'SALE',
          eventType: 'REVERSAL',
          reversesValuationId: originalValuation.id,
        },
      });
      expect(reversalValuation).not.toBeNull();
      expect(reversalValuation?.totalCost.toFixed(2)).toBe(
        originalValuation.totalCost.toFixed(2),
      );

      const originalCogsEntry = await findCogsEntry(sale.id);
      expect(originalCogsEntry).not.toBeNull();
      const cogsReversal = await prisma.accountingEntry.findFirst({
        where: { reversesEntryId: originalCogsEntry!.id },
        include: { lines: true },
      });
      expect(cogsReversal).not.toBeNull();
      const originalByAccount = new Map(
        originalCogsEntry!.lines.map((l) => [
          l.accountId,
          { debit: l.debitAmount, credit: l.creditAmount },
        ]),
      );
      for (const line of cogsReversal!.lines) {
        const original = originalByAccount.get(line.accountId);
        expect(original).toBeDefined();
        expect(line.debitAmount.toFixed(2)).toBe(original!.credit.toFixed(2));
        expect(line.creditAmount.toFixed(2)).toBe(original!.debit.toFixed(2));
      }

      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('10.000');
    });

    it('stock físico sin costo valorizado suficiente: 409, nunca inventa costo, sin ningún efecto persistente', async () => {
      const productId = await createValuedProduct();
      await seedValuedPurchase(productId, '5.000', '10.00');
      // Aumenta el stock físico MÁS ALLÁ de lo valorizado, sin pasar por
      // valorización (simulación de un ajuste/entrada no costeada) para
      // que el bloqueo sea exclusivamente por falta de costo, no de stock.
      await prisma.product.update({
        where: { id: productId },
        data: { stockCurrent: '20.000' },
      });

      const response = await createDirectSale(productId, '8.000');
      expect(response.status).toBe(409);

      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('20.000');
      const valuations = await prisma.inventoryValuation.findMany({
        where: { productId, sourceType: 'SALE' },
      });
      expect(valuations).toHaveLength(0);
    });

    it('producto SIN valuationMethod configurado: la venta funciona exactamente igual que antes de A6.2, sin postear ningún COGS', async () => {
      const productId = await createValuedProduct(null);
      await prisma.product.update({
        where: { id: productId },
        data: { stockCurrent: '20.000' },
      });

      const response = await createDirectSale(productId, '2.000');
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      const cogsEntry = await findCogsEntry(sale.id);
      expect(cogsEntry).toBeNull();
      const valuations = await prisma.inventoryValuation.findMany({
        where: { productId },
      });
      expect(valuations).toHaveLength(0);
    });

    it('producto con una capa histórica reconocida como GASTO (OPERATING_EXPENSE): 409 — nunca genera un segundo gasto COGS', async () => {
      const opexAccountId = await createTestAccount(
        `A62OPEX${nextSuffix().slice(-6)}`,
        'Gasto operativo sintético E2E A6.2',
        AccountType.EXPENSE,
      );
      await activateSystemKey(
        AccountingSystemKey.PURCHASE_OPERATING_EXPENSE,
        opexAccountId,
      );

      const productId = await createValuedProduct();
      await seedValuedPurchase(
        productId,
        '5.000',
        '10.00',
        PurchasePurpose.OPERATING_EXPENSE,
      );

      const response = await createDirectSale(productId, '2.000');
      expect(response.status).toBe(409);

      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('5.000');
    });

    it('dos ventas concurrentes del mismo producto que juntas exceden el pool valorizado: exactamente una se bloquea por costo insuficiente', async () => {
      const productId = await createValuedProduct();
      await seedValuedPurchase(productId, '10.000', '10.00');

      const [first, second] = await Promise.all([
        createDirectSale(productId, '6.000'),
        createDirectSale(productId, '6.000'),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const succeeded = first.status === 201 ? first : second;
      createdSaleIds.push((succeeded.body as SafeSaleBody).id);

      const product = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
      });
      expect(product.stockCurrent.toFixed(3)).toBe('4.000');
    });
  });
});
