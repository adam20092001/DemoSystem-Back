import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSourceType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  DocumentType,
  InventoryMovementOrigin,
  InventoryMovementType,
  InventoryValuationMethod,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
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
import { purgePurchasingResidue } from './helpers/purchasing-cleanup';
import {
  createProductRow,
  getDefaultLocationId,
} from './helpers/stock-fixtures';

/**
 * R2-FINAL — validación integral del backend multi-almacén. HTTP real,
 * PostgreSQL real (descartable, validado por la guardia E2E). Usa
 * operaciones REALES de compra -> recepción -> transferencia -> venta (nunca
 * entradas manuales como sustituto de una recepción). No altera restricciones
 * ni triggers. Suite pensada para ejecutarse en una base descartable: crea
 * sus propios datos y NO los retira (la base se destruye al terminar).
 */

interface SaleBody {
  id: string;
  status: string;
  items: { productId: string; location: { id: string } | null }[];
}
interface TransferBody {
  id: string;
  exitMovementId: string;
  entryMovementId: string;
  quantity: string;
}
interface ReceiptBody {
  id: string;
  status: string;
}

describe('R2-FINAL — validación integral multi-almacén (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let categoryId: string;
  let unitId: string;
  let customerId: string;
  let supplierId: string;
  let defaultLocationId: string;
  let locA: string;
  let locB: string;
  let whB: string;

  const RUN_ID = Date.now();
  let counter = 0;
  const nextSuffix = (): string => {
    counter += 1;
    return `${RUN_ID}${counter}`;
  };
  const http = () => request(app.getHttpServer());

  // ------------------------------------------------------------------
  // Fixtures vía API real
  // ------------------------------------------------------------------

  async function createAccount(
    code: string,
    type: AccountType,
  ): Promise<string> {
    const res = await http()
      .post('/api/v1/chart-of-accounts')
      .set('Cookie', adminCookie)
      .send({ code, name: `Cuenta e2e R2F ${code}`, type, isPostable: true });
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return (res.body as { id: string }).id;
  }

  async function mapKey(
    key: AccountingSystemKey,
    accountId: string,
  ): Promise<void> {
    const res = await http()
      .patch(`/api/v1/chart-of-accounts/system-keys/${key}`)
      .set('Cookie', adminCookie)
      .send({ accountId });
    if (res.status !== 200) throw new Error(JSON.stringify(res.body));
  }

  async function createWarehouse(
    locations: number,
  ): Promise<{ warehouseId: string; locationIds: string[] }> {
    const s = nextSuffix();
    const w = await http()
      .post('/api/v1/warehouses')
      .set('Cookie', adminCookie)
      .send({ code: `RF${s}`.slice(0, 20), name: 'Almacén e2e R2F' });
    if (w.status !== 201) throw new Error(JSON.stringify(w.body));
    const warehouseId = (w.body as { id: string }).id;
    const locationIds: string[] = [];
    for (let i = 0; i < locations; i += 1) {
      const l = await http()
        .post(`/api/v1/warehouses/${warehouseId}/locations`)
        .set('Cookie', adminCookie)
        .send({ code: `RL${i}${s}`.slice(0, 20), name: `Ubic ${i}` });
      if (l.status !== 201) throw new Error(JSON.stringify(l.body));
      locationIds.push((l.body as { id: string }).id);
    }
    return { warehouseId, locationIds };
  }

  /** Producto valorizado (promedio ponderado) para que la venta use costo real. */
  async function createProduct(
    valued = true,
    price = '50.00',
  ): Promise<string> {
    const s = nextSuffix();
    const row = await createProductRow(prisma, {
      data: {
        sku: `R2F-${s}`,
        name: `Producto e2e R2F ${s}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal(price),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('0.000'),
        status: ProductStatus.ACTIVE,
        valuationMethod: valued
          ? InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE
          : null,
      },
      select: { id: true },
    });
    return row.id;
  }

  /** Factura de compra CONFIRMED real (una línea). */
  async function confirmedInvoice(
    productId: string,
    quantity: string,
    unitCost = '10.00',
  ): Promise<{ invoiceId: string; lineId: string }> {
    const s = nextSuffix();
    const draft = await http()
      .post('/api/v1/purchase-invoices')
      .set('Cookie', adminCookie)
      .send({
        supplierId,
        documentType: PurchaseInvoiceDocumentType.FACTURA,
        documentSeries: 'F901',
        documentNumber: s.slice(-8),
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
    if (draft.status !== 201) throw new Error(JSON.stringify(draft.body));
    const id = (draft.body as { id: string }).id;
    const confirmed = await http()
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set('Cookie', adminCookie)
      .send({});
    if (confirmed.status !== 200)
      throw new Error(JSON.stringify(confirmed.body));
    const body = confirmed.body as { lines: { id: string }[] };
    return { invoiceId: id, lineId: body.lines[0].id };
  }

  function receive(
    invoiceId: string,
    lineId: string,
    quantity: string,
    locationId?: string,
  ): Promise<request.Response> {
    return http()
      .post(`/api/v1/purchase-invoices/${invoiceId}/receipts`)
      .set('Cookie', adminCookie)
      .send({
        lines: [
          {
            purchaseInvoiceLineId: lineId,
            quantity,
            ...(locationId ? { locationId } : {}),
          },
        ],
      });
  }

  /** Compra real + recepción total en la ubicación indicada. */
  async function stockViaReceipt(
    productId: string,
    quantity: string,
    locationId?: string,
    unitCost = '10.00',
  ): Promise<ReceiptBody> {
    const inv = await confirmedInvoice(productId, quantity, unitCost);
    const res = await receive(inv.invoiceId, inv.lineId, quantity, locationId);
    if (res.status !== 201) throw new Error(JSON.stringify(res.body));
    return res.body as ReceiptBody;
  }

  function cancelReceipt(id: string): Promise<request.Response> {
    return http()
      .post(`/api/v1/purchase-receipts/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Anulación e2e R2F' });
  }

  function transfer(
    productId: string,
    from: string,
    to: string,
    quantity: string,
    extra: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return http()
      .post('/api/v1/inventory/transfers')
      .set('Cookie', adminCookie)
      .send({
        productId,
        sourceLocationId: from,
        destinationLocationId: to,
        quantity,
        reason: 'Traslado e2e R2F',
        ...extra,
      });
  }

  function sell(
    productId: string,
    quantity: string,
    locationId?: string,
  ): Promise<request.Response> {
    return http()
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send({
        customerId,
        items: [{ productId, quantity, ...(locationId ? { locationId } : {}) }],
      });
  }

  function cancelSale(id: string): Promise<request.Response> {
    return http()
      .post(`/api/v1/sales/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Anulación e2e R2F' });
  }

  // ------------------------------------------------------------------
  // Observación e invariantes
  // ------------------------------------------------------------------

  async function balances(productId: string): Promise<Map<string, string>> {
    const rows = await prisma.stockBalance.findMany({ where: { productId } });
    return new Map(rows.map((b) => [b.locationId, b.quantity.toFixed(3)]));
  }
  const qty = (m: Map<string, string>, loc: string): string =>
    m.get(loc) ?? '0.000';

  /** Conciliación: stockCurrent = Σ saldos y ningún saldo negativo. */
  async function reconcile(productId: string): Promise<string> {
    const product = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
    });
    const rows = await prisma.stockBalance.findMany({ where: { productId } });
    const sum = rows.reduce(
      (acc, b) => acc.plus(b.quantity),
      new Prisma.Decimal(0),
    );
    expect(sum.toFixed(3)).toBe(product.stockCurrent.toFixed(3));
    for (const b of rows) expect(b.quantity.gte(0)).toBe(true);
    return product.stockCurrent.toFixed(3);
  }

  async function financialCounts(productId: string): Promise<{
    valuations: number;
    entries: number;
  }> {
    return {
      valuations: await prisma.inventoryValuation.count({
        where: { productId },
      }),
      entries: await prisma.accountingEntry.count(),
    };
  }

  /** Integridad documental completa de una transferencia (SQL + servicio). */
  async function assertTransferIntegrity(transferId: string): Promise<void> {
    const t = await prisma.stockTransfer.findUniqueOrThrow({
      where: { id: transferId },
    });
    expect(t.exitMovementId).not.toBe(t.entryMovementId);
    const refs = await prisma.inventoryMovement.findMany({
      where: { referenceType: 'StockTransfer', referenceId: t.id },
    });
    // Exactamente dos movimientos referencian al documento.
    expect(refs).toHaveLength(2);
    const exit = await prisma.inventoryMovement.findUniqueOrThrow({
      where: { id: t.exitMovementId },
    });
    const entry = await prisma.inventoryMovement.findUniqueOrThrow({
      where: { id: t.entryMovementId },
    });
    expect(new Set(refs.map((r) => r.id))).toEqual(
      new Set([exit.id, entry.id]),
    );
    for (const m of [exit, entry]) {
      expect(m.origin).toBe(InventoryMovementOrigin.TRANSFER);
      expect(m.referenceType).toBe('StockTransfer');
      expect(m.referenceId).toBe(t.id);
      expect(m.productId).toBe(t.productId);
      expect(m.quantity.toFixed(3)).toBe(t.quantity.toFixed(3));
    }
    expect(exit.movementType).toBe(InventoryMovementType.EXIT);
    expect(entry.movementType).toBe(InventoryMovementType.ENTRY);
    expect(exit.locationId).toBe(t.sourceLocationId);
    expect(entry.locationId).toBe(t.destinationLocationId);
    // Efecto consolidado cero: el EXIT baja y el ENTRY devuelve lo mismo.
    expect(exit.previousStock.minus(exit.newStock).toFixed(3)).toBe(
      t.quantity.toFixed(3),
    );
    expect(entry.newStock.minus(entry.previousStock).toFixed(3)).toBe(
      t.quantity.toFixed(3),
    );
    expect(entry.previousStock.toFixed(3)).toBe(exit.newStock.toFixed(3));
    // Efecto por ubicación exacto.
    expect(
      exit.locationPreviousStock!.minus(exit.locationNewStock!).toFixed(3),
    ).toBe(t.quantity.toFixed(3));
    expect(
      entry.locationNewStock!.minus(entry.locationPreviousStock!).toFixed(3),
    ).toBe(t.quantity.toFixed(3));
  }

  async function movementCount(productId: string): Promise<number> {
    return prisma.inventoryMovement.count({ where: { productId } });
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();
    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) throw new Error('login admin');
    adminCookie = adminLogin.cookie;

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
    await prisma.documentSequence.upsert({
      where: { documentType: DocumentType.QUOTE },
      update: {},
      create: {
        documentType: DocumentType.QUOTE,
        prefix: 'COT-',
        currentNumber: 0,
        padding: 6,
      },
    });
    categoryId = (
      await prisma.category.findFirstOrThrow({ where: { code: 'SERVICIOS' } })
    ).id;
    unitId = (await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } }))
      .id;
    const customer = await prisma.customer.create({
      data: {
        code: `R2F-C-${nextSuffix()}`.slice(0, 20),
        name: 'Cliente e2e R2F',
        isGeneric: false,
        customerType: 'PERSON',
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        creditEnabled: true,
      },
    });
    customerId = customer.id;

    const sup = await http()
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send({
        documentType: SupplierDocumentType.RUC,
        documentNumber: nextSuffix().slice(-11).padStart(11, '0'),
        legalName: 'Proveedor e2e R2F',
      });
    if (sup.status !== 201) throw new Error(JSON.stringify(sup.body));
    supplierId = (sup.body as { id: string }).id;

    const short = Date.now() % 1000000;
    await mapKey(
      AccountingSystemKey.ACCOUNTS_PAYABLE,
      await createAccount(`R2FAP${short}`, AccountType.LIABILITY),
    );
    await mapKey(
      AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
      await createAccount(`R2FRES${short}`, AccountType.ASSET),
    );
    await mapKey(
      AccountingSystemKey.COST_OF_GOODS_SOLD,
      await createAccount(`R2FCOGS${short}`, AccountType.COST),
    );

    defaultLocationId = await getDefaultLocationId(prisma);
    const a = await createWarehouse(1);
    const b = await createWarehouse(1);
    locA = a.locationIds[0];
    locB = b.locationIds[0];
    whB = b.warehouseId;
  }, 120000);

  afterAll(async () => {
    try {
      // Retira las ventas y cotizaciones propias (y lo que depende de ellas)
      // para no dejar numeración comercial ocupada que choque con otras
      // suites que reinician la secuencia NV-/COT-. Productos, facturas y
      // recepciones quedan como residuo (mismo criterio que otras suites).
      const sales = await prisma.sale.findMany({
        where: { customerId },
        select: { id: true },
      });
      const saleIds = sales.map((x) => x.id);
      const items = await prisma.saleItem.findMany({
        where: { saleId: { in: saleIds } },
        select: { id: true },
      });
      await prisma.inventoryValuation.deleteMany({
        where: { saleItemId: { in: items.map((x) => x.id) } },
      });
      const base = await prisma.accountingEntry.findMany({
        where: { sourceId: { in: saleIds } },
        select: { id: true },
      });
      const reversals = await prisma.accountingEntry.findMany({
        where: { reversesEntryId: { in: base.map((x) => x.id) } },
        select: { id: true },
      });
      const entryIds = [...base, ...reversals].map((x) => x.id);
      await prisma.accountingEntryLine.deleteMany({
        where: { entryId: { in: entryIds } },
      });
      await prisma.accountingEntry.deleteMany({
        where: { id: { in: entryIds } },
      });
      await prisma.saleItem.deleteMany({ where: { saleId: { in: saleIds } } });
      await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
      const quotes = await prisma.quote.findMany({
        where: { customerId },
        select: { id: true },
      });
      await prisma.quoteItem.deleteMany({
        where: { quoteId: { in: quotes.map((x) => x.id) } },
      });
      await prisma.quote.deleteMany({
        where: { id: { in: quotes.map((x) => x.id) } },
      });
      // Compras reales propias (facturas, recepciones, valorización, asientos, cuentas
      // y proveedor): se retiran para no romper otras suites de la base compartida.
      await purgePurchasingResidue(prisma, {
        supplierLegalNamePrefix: 'Proveedor e2e R2F',
        accountCodePrefixes: ['R2FAP', 'R2FRES', 'R2FCOGS'],
      });
      // Restaura los mapeos contables sintéticos (escritura directa de
      // fixture, como otras suites; la API no permite desasignar): otras
      // suites esperan estos system keys sin mapear al iniciar.
      await prisma.account.updateMany({
        where: {
          systemKey: {
            in: [
              AccountingSystemKey.COST_OF_GOODS_SOLD,
              AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
              AccountingSystemKey.ACCOUNTS_PAYABLE,
            ],
          },
        },
        data: { systemKey: null },
      });
    } finally {
      await prisma.$disconnect();
      await app.close();
    }
  });

  // ==================================================================
  // 3. Escenario integral principal
  // ==================================================================
  it('S1. compra -> recepción en A -> transferencia A->B -> venta desde B -> anulación de venta', async () => {
    const p = await createProduct();

    // Recepción real hacia A: 20 u. a 10.00
    await stockViaReceipt(p, '20.000', locA);
    let m = await balances(p);
    expect(qty(m, locA)).toBe('20.000');
    expect(await reconcile(p)).toBe('20.000');

    // Transferencia real A->B (8): sin efectos financieros ni de costo.
    const before = await financialCounts(p);
    const tr = await transfer(p, locA, locB, '8.000');
    expect(tr.status).toBe(201);
    const t = tr.body as TransferBody;
    m = await balances(p);
    expect(qty(m, locA)).toBe('12.000');
    expect(qty(m, locB)).toBe('8.000');
    expect(await reconcile(p)).toBe('20.000');
    expect(await financialCounts(p)).toEqual(before);
    await assertTransferIntegrity(t.id);

    // Venta real desde B (5): sale solo de B.
    const sale = await sell(p, '5.000', locB);
    expect(sale.status).toBe(201);
    const s = sale.body as SaleBody;
    expect(s.items[0].location?.id).toBe(locB);
    m = await balances(p);
    expect(qty(m, locA)).toBe('12.000');
    expect(qty(m, locB)).toBe('3.000');
    expect(await reconcile(p)).toBe('15.000');

    // COGS/valorización: 5 u. x 10.00 = 50.00, costo no alterado por transferir.
    const sv = await prisma.inventoryValuation.findFirstOrThrow({
      where: { productId: p, sourceType: 'SALE', eventType: 'ORIGINAL' },
    });
    expect(sv.totalCost.toFixed(2)).toBe('50.00');
    const cogs = await prisma.accountingEntry.findFirstOrThrow({
      where: {
        sourceType: AccountingSourceType.COGS,
        sourceId: s.id,
        eventType: 'ORIGINAL',
      },
      include: { lines: true },
    });
    const debit = cogs.lines.reduce(
      (a, l) => a.plus(l.debitAmount),
      new Prisma.Decimal(0),
    );
    expect(debit.toFixed(2)).toBe('50.00');

    // Anulación: la mercancía vuelve exactamente a B.
    const cancelled = await cancelSale(s.id);
    expect(cancelled.status).toBe(200);
    m = await balances(p);
    expect(qty(m, locA)).toBe('12.000');
    expect(qty(m, locB)).toBe('8.000');
    expect(await reconcile(p)).toBe('20.000');
    const rev = await prisma.inventoryValuation.findFirst({
      where: {
        productId: p,
        sourceType: 'SALE',
        eventType: 'REVERSAL',
        reversesValuationId: sv.id,
      },
    });
    expect(rev?.totalCost.toFixed(2)).toBe('50.00');

    // Kardex: cada operación con su origen, ubicación y transferId.
    const kardex = await http()
      .get(`/api/v1/inventory/products/${p}/movements?limit=50`)
      .set('Cookie', adminCookie);
    expect(kardex.status).toBe(200);
    const rows = (
      kardex.body as {
        data: {
          origin: string;
          movementType: string;
          location: { id: string } | null;
          transferId: string | null;
        }[];
      }
    ).data;
    const compact = rows
      .map((r) => `${r.origin}:${r.movementType}:${r.location?.id}`)
      .sort();
    expect(compact).toEqual(
      [
        `PURCHASE_RECEIPT:ENTRY:${locA}`,
        `TRANSFER:EXIT:${locA}`,
        `TRANSFER:ENTRY:${locB}`,
        `SALE:EXIT:${locB}`,
        `SALE_CANCELLATION:ENTRY:${locB}`,
      ].sort(),
    );
    const transferRows = rows.filter((r) => r.origin === 'TRANSFER');
    expect(transferRows.every((r) => r.transferId === t.id)).toBe(true);
    expect(
      rows
        .filter((r) => r.origin !== 'TRANSFER')
        .every((r) => r.transferId === null),
    ).toBe(true);
  });

  // ==================================================================
  // 4. Anulación de recepción tras transferir
  // ==================================================================
  it('S2. anular recepción cuando A ya no tiene saldo: 409 sin efectos; transferencia compensatoria; nunca descuenta de B', async () => {
    const p = await createProduct();
    const receipt = await stockViaReceipt(p, '10.000', locA);
    expect((await transfer(p, locA, locB, '4.000')).status).toBe(201);
    expect(qty(await balances(p), locA)).toBe('6.000');

    const mv = await movementCount(p);
    const val = await financialCounts(p);
    const fail1 = await cancelReceipt(receipt.id);
    expect(fail1.status).toBe(409);
    let m = await balances(p);
    expect(qty(m, locA)).toBe('6.000');
    expect(qty(m, locB)).toBe('4.000'); // B nunca se toca
    expect(await movementCount(p)).toBe(mv);
    expect(await financialCounts(p)).toEqual(val);
    expect(
      (
        await prisma.purchaseReceipt.findUniqueOrThrow({
          where: { id: receipt.id },
        })
      ).status,
    ).toBe('ACTIVE');
    expect(await reconcile(p)).toBe('10.000');

    // Compensación parcial (2): sigue sin alcanzar (A=8 < 10).
    expect((await transfer(p, locB, locA, '2.000')).status).toBe(201);
    expect((await cancelReceipt(receipt.id)).status).toBe(409);
    expect(qty(await balances(p), locB)).toBe('2.000');

    // Compensación total (2 más): A=10 y la anulación procede.
    expect((await transfer(p, locB, locA, '2.000')).status).toBe(201);
    const ok = await cancelReceipt(receipt.id);
    expect(ok.status).toBe(200);
    m = await balances(p);
    expect(qty(m, locA)).toBe('0.000');
    expect(qty(m, locB)).toBe('0.000');
    expect(await reconcile(p)).toBe('0.000');
  });

  // ==================================================================
  // 6. Concurrencia entre módulos reales
  // ==================================================================
  describe('concurrencia con operaciones reales', () => {
    const ROUNDS = 4;

    it('A. transferencia vs recepción REAL en la misma ubicación (origen)', async () => {
      for (let r = 0; r < ROUNDS; r += 1) {
        const p = await createProduct();
        await stockViaReceipt(p, '10.000', locA);
        const pending = await confirmedInvoice(p, '5.000');
        const mvBefore = await movementCount(p);
        const [tr, rc] = await Promise.all([
          transfer(p, locA, locB, '12.000'), // depende del orden
          receive(pending.invoiceId, pending.lineId, '5.000', locA),
        ]);
        expect([201, 409]).toContain(tr.status);
        expect(rc.status).toBe(201); // la recepción siempre procede
        const m = await balances(p);
        if (tr.status === 201) {
          expect(qty(m, locA)).toBe('3.000');
          expect(qty(m, locB)).toBe('12.000');
          await assertTransferIntegrity((tr.body as TransferBody).id);
          expect(await movementCount(p)).toBe(mvBefore + 3);
        } else {
          expect(qty(m, locA)).toBe('15.000');
          expect(qty(m, locB)).toBe('0.000');
          expect(await movementCount(p)).toBe(mvBefore + 1);
        }
        expect(await reconcile(p)).toBe('15.000');
      }
    });

    it('A2. transferencia hacia la ubicación donde llega una recepción REAL', async () => {
      for (let r = 0; r < ROUNDS; r += 1) {
        const p = await createProduct();
        await stockViaReceipt(p, '10.000', locA);
        const pending = await confirmedInvoice(p, '5.000');
        const [tr, rc] = await Promise.all([
          transfer(p, locA, locB, '10.000'),
          receive(pending.invoiceId, pending.lineId, '5.000', locB),
        ]);
        expect(tr.status).toBe(201);
        expect(rc.status).toBe(201);
        const m = await balances(p);
        expect(qty(m, locA)).toBe('0.000');
        expect(qty(m, locB)).toBe('15.000');
        expect(await reconcile(p)).toBe('15.000');
        await assertTransferIntegrity((tr.body as TransferBody).id);
      }
    });

    it('B. venta vs recepción REAL en la misma ubicación', async () => {
      for (let r = 0; r < ROUNDS; r += 1) {
        const p = await createProduct();
        await stockViaReceipt(p, '10.000', locA);
        const pending = await confirmedInvoice(p, '5.000');
        const [sl, rc] = await Promise.all([
          sell(p, '12.000', locA), // depende del orden
          receive(pending.invoiceId, pending.lineId, '5.000', locA),
        ]);
        expect([201, 409]).toContain(sl.status);
        expect(rc.status).toBe(201);
        const m = await balances(p);
        if (sl.status === 201) {
          expect(qty(m, locA)).toBe('3.000');
          expect(await reconcile(p)).toBe('3.000');
        } else {
          expect(qty(m, locA)).toBe('15.000');
          expect(await reconcile(p)).toBe('15.000');
          expect(
            await prisma.sale.count({
              where: { items: { some: { productId: p } } },
            }),
          ).toBe(0);
        }
      }
    });

    it('C. transferencia vs venta compitiendo por el mismo saldo: exactamente una gana', async () => {
      for (let r = 0; r < ROUNDS; r += 1) {
        const p = await createProduct();
        await stockViaReceipt(p, '10.000', locA);
        const [tr, sl] = await Promise.all([
          transfer(p, locA, locB, '7.000'),
          sell(p, '7.000', locA),
        ]);
        const statuses = [tr.status, sl.status].sort();
        expect(statuses).toEqual([201, 409]);
        const m = await balances(p);
        if (tr.status === 201) {
          expect(qty(m, locA)).toBe('3.000');
          expect(qty(m, locB)).toBe('7.000');
          expect(await reconcile(p)).toBe('10.000');
          await assertTransferIntegrity((tr.body as TransferBody).id);
        } else {
          expect(qty(m, locA)).toBe('3.000');
          expect(qty(m, locB)).toBe('0.000');
          expect(await reconcile(p)).toBe('3.000');
        }
        // Sin movimientos duplicados: 1 receipt + 2 (transfer) o + 1 (venta).
        expect(await movementCount(p)).toBe(tr.status === 201 ? 3 : 2);
      }
    });

    it('D. transferencia vs anulación de venta sobre la misma ubicación', async () => {
      for (let r = 0; r < ROUNDS; r += 1) {
        const p = await createProduct();
        await stockViaReceipt(p, '10.000', locA);
        const sale = await sell(p, '6.000', locA);
        expect(sale.status).toBe(201);
        const saleId = (sale.body as SaleBody).id;
        // A=4. Transferir 10 solo cabe si la anulación llega primero.
        const [tr, cx] = await Promise.all([
          transfer(p, locA, locB, '10.000'),
          cancelSale(saleId),
        ]);
        expect(cx.status).toBe(200);
        expect([201, 409]).toContain(tr.status);
        const m = await balances(p);
        if (tr.status === 201) {
          expect(qty(m, locA)).toBe('0.000');
          expect(qty(m, locB)).toBe('10.000');
          await assertTransferIntegrity((tr.body as TransferBody).id);
        } else {
          expect(qty(m, locA)).toBe('10.000');
          expect(qty(m, locB)).toBe('0.000');
        }
        expect(await reconcile(p)).toBe('10.000');
      }
    });

    it('E. transferencias opuestas concurrentes (A<->B): sin deadlock ni pérdida', async () => {
      for (let r = 0; r < ROUNDS * 2; r += 1) {
        const p = await createProduct();
        await stockViaReceipt(p, '10.000', locA);
        await stockViaReceipt(p, '10.000', locB);
        const batch = await Promise.all([
          transfer(p, locA, locB, '10.000'),
          transfer(p, locB, locA, '10.000'),
          transfer(p, locA, locB, '3.000'),
          transfer(p, locB, locA, '3.000'),
        ]);
        for (const res of batch) expect([201, 409]).toContain(res.status);
        expect(batch.some((b) => b.status === 500)).toBe(false);
        expect(await reconcile(p)).toBe('20.000');
        for (const res of batch) {
          if (res.status === 201) {
            await assertTransferIntegrity((res.body as TransferBody).id);
          }
        }
        const created = batch.filter((b) => b.status === 201).length;
        expect(await movementCount(p)).toBe(2 + created * 2);
      }
    });

    it('F. 6 transferencias opuestas con saldo para todas: todas proceden', async () => {
      const p = await createProduct();
      await stockViaReceipt(p, '50.000', locA);
      await stockViaReceipt(p, '50.000', locB);
      const batch = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) =>
          i % 2 === 0
            ? transfer(p, locA, locB, '5.000')
            : transfer(p, locB, locA, '5.000'),
        ),
      );
      expect(batch.map((b) => b.status)).toEqual([
        201, 201, 201, 201, 201, 201,
      ]);
      const m = await balances(p);
      expect(qty(m, locA)).toBe('50.000');
      expect(qty(m, locB)).toBe('50.000');
      expect(await reconcile(p)).toBe('100.000');
    });
  });

  // ==================================================================
  // 7. Compatibilidad MAIN/DEFAULT sin locationId
  // ==================================================================
  describe('operaciones antiguas sin locationId usan MAIN/DEFAULT', () => {
    it('movimiento manual, recepción, venta directa y conversión de cotización', async () => {
      const p = await createProduct();

      // Movimiento manual sin ubicación
      const man = await http()
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({ productId: p, quantity: '3.000', reason: 'Manual e2e R2F' });
      expect(man.status).toBe(201);
      expect(qty(await balances(p), defaultLocationId)).toBe('3.000');

      // Recepción real sin ubicación
      const rc = await stockViaReceipt(p, '10.000');
      expect(rc.id).toBeDefined();
      expect(qty(await balances(p), defaultLocationId)).toBe('13.000');

      // Venta directa sin ubicación
      const sale = await sell(p, '2.000');
      expect(sale.status).toBe(201);
      expect((sale.body as SaleBody).items[0].location?.id).toBe(
        defaultLocationId,
      );
      expect(qty(await balances(p), defaultLocationId)).toBe('11.000');

      // Conversión de cotización sin `locations`
      const q = await http()
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send({ customerId, items: [{ productId: p, quantity: '4.000' }] });
      expect(q.status).toBe(201);
      const conv = await http()
        .post(`/api/v1/sales/from-quote/${(q.body as { id: string }).id}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(conv.status).toBe(201);
      expect((conv.body as SaleBody).items[0].location?.id).toBe(
        defaultLocationId,
      );
      const m = await balances(p);
      expect(qty(m, defaultLocationId)).toBe('7.000');
      expect(m.size).toBe(1); // nada tocó ninguna otra ubicación
      expect(await reconcile(p)).toBe('7.000');

      // Todos los movimientos nuevos llevan MAIN/DEFAULT
      const movs = await prisma.inventoryMovement.findMany({
        where: { productId: p },
      });
      expect(movs.length).toBe(4);
      expect(movs.every((x) => x.locationId === defaultLocationId)).toBe(true);
    });
  });

  // ==================================================================
  // 5/8. Barrido global de integridad
  // ==================================================================
  it('Barrido global: todas las transferencias íntegras y todos los productos conciliados', async () => {
    const transfers = await prisma.stockTransfer.findMany({
      select: { id: true },
    });
    expect(transfers.length).toBeGreaterThan(10);
    for (const t of transfers) await assertTransferIntegrity(t.id);

    const products = await prisma.product.findMany({
      where: { sku: { startsWith: 'R2F-' } },
      select: { id: true },
    });
    for (const p of products) await reconcile(p.id);

    // Una transferencia nunca produce valorización ni asientos propios.
    const transferMovIds = (
      await prisma.inventoryMovement.findMany({
        where: { origin: InventoryMovementOrigin.TRANSFER },
        select: { id: true },
      })
    ).map((x) => x.id);
    expect(
      await prisma.inventoryValuation.count({
        where: { inventoryMovementId: { in: transferMovIds } },
      }),
    ).toBe(0);
    expect(
      await prisma.accountingEntry.count({
        where: { sourceId: { in: transfers.map((t) => t.id) } },
      }),
    ).toBe(0);
    expect(whB).toBeDefined();
  });
});
