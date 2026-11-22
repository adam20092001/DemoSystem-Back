import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  InventoryMovementOrigin,
  InventoryMovementType,
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
import { PrismaService } from '../src/database/prisma.service';
import { StockMovementEngine } from '../src/inventory/stock-movement.engine';
import { StockMovementCommand } from '../src/inventory/types/stock-movement-command';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';
import {
  createProductWithStock,
  deleteProductsWithBalances,
  getDefaultLocationId,
  isStockLocationActivated,
  setProductStock,
} from './helpers/stock-fixtures';

/**
 * R2-ACT — CONCURRENCIA REAL del backend (NestJS + Prisma + PostgreSQL).
 *
 * A diferencia del spike SQL previo, aquí las operaciones son PETICIONES HTTP
 * reales (o el motor real dentro de una transacción Prisma real) ejecutadas
 * en paralelo. Debe poder ejecutarse ANTES de R2-ACT (línea base: comporta-
 * miento existente) y DESPUÉS: los escenarios que dependen del motor por
 * ubicación se saltan solos (con aviso) cuando el trigger de conciliación
 * no existe. Cada ronda imprime un resumen "[R2-ACT-CC]" para comparar.
 */

const RUN_ID = Date.now();
let counter = 0;
const next = (): string => `${RUN_ID}${(counter += 1)}`;
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** [retraso del motor, retraso de la desactivación] en ms; alterna quién va primero. */
function jitter(round: number): [number, number] {
  const delay = 5 + ((round * 13) % 45);
  return round % 2 === 0 ? [0, delay] : [delay, 0];
}

function uuidFor(n: number): string {
  const base = (RUN_ID % 0xffffffff).toString(16).padStart(8, '0');
  return `${base}-0000-4000-8000-${n.toString(16).padStart(12, '0')}`;
}

interface IdBody {
  id: string;
}
interface InvoiceBody {
  id: string;
  lines: { id: string }[];
}

describe('R2-ACT — concurrencia real HTTP/Prisma (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let appPrisma: PrismaService;
  let engine: StockMovementEngine;
  let adminCookie: string;
  let adminUserId: string;
  let act = false;

  let categoryId: string;
  let unitId: string;
  let customerId: string;
  let supplierId: string;
  let mainWarehouseId: string;
  let defaultLocationId: string;
  let createdSaleSequence = false;

  const productIds: string[] = [];
  const saleIds: string[] = [];
  const invoiceIds: string[] = [];
  const supplierIds: string[] = [];
  const accountIds: string[] = [];
  const warehouseIds: string[] = [];
  const locationIds: string[] = [];
  let invoiceCounter = 0;

  async function newProduct(stock: string, label: string): Promise<string> {
    const suffix = next();
    const product = await createProductWithStock(
      prisma,
      {
        sku: `CC-${label}-${suffix}`,
        name: `Producto CC ${label} ${suffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '10.00',
        isInventoryTracked: true,
        status: ProductStatus.ACTIVE,
      },
      stock,
    );
    productIds.push(product.id);
    return product.id;
  }

  async function stockOf(productId: string): Promise<Prisma.Decimal> {
    const row = await prisma.product.findUniqueOrThrow({
      where: { id: productId },
      select: { stockCurrent: true },
    });
    return row.stockCurrent;
  }

  /** Invariantes: stock >= 0 y (tras ACT) consolidado = suma de saldos, saldos >= 0. */
  async function assertConsistent(ids: string[]): Promise<void> {
    for (const id of ids) {
      const stock = await stockOf(id);
      expect(stock.greaterThanOrEqualTo(0)).toBe(true);
      if (act) {
        const agg = await prisma.stockBalance.aggregate({
          where: { productId: id },
          _sum: { quantity: true },
          _min: { quantity: true },
        });
        expect((agg._sum.quantity ?? new Prisma.Decimal(0)).toString()).toBe(
          stock.toString(),
        );
        if (agg._min.quantity !== null) {
          expect(agg._min.quantity.greaterThanOrEqualTo(0)).toBe(true);
        }
      }
    }
  }

  function summary(label: string, statuses: number[]): void {
    const counts: Record<string, number> = {};
    for (const s of statuses) counts[s] = (counts[s] ?? 0) + 1;
    console.log(`[R2-ACT-CC] ${label} act=${act} ${JSON.stringify(counts)}`);
  }

  function postSale(
    items: { productId: string; quantity: string }[],
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send({ customerId, items });
  }
  function trackSale(res: request.Response): void {
    if (res.status === 201) saleIds.push((res.body as IdBody).id);
  }
  function cancelSale(id: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Prueba de concurrencia' });
  }
  function postExit(
    productId: string,
    quantity: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/inventory/exits')
      .set('Cookie', adminCookie)
      .send({ productId, quantity, reason: 'Salida CC' });
  }
  function deactivateWarehouse(id: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/warehouses/${id}/deactivate`)
      .set('Cookie', adminCookie)
      .send({});
  }
  function deactivateLocation(
    warehouseId: string,
    locationId: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(
        `/api/v1/warehouses/${warehouseId}/locations/${locationId}/deactivate`,
      )
      .set('Cookie', adminCookie)
      .send({});
  }
  function postReceipt(
    invoiceId: string,
    lines: { purchaseInvoiceLineId: string; quantity: string }[],
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${invoiceId}/receipts`)
      .set('Cookie', adminCookie)
      .send({ lines });
  }
  function cancelReceipt(id: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-receipts/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason: 'Prueba de concurrencia' });
  }

  /**
   * Factura CONFIRMED con una línea GOOD por producto. `lineOrder` fija, por
   * posición, el sufijo numérico del id de cada línea (el servicio procesa
   * las líneas por id ascendente en el comportamiento previo a D1), así la
   * prueba controla el orden relativo SIN depender del azar de los uuid.
   */
  async function confirmedInvoice(
    products: string[],
    lineSeq: number[],
    quantity = '1000',
  ): Promise<{ invoiceId: string; lineIds: string[] }> {
    invoiceCounter += 1;
    const draft = await request(app.getHttpServer())
      .post('/api/v1/purchase-invoices')
      .set('Cookie', adminCookie)
      .send({
        supplierId,
        documentType: PurchaseInvoiceDocumentType.FACTURA,
        documentSeries: 'F901',
        documentNumber: `${next()}`.slice(-8),
        issueDate: businessToday(),
        lines: products.map((productId) => ({
          productId,
          acquisitionKind: 'GOOD',
          purchasePurpose: 'RESALE_INVENTORY',
          quantity,
          unitCost: '10.00',
          taxCategory: 'UNAFFECTED',
        })),
      });
    if (draft.status !== 201) {
      throw new Error(`Factura fixture: ${JSON.stringify(draft.body)}`);
    }
    const invoice = draft.body as InvoiceBody;
    invoiceIds.push(invoice.id);
    const lineIds: string[] = [];
    for (let i = 0; i < invoice.lines.length; i++) {
      const newId = uuidFor(invoiceCounter * 100 + lineSeq[i]);
      await prisma.$executeRaw`UPDATE purchase_invoice_lines SET id = ${newId}::uuid WHERE id = ${invoice.lines[i].id}::uuid`;
      lineIds.push(newId);
    }
    const confirmed = await request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${invoice.id}/confirm`)
      .set('Cookie', adminCookie)
      .send({});
    if (confirmed.status !== 200) {
      throw new Error(`Confirmar fixture: ${JSON.stringify(confirmed.body)}`);
    }
    return { invoiceId: invoice.id, lineIds };
  }

  function engineCommand(
    productId: string,
    locationId: string,
    type: InventoryMovementType,
    quantity: string,
  ): StockMovementCommand {
    return {
      productId,
      quantity: new Prisma.Decimal(quantity),
      movementType: type,
      origin: InventoryMovementOrigin.MANUAL,
      reason: 'Movimiento CC directo',
      notes: null,
      actorUserId: adminUserId,
      ipAddress: null,
      referenceType: null,
      referenceId: null,
      locationId,
    };
  }

  async function createWarehouseWithLocation(): Promise<{
    warehouseId: string;
    locationId: string;
  }> {
    const code = `CC${next()}`.slice(-18);
    const wh = await request(app.getHttpServer())
      .post('/api/v1/warehouses')
      .set('Cookie', adminCookie)
      .send({ code, name: `Almacén CC ${code}` });
    if (wh.status !== 201) {
      throw new Error(`Almacén fixture: ${JSON.stringify(wh.body)}`);
    }
    const warehouseId = (wh.body as IdBody).id;
    warehouseIds.push(warehouseId);
    const loc = await createLocation(warehouseId);
    return { warehouseId, locationId: loc };
  }
  async function createLocation(warehouseId: string): Promise<string> {
    const code = `L${next()}`.slice(-20);
    const res = await request(app.getHttpServer())
      .post(`/api/v1/warehouses/${warehouseId}/locations`)
      .set('Cookie', adminCookie)
      .send({ code, name: `Ubicación CC ${code}` });
    if (res.status !== 201) {
      throw new Error(`Ubicación fixture: ${JSON.stringify(res.body)}`);
    }
    const id = (res.body as IdBody).id;
    locationIds.push(id);
    return id;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();
    appPrisma = app.get(PrismaService, { strict: false });
    engine = app.get(StockMovementEngine, { strict: false });
    act = await isStockLocationActivated(prisma);

    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error('No se pudo autenticar al admin de prueba');
    }
    adminCookie = adminLogin.cookie;
    adminUserId = (
      await prisma.user.findFirstOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
        select: { id: true },
      })
    ).id;

    const short = Date.now() % 1000000;
    categoryId = (
      await prisma.category.create({
        data: { code: `CCCAT${short}`, name: `Categoría CC ${short}` },
      })
    ).id;
    unitId = (
      await prisma.unit.create({
        data: {
          code: `CCUN${short}`,
          name: `Unidad CC ${short}`,
          abbreviation: 'ucc',
          allowDecimal: true,
        },
      })
    ).id;
    customerId = (
      await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente CC ${short}`,
          creditEnabled: true,
        },
      })
    ).id;

    // Secuencia NV propia de este spec (otras suites la eliminan al terminar).
    const hadSaleSequence =
      (await prisma.documentSequence.count({
        where: { documentType: DocumentType.SALE },
      })) > 0;
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
    createdSaleSequence = !hadSaleSequence;

    mainWarehouseId = (
      await prisma.warehouse.findFirstOrThrow({
        where: { isDefault: true },
        select: { id: true },
      })
    ).id;
    defaultLocationId = await getDefaultLocationId(prisma);

    // Mapeos contables SINTÉTICOS para poder confirmar facturas reales.
    const keys: [AccountingSystemKey, AccountType][] = [
      [AccountingSystemKey.ACCOUNTS_PAYABLE, AccountType.LIABILITY],
      [AccountingSystemKey.VAT_RECEIVABLE, AccountType.ASSET],
      [AccountingSystemKey.PURCHASE_RESALE_INVENTORY, AccountType.ASSET],
      [AccountingSystemKey.PURCHASE_INTERNAL_CONSUMPTION, AccountType.ASSET],
      [AccountingSystemKey.PURCHASE_FIXED_ASSET, AccountType.ASSET],
      [AccountingSystemKey.PURCHASE_OPERATING_EXPENSE, AccountType.ASSET],
      [AccountingSystemKey.PURCHASE_OTHER, AccountType.ASSET],
    ];
    let k = 0;
    for (const [systemKey, type] of keys) {
      k += 1;
      const created = await request(app.getHttpServer())
        .post('/api/v1/chart-of-accounts')
        .set('Cookie', adminCookie)
        .send({
          code: `CC${k}${short}`,
          name: `Cuenta sintética CC ${systemKey}`,
          type,
          isPostable: true,
        });
      if (created.status !== 201) {
        throw new Error(`Cuenta fixture: ${JSON.stringify(created.body)}`);
      }
      const accountId = (created.body as IdBody).id;
      accountIds.push(accountId);
      const mapped = await request(app.getHttpServer())
        .patch(`/api/v1/chart-of-accounts/system-keys/${systemKey}`)
        .set('Cookie', adminCookie)
        .send({ accountId });
      if (mapped.status !== 200) {
        throw new Error(`Mapeo fixture: ${JSON.stringify(mapped.body)}`);
      }
    }

    const supplier = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send({
        documentType: SupplierDocumentType.RUC,
        documentNumber: `${RUN_ID}`.slice(-11).padStart(11, '0'),
        legalName: `Proveedor CC ${short}`,
      });
    if (supplier.status !== 201) {
      throw new Error(`Proveedor fixture: ${JSON.stringify(supplier.body)}`);
    }
    supplierId = (supplier.body as IdBody).id;
    supplierIds.push(supplierId);
  }, 90000);

  afterAll(async () => {
    try {
      const receipts = await prisma.purchaseReceipt.findMany({
        where: { purchaseInvoiceId: { in: invoiceIds } },
        select: { id: true },
      });
      const receiptIds = receipts.map((r) => r.id);
      await prisma.purchaseReceiptLine.deleteMany({
        where: { purchaseReceiptId: { in: receiptIds } },
      });
      await prisma.purchaseReceipt.deleteMany({
        where: { id: { in: receiptIds } },
      });
      const posted = await prisma.purchaseInvoice.findMany({
        where: { id: { in: invoiceIds }, postedEntryId: { not: null } },
        select: { postedEntryId: true },
      });
      const postedIds = posted
        .map((p) => p.postedEntryId)
        .filter((id): id is string => id !== null);
      await prisma.purchaseInvoice.deleteMany({
        where: { id: { in: invoiceIds } },
      });
      if (postedIds.length > 0) {
        const reversals = await prisma.accountingEntry.findMany({
          where: { reversesEntryId: { in: postedIds } },
          select: { id: true },
        });
        const all = [...postedIds, ...reversals.map((r) => r.id)];
        await prisma.accountingEntryLine.deleteMany({
          where: { entryId: { in: all } },
        });
        await prisma.accountingEntry.deleteMany({ where: { id: { in: all } } });
      }

      if (saleIds.length > 0) {
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: saleIds } },
        });
        const where = {
          sourceType: 'SALE' as const,
          sourceId: { in: saleIds },
        };
        await prisma.accountingEntry.deleteMany({
          where: { ...where, eventType: 'REVERSAL' },
        });
        await prisma.accountingEntry.deleteMany({
          where: { ...where, eventType: 'ORIGINAL' },
        });
        await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
      }
      await prisma.inventoryMovement.deleteMany({
        where: { productId: { in: productIds } },
      });
      await deleteProductsWithBalances(prisma, productIds);
      // Cada almacén creado por la API nace con su ubicación DEFAULT (no
      // rastreada en locationIds): se eliminan todas las ubicaciones de los
      // almacenes propios, tras los productos (sus saldos van con ellos).
      await prisma.stockBalance.deleteMany({
        where: {
          location: {
            OR: [
              { id: { in: locationIds } },
              { warehouseId: { in: warehouseIds } },
            ],
          },
        },
      });
      await prisma.warehouseLocation.deleteMany({
        where: {
          OR: [
            { id: { in: locationIds } },
            { warehouseId: { in: warehouseIds } },
          ],
        },
      });
      await prisma.warehouse.deleteMany({
        where: { id: { in: warehouseIds } },
      });
      await prisma.supplier.deleteMany({ where: { id: { in: supplierIds } } });
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
      if (createdSaleSequence) {
        await prisma.documentSequence.deleteMany({
          where: { documentType: DocumentType.SALE },
        });
      }
      await prisma.customer.deleteMany({ where: { id: customerId } });
      await prisma.category.deleteMany({ where: { id: categoryId } });
      await prisma.unit.deleteMany({ where: { id: unitId } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 90000);

  // ------------------------------------------------------------------
  // 1. Venta contra desactivación de ubicación / almacén
  // ------------------------------------------------------------------
  it('1a. venta HTTP vs desactivar MAIN y DEFAULT: la venta se completa y la desactivación se rechaza de forma controlada', async () => {
    const p = await newProduct('50.000', 'S1A');
    const [sale, whOff, locOff] = await Promise.all([
      postSale([{ productId: p, quantity: '2.000' }]),
      deactivateWarehouse(mainWarehouseId),
      deactivateLocation(mainWarehouseId, defaultLocationId),
    ]);
    trackSale(sale);
    summary('1a', [sale.status, whOff.status, locOff.status]);
    expect(sale.status).toBe(201);
    expect(whOff.status).toBeGreaterThanOrEqual(400);
    expect(whOff.status).toBeLessThan(500);
    expect(locOff.status).toBeGreaterThanOrEqual(400);
    expect(locOff.status).toBeLessThan(500);
    expect((await stockOf(p)).toString()).toBe('48');
    await assertConsistent([p]);
  }, 60000);

  it('1b. (R2-ACT) motor real vs desactivación HTTP de una ubicación: o se mueve el stock o se desactiva, nunca ambos', async () => {
    if (!act) return console.log('[R2-ACT-CC] 1b N/A: R2-ACT no aplicada');
    const p = await newProduct('0.000', 'S1B');
    const { warehouseId } = await createWarehouseWithLocation();
    const outcomes = { moved: 0, deactivated: 0 };
    const statuses: number[] = [];
    for (let round = 0; round < 12; round++) {
      const locationId = await createLocation(warehouseId);
      // Se alterna quién arranca primero (con un pequeño desfase variable) para
      // ejercitar AMBOS órdenes de llegada, no solo el más rápido.
      const [engineDelay, deactivateDelay] = jitter(round);
      const [moved, off] = await Promise.allSettled([
        (async () => {
          await sleep(engineDelay);
          return appPrisma.$transaction((tx) =>
            engine.apply(
              tx,
              engineCommand(
                p,
                locationId,
                InventoryMovementType.ENTRY,
                '1.000',
              ),
            ),
          );
        })(),
        (async () => {
          await sleep(deactivateDelay);
          return deactivateLocation(warehouseId, locationId);
        })(),
      ]);
      const offStatus = off.status === 'fulfilled' ? off.value.status : 599;
      statuses.push(offStatus);
      const location = await prisma.warehouseLocation.findUniqueOrThrow({
        where: { id: locationId },
        select: { status: true },
      });
      const balance = await prisma.stockBalance.findUnique({
        where: { productId_locationId: { productId: p, locationId } },
      });
      if (moved.status === 'fulfilled') {
        outcomes.moved += 1;
        expect(location.status).toBe('ACTIVE');
        expect(balance?.quantity.toString()).toBe('1');
        expect(offStatus).toBe(409);
      } else {
        outcomes.deactivated += 1;
        expect(location.status).toBe('INACTIVE');
        expect(balance).toBeNull();
        expect(offStatus).toBe(200);
      }
    }
    summary('1b', statuses);
    console.log(`[R2-ACT-CC] 1b resultados ${JSON.stringify(outcomes)}`);
    await assertConsistent([p]);
  }, 120000);

  // ------------------------------------------------------------------
  // 2. Recepción contra desactivación de almacén
  // ------------------------------------------------------------------
  it('2a. recepción HTTP vs desactivar MAIN: la recepción se completa y la desactivación se rechaza de forma controlada', async () => {
    const p = await newProduct('0.000', 'S2A');
    const { invoiceId, lineIds } = await confirmedInvoice([p], [1]);
    const [receipt, off] = await Promise.all([
      postReceipt(invoiceId, [
        { purchaseInvoiceLineId: lineIds[0], quantity: '5.000' },
      ]),
      deactivateWarehouse(mainWarehouseId),
    ]);
    summary('2a', [receipt.status, off.status]);
    expect(receipt.status).toBe(201);
    expect(off.status).toBeGreaterThanOrEqual(400);
    expect(off.status).toBeLessThan(500);
    expect((await stockOf(p)).toString()).toBe('5');
    await assertConsistent([p]);
  }, 60000);

  it('2b. (R2-ACT) motor real vs desactivación HTTP de un almacén: o se mueve el stock o se desactiva, nunca ambos', async () => {
    if (!act) return console.log('[R2-ACT-CC] 2b N/A: R2-ACT no aplicada');
    const p = await newProduct('0.000', 'S2B');
    const statuses: number[] = [];
    let moved = 0;
    for (let round = 0; round < 10; round++) {
      const { warehouseId, locationId } = await createWarehouseWithLocation();
      const [engineDelay, deactivateDelay] = jitter(round);
      const [mv, off] = await Promise.allSettled([
        (async () => {
          await sleep(engineDelay);
          return appPrisma.$transaction((tx) =>
            engine.apply(
              tx,
              engineCommand(
                p,
                locationId,
                InventoryMovementType.ENTRY,
                '1.000',
              ),
            ),
          );
        })(),
        (async () => {
          await sleep(deactivateDelay);
          return deactivateWarehouse(warehouseId);
        })(),
      ]);
      const offStatus = off.status === 'fulfilled' ? off.value.status : 599;
      statuses.push(offStatus);
      const warehouse = await prisma.warehouse.findUniqueOrThrow({
        where: { id: warehouseId },
        select: { status: true },
      });
      if (mv.status === 'fulfilled') {
        moved += 1;
        expect(warehouse.status).toBe('ACTIVE');
        expect(offStatus).toBe(409);
      } else {
        expect(warehouse.status).toBe('INACTIVE');
        expect(offStatus).toBe(200);
      }
    }
    summary('2b', statuses);
    console.log(
      `[R2-ACT-CC] 2b movimientos confirmados=${moved} desactivaciones ganadas=${10 - moved}`,
    );
    await assertConsistent([p]);
  }, 120000);

  // ------------------------------------------------------------------
  // 3. Dos salidas concurrentes del mismo producto
  // ------------------------------------------------------------------
  it('3. dos ventas concurrentes de 7 sobre stock 10: una pasa, la otra recibe 409; nunca stock negativo', async () => {
    const p = await newProduct('10.000', 'S3');
    const results = await Promise.all([
      postSale([{ productId: p, quantity: '7.000' }]),
      postSale([{ productId: p, quantity: '7.000' }]),
    ]);
    results.forEach(trackSale);
    const statuses = results.map((r) => r.status).sort();
    summary('3 ventas', statuses);
    expect(statuses).toEqual([201, 409]);
    expect((await stockOf(p)).toString()).toBe('3');
    await assertConsistent([p]);
  }, 60000);

  it('3b. dos salidas manuales concurrentes de 7 sobre stock 10: una pasa, la otra recibe 409', async () => {
    const p = await newProduct('10.000', 'S3B');
    const results = await Promise.all([
      postExit(p, '7.000'),
      postExit(p, '7.000'),
    ]);
    const statuses = results.map((r) => r.status).sort();
    summary('3b salidas', statuses);
    expect(statuses).toEqual([201, 409]);
    expect((await stockOf(p)).toString()).toBe('3');
    await assertConsistent([p]);
  }, 60000);

  // ------------------------------------------------------------------
  // 4. Dos recepciones con productos compartidos en orden inverso
  // ------------------------------------------------------------------
  it('4. recepciones concurrentes con los mismos 2 productos en orden de línea inverso: sin deadlock ni 5xx', async () => {
    const a = await newProduct('0.000', 'S4A');
    const b = await newProduct('0.000', 'S4B');
    // Se ordena por productId para saber cuál es "primero" en el orden D1.
    const [first, second] = a < b ? [a, b] : [b, a];
    // Factura 1: líneas con ids ascendentes first -> second.
    const i1 = await confirmedInvoice([first, second], [1, 2]);
    // Factura 2: los MISMOS productos, pero la línea de `second` tiene el id
    // menor: el comportamiento previo a D1 los procesaba second -> first.
    const i2 = await confirmedInvoice([first, second], [4, 3]);
    const rounds = Number(process.env.CC_ROUNDS ?? 25);
    const statuses: number[] = [];
    for (let r = 0; r < rounds; r++) {
      const [x, y] = await Promise.all([
        postReceipt(i1.invoiceId, [
          { purchaseInvoiceLineId: i1.lineIds[0], quantity: '1.000' },
          { purchaseInvoiceLineId: i1.lineIds[1], quantity: '1.000' },
        ]),
        postReceipt(i2.invoiceId, [
          { purchaseInvoiceLineId: i2.lineIds[0], quantity: '1.000' },
          { purchaseInvoiceLineId: i2.lineIds[1], quantity: '1.000' },
        ]),
      ]);
      statuses.push(x.status, y.status);
    }
    summary('4 recepciones inversas', statuses);
    const ok = statuses.filter((s) => s === 201).length;
    const failures = statuses.filter((s) => s !== 201);
    console.log(
      `[R2-ACT-CC] 4 exitosas=${ok}/${statuses.length} fallos=${JSON.stringify(failures)}`,
    );
    expect(failures).toEqual([]);
    expect((await stockOf(first)).toString()).toBe(String(ok));
    expect((await stockOf(second)).toString()).toBe(String(ok));
    await assertConsistent([a, b]);
  }, 180000);

  // ------------------------------------------------------------------
  // 5. Venta concurrente con recepción
  // ------------------------------------------------------------------
  it('5. venta y recepción concurrentes sobre el mismo producto: ambas se completan y el stock final es exacto', async () => {
    const p = await newProduct('20.000', 'S5');
    const inv = await confirmedInvoice([p], [1]);
    const statuses: number[] = [];
    const rounds = 12;
    for (let r = 0; r < rounds; r++) {
      const [sale, receipt] = await Promise.all([
        postSale([{ productId: p, quantity: '1.000' }]),
        postReceipt(inv.invoiceId, [
          { purchaseInvoiceLineId: inv.lineIds[0], quantity: '1.000' },
        ]),
      ]);
      trackSale(sale);
      statuses.push(sale.status, receipt.status);
    }
    summary('5 venta+recepción', statuses);
    expect(statuses.every((s) => s === 201)).toBe(true);
    expect((await stockOf(p)).toString()).toBe('20');
    await assertConsistent([p]);
  }, 180000);

  // ------------------------------------------------------------------
  // 6. Anulación concurrente con una operación normal
  // ------------------------------------------------------------------
  it('6a. anular una venta mientras otra venta y una salida manual usan el mismo producto: stock final = suma de lo confirmado', async () => {
    const p = await newProduct('30.000', 'S6A');
    const base = await postSale([{ productId: p, quantity: '10.000' }]);
    trackSale(base);
    expect(base.status).toBe(201);
    const baseId = (base.body as IdBody).id;
    const [cancel, sale, exit] = await Promise.all([
      cancelSale(baseId),
      postSale([{ productId: p, quantity: '5.000' }]),
      postExit(p, '4.000'),
    ]);
    trackSale(sale);
    summary('6a', [cancel.status, sale.status, exit.status]);
    expect(cancel.status).toBe(200);
    expect(sale.status).toBe(201);
    expect(exit.status).toBe(201);
    // 30 - 10 (venta base) + 10 (anulación) - 5 - 4
    expect((await stockOf(p)).toString()).toBe('21');
    await assertConsistent([p]);
  }, 60000);

  it('6b. anular una recepción vs una venta que consume ese stock: exactamente una de las dos prospera', async () => {
    const p = await newProduct('0.000', 'S6B');
    const inv = await confirmedInvoice([p], [1]);
    const received = await postReceipt(inv.invoiceId, [
      { purchaseInvoiceLineId: inv.lineIds[0], quantity: '5.000' },
    ]);
    expect(received.status).toBe(201);
    const receiptId = (received.body as IdBody).id;
    const [cancel, sale] = await Promise.all([
      cancelReceipt(receiptId),
      postSale([{ productId: p, quantity: '3.000' }]),
    ]);
    trackSale(sale);
    summary('6b', [cancel.status, sale.status]);
    const cancelOk = cancel.status === 200;
    const saleOk = sale.status === 201;
    expect(cancelOk !== saleOk).toBe(true);
    expect([409, 200]).toContain(cancel.status);
    expect((await stockOf(p)).toString()).toBe(cancelOk ? '0' : '2');
    await assertConsistent([p]);
  }, 60000);

  // ------------------------------------------------------------------
  // 7. Rollback después de un error
  // ------------------------------------------------------------------
  it('7. venta de dos productos con el segundo insuficiente: 409, ninguna escritura parcial y locks liberados', async () => {
    const a = await newProduct('10.000', 'S7A');
    const b = await newProduct('1.000', 'S7B');
    const movementsBefore = await prisma.inventoryMovement.count({
      where: { productId: { in: [a, b] } },
    });
    const failed = await postSale([
      { productId: a, quantity: '4.000' },
      { productId: b, quantity: '2.000' },
    ]);
    summary('7', [failed.status]);
    expect(failed.status).toBe(409);
    expect((await stockOf(a)).toString()).toBe('10');
    expect((await stockOf(b)).toString()).toBe('1');
    expect(
      await prisma.inventoryMovement.count({
        where: { productId: { in: [a, b] } },
      }),
    ).toBe(movementsBefore);
    await assertConsistent([a, b]);
    // Los locks se liberaron: una venta inmediata sobre A no espera.
    const t0 = Date.now();
    const ok = await postSale([{ productId: a, quantity: '1.000' }]);
    trackSale(ok);
    expect(ok.status).toBe(201);
    expect(Date.now() - t0).toBeLessThan(3000);
    expect((await stockOf(a)).toString()).toBe('9');
  }, 60000);

  // ------------------------------------------------------------------
  // 8. Tiempos de espera de las transacciones Prisma
  // ------------------------------------------------------------------
  it('8. lock de producto retenido más que el límite de 5 s de la transacción Prisma: error controlado, sin escrituras parciales y recuperación', async () => {
    const p = await newProduct('10.000', 'S8');
    // El lock se retiene 7 s (> límite de 5 s de la transacción Prisma de la
    // venta) y se libera SOLO por tiempo, nunca esperando a la venta.
    const holder = prisma.$transaction(
      async (tx) => {
        await tx.$queryRaw`SELECT id FROM products WHERE id = ${p}::uuid FOR UPDATE`;
        await sleep(7000);
      },
      { timeout: 30000, maxWait: 10000 },
    );
    await sleep(500);
    const t0 = Date.now();
    const blocked = await postSale([{ productId: p, quantity: '2.000' }]);
    const elapsed = Date.now() - t0;
    await holder;
    trackSale(blocked);
    summary('8 timeout', [blocked.status]);
    console.log(
      `[R2-ACT-CC] 8 venta bloqueada: status=${blocked.status} elapsedMs=${elapsed} body=${JSON.stringify(blocked.body).slice(0, 200)}`,
    );
    // La transacción de Prisma vence a los ~5 s: nunca debe quedar colgada
    // indefinidamente ni dejar escrituras parciales.
    expect(elapsed).toBeLessThan(15000);
    if (blocked.status !== 201) {
      expect(blocked.status).toBeGreaterThanOrEqual(400);
      expect((await stockOf(p)).toString()).toBe('10');
    } else {
      expect((await stockOf(p)).toString()).toBe('8');
    }
    await assertConsistent([p]);
    // Recuperación: tras liberar, el sistema vuelve a operar normalmente.
    const after = await postSale([{ productId: p, quantity: '1.000' }]);
    trackSale(after);
    expect(after.status).toBe(201);
    await assertConsistent([p]);
  }, 60000);

  it('9. (R2-ACT) una escritura directa incoherente de stock es rechazada al COMMIT', async () => {
    if (!act) return console.log('[R2-ACT-CC] 9 N/A: R2-ACT no aplicada');
    const p = await newProduct('5.000', 'S9');
    await expect(
      prisma.product.update({
        where: { id: p },
        data: { stockCurrent: '9.000' },
      }),
    ).rejects.toThrow();
    expect((await stockOf(p)).toString()).toBe('5');
    // Y la vía coherente sí funciona.
    await setProductStock(prisma, p, '9.000');
    expect((await stockOf(p)).toString()).toBe('9');
    await assertConsistent([p]);
  }, 60000);
});
