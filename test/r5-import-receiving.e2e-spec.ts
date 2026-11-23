import { INestApplication } from '@nestjs/common';
import { App } from 'supertest/types';
import { E2E_ADMIN_USERNAME } from './helpers/constants';
import { ImportOperationsService } from '../src/import-operations/import-operations.service';
import {
  createR5Context,
  IdBody,
  InvoiceBody,
  OperationBody,
  R5Context,
  ShipmentBody,
} from './helpers/r5-fixtures';
import request from 'supertest';

interface LinkBody extends IdBody {
  importShipmentLineId: string;
  purchaseReceiptLineId: string;
  linkedQuantity: string;
  status: string;
}
interface ReceivingResult {
  requestId: string;
  idempotentReplay: boolean;
  mode: 'RECEIVE' | 'LINK_EXISTING';
  receipt: {
    id: string;
    status: string;
    lines: { id: string; purchaseInvoiceLineId: string; quantity: string }[];
  } | null;
  links: LinkBody[];
  operationCompleted: boolean;
  operation: { id: string; status: string };
}
interface SummaryLine {
  importShipmentLineId: string;
  isReceivable: boolean;
  invoicedQuantity: string | null;
  assignedToShipmentsQuantity: string | null;
  receivedQuantity: string | null;
  shipmentLineQuantity: string;
  linkedQuantity: string;
  pendingQuantity: string;
  invoicePendingReceivableQuantity: string | null;
  maxReceivableNow: string;
  candidateReceiptLines: {
    purchaseReceiptLineId: string;
    receivedQuantity: string;
    availableToLinkQuantity: string;
  }[];
}
interface Summary {
  status: string;
  canReceive: boolean;
  cannotReceiveReason: string | null;
  pendingQuantityTotal: string;
  canComplete: boolean;
  cannotCompleteReason: string | null;
  purchaseInvoiceStatus: string | null;
  shipments: {
    importShipmentId: string;
    status: string;
    canReceive: boolean;
    lines: SummaryLine[];
  }[];
}
interface Scenario {
  invoice: InvoiceBody;
  invoiceLineId: string;
  op: OperationBody;
  shipment: ShipmentBody;
  shipmentLineId: string;
  productId: string;
}

/**
 * R5 — recibir mercadería desde Importaciones. HTTP real y PostgreSQL real.
 * Todas las operaciones de escritura las ejecuta un usuario cuyo ÚNICO rol
 * activo es PURCHASING; ADMIN solo prepara mapeos contables y almacenes.
 */
describe('R5 — recepción de mercadería desde Importaciones (e2e)', () => {
  let ctx: R5Context;
  let app: INestApplication<App>;
  let keyCounter = 0;
  const nextKey = (): string => {
    keyCounter += 1;
    return `r5-${Date.now()}-${keyCounter}`;
  };

  beforeAll(async () => {
    ctx = await createR5Context('imp');
    app = ctx.app;
  }, 180000);

  afterAll(async () => {
    await ctx.dispose();
  });

  async function scenario(
    opts: {
      quantity?: string;
      shipped?: string;
      valued?: boolean;
      arrived?: boolean;
      confirmed?: boolean;
      invoiceOver?: Record<string, unknown>;
    } = {},
  ): Promise<Scenario> {
    const quantity = opts.quantity ?? '10.000';
    const productId = await ctx.newProduct(opts.valued === true);
    const supplierId = await ctx.newSupplier();
    let invoice = await ctx.createInvoice(supplierId, opts.invoiceOver ?? {}, {
      productId,
      quantity,
    });
    const invoiceLineId = invoice.lines[0].id;
    if (opts.confirmed !== false) {
      invoice = await ctx.confirm(invoice.id);
    }
    const op = await ctx.newOperation(invoice.id);
    if (opts.confirmed === false) {
      return {
        invoice,
        invoiceLineId,
        op,
        shipment: { id: '', status: '', lines: [] },
        shipmentLineId: '',
        productId,
      };
    }
    const shipment = await ctx.createShipment(op.id, [
      { invoiceLineId, quantity: opts.shipped ?? quantity },
    ]);
    if (opts.arrived !== false) {
      await ctx.arriveShipment(shipment.id);
    }
    return {
      invoice,
      invoiceLineId,
      op,
      shipment,
      shipmentLineId: shipment.lines[0].id,
      productId,
    };
  }

  function receive(
    s: Scenario,
    lines: {
      importShipmentLineId: string;
      quantity: string;
      locationId?: string;
    }[],
    opts: {
      key?: string | null;
      completeOperation?: boolean;
      cookie?: string;
      receivedDate?: string;
    } = {},
  ): Promise<request.Response> {
    const req = request(app.getHttpServer())
      .post(
        `/api/v1/import-operations/${s.op.id}/shipments/${s.shipment.id}/receive`,
      )
      .set('Cookie', opts.cookie ?? ctx.purchasingCookie);
    if (opts.key !== null) {
      req.set('Idempotency-Key', opts.key ?? nextKey());
    }
    return req.send({
      lines,
      ...(opts.completeOperation === undefined
        ? {}
        : { completeOperation: opts.completeOperation }),
      ...(opts.receivedDate === undefined
        ? {}
        : { receivedDate: opts.receivedDate }),
    });
  }
  function linkExisting(
    s: Scenario,
    links: {
      importShipmentLineId: string;
      purchaseReceiptLineId: string;
      linkedQuantity: string;
    }[],
    opts: { key?: string; completeOperation?: boolean; cookie?: string } = {},
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(
        `/api/v1/import-operations/${s.op.id}/shipments/${s.shipment.id}/link-receipts`,
      )
      .set('Cookie', opts.cookie ?? ctx.purchasingCookie)
      .set('Idempotency-Key', opts.key ?? nextKey())
      .send({
        links,
        ...(opts.completeOperation === undefined
          ? {}
          : { completeOperation: opts.completeOperation }),
      });
  }
  async function comprasReceipt(
    s: Scenario,
    quantity: string,
    over: Record<string, unknown> = {},
  ): Promise<ReceivingResult['receipt'] & { id: string }> {
    return ctx.ok(
      await ctx.asP('post', `/purchase-invoices/${s.invoice.id}/receipts`, {
        lines: [{ purchaseInvoiceLineId: s.invoiceLineId, quantity }],
        ...over,
      }),
      201,
      'recepción desde Compras',
    );
  }
  async function stock(productId: string): Promise<string> {
    return (
      await ctx.prisma.product.findUniqueOrThrow({ where: { id: productId } })
    ).stockCurrent.toFixed(3);
  }
  async function snapshot(s: Scenario): Promise<{
    stock: string;
    receipts: number;
    links: number;
    requests: number;
    movements: number;
    valuations: number;
    entries: number;
    opStatus: string;
  }> {
    return {
      stock: await stock(s.productId),
      receipts: await ctx.prisma.purchaseReceipt.count({
        where: { purchaseInvoiceId: s.invoice.id },
      }),
      links: await ctx.prisma.importReceiptLink.count({
        where: {
          importShipmentLine: {
            importShipment: { importOperationId: s.op.id },
          },
        },
      }),
      requests: await ctx.prisma.importReceivingRequest.count({
        where: { importOperationId: s.op.id },
      }),
      movements: await ctx.prisma.inventoryMovement.count({
        where: { productId: s.productId },
      }),
      valuations: await ctx.prisma.inventoryValuation.count({
        where: { productId: s.productId },
      }),
      entries: await ctx.prisma.accountingEntry.count(),
      opStatus: (
        await ctx.prisma.importOperation.findUniqueOrThrow({
          where: { id: s.op.id },
        })
      ).status,
    };
  }
  async function summary(
    s: Scenario,
    cookie = ctx.purchasingCookie,
  ): Promise<Summary> {
    return ctx.ok<Summary>(
      await ctx.api('get', `/import-operations/${s.op.id}/receiving`, cookie),
      200,
      'resumen',
    );
  }
  const line = (q: string, s: Scenario, locationId?: string) => ({
    importShipmentLineId: s.shipmentLineId,
    quantity: q,
    ...(locationId === undefined ? {} : { locationId }),
  });

  it('B1. totalidad: crea UNA recepción de compra con stock, valorización y vínculo; no confirma ni duplica deuda/asientos', async () => {
    const s = await scenario({ valued: true });
    const base = await snapshot(s);
    const entriesForInvoice = await ctx.prisma.accountingEntry.count({
      where: { sourceId: s.invoice.id },
    });
    expect(entriesForInvoice).toBe(1);

    const res = ctx.ok<ReceivingResult>(
      await receive(s, [line('10.000', s)]),
      201,
      'recibir',
    );
    expect(res).toMatchObject({
      mode: 'RECEIVE',
      idempotentReplay: false,
      operationCompleted: false,
    });
    expect(res.receipt?.status).toBe('ACTIVE');
    expect(res.receipt?.lines).toHaveLength(1);
    expect(res.links).toHaveLength(1);
    expect(res.links[0]).toMatchObject({
      importShipmentLineId: s.shipmentLineId,
      linkedQuantity: '10.000',
      status: 'ACTIVE',
      purchaseReceiptLineId: res.receipt?.lines[0].id,
    });

    const after = await snapshot(s);
    expect(after.stock).toBe('10.000');
    expect(after.receipts).toBe(base.receipts + 1);
    expect(after.links).toBe(base.links + 1);
    expect(after.movements).toBe(base.movements + 1);
    expect(after.valuations).toBe(base.valuations + 1);
    // Sin asientos nuevos (no hay cuentas de tránsito configuradas): deuda NO duplicada
    expect(after.entries).toBe(base.entries);
    expect(
      await ctx.prisma.accountingEntry.count({
        where: { sourceId: s.invoice.id },
      }),
    ).toBe(1);
    const invoice = ctx.ok<{ status: string }>(
      await ctx.asP('get', `/purchase-invoices/${s.invoice.id}`),
      200,
      'factura',
    );
    expect(invoice.status).toBe('CONFIRMED');

    // La recepción es consultable por Compras como cualquier otra
    const receipts = ctx.ok<{ receipts: { id: string }[] }>(
      await ctx.asP('get', `/purchase-invoices/${s.invoice.id}/receipts`),
      200,
      'recepciones de la factura',
    );
    expect(receipts.receipts.map((r) => r.id)).toContain(res.receipt?.id);

    // Auditoría con el usuario real (PURCHASING), no ADMIN
    for (const action of [
      'IMPORT_RECEIVING_RECEIVED',
      'PURCHASE_RECEIPT_CREATED',
      'IMPORT_RECEIPT_LINK_CREATED',
    ]) {
      const rows = await ctx.prisma.auditLog.findMany({
        where: { action },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(rows[0]?.userId).toBe(ctx.purchasingUserId);
    }
  });

  it('B2. parcial y varias recepciones hasta completar; exceso bloqueado con error por campo', async () => {
    const s = await scenario();
    const first = ctx.ok<ReceivingResult>(
      await receive(s, [line('4.000', s)]),
      201,
      'parcial 1',
    );
    expect(first.links[0].linkedQuantity).toBe('4.000');
    let sum = await summary(s);
    expect(sum.shipments[0].lines[0]).toMatchObject({
      invoicedQuantity: '10.000',
      assignedToShipmentsQuantity: '10.000',
      receivedQuantity: '4.000',
      shipmentLineQuantity: '10.000',
      linkedQuantity: '4.000',
      pendingQuantity: '6.000',
      invoicePendingReceivableQuantity: '6.000',
      maxReceivableNow: '6.000',
    });
    expect(sum.pendingQuantityTotal).toBe('6.000');
    expect(sum.canComplete).toBe(false);
    expect(sum.cannotCompleteReason).toMatch(/pendientes/);

    const over = await receive(s, [line('6.001', s)]);
    expect(over.status).toBe(409);
    expect(ctx.err(over)).toMatchObject({
      kind: 'FORM',
      code: 'IMPORT_QUANTITY_EXCEEDS_PENDING',
      errors: [{ field: 'lines[0].quantity', type: 'BUSINESS' }],
    });
    expect(await stock(s.productId)).toBe('4.000');

    ctx.ok(await receive(s, [line('6.000', s)]), 201, 'parcial 2');
    expect(await stock(s.productId)).toBe('10.000');
    sum = await summary(s);
    expect(sum.shipments[0].lines[0]).toMatchObject({
      linkedQuantity: '10.000',
      pendingQuantity: '0.000',
      maxReceivableNow: '0.000',
    });
    expect(sum.canComplete).toBe(true);
    const more = await receive(s, [line('0.001', s)]);
    expect(more.status).toBe(409);
    expect(
      await ctx.prisma.purchaseReceipt.count({
        where: { purchaseInvoiceId: s.invoice.id },
      }),
    ).toBe(2);
  });

  it('B3. recepción ya registrada desde Compras: se vincula sin mover stock, valorizar ni asentar; no se cuenta dos veces', async () => {
    const s = await scenario({ valued: true });
    const receipt = await comprasReceipt(s, '6.000');
    const base = await snapshot(s);

    // El resumen lista la línea recibida como vinculable
    let sum = await summary(s);
    const lineSummary = sum.shipments[0].lines[0];
    expect(lineSummary.receivedQuantity).toBe('6.000');
    expect(lineSummary.linkedQuantity).toBe('0.000');
    expect(lineSummary.pendingQuantity).toBe('10.000');
    expect(lineSummary.invoicePendingReceivableQuantity).toBe('4.000');
    expect(lineSummary.maxReceivableNow).toBe('4.000');
    expect(lineSummary.candidateReceiptLines).toHaveLength(1);
    expect(lineSummary.candidateReceiptLines[0].availableToLinkQuantity).toBe(
      '6.000',
    );

    const receiptLineId = receipt.lines[0].id;
    // exceso sobre lo recibido: 409 sin efectos
    const tooMuch = await linkExisting(s, [
      {
        importShipmentLineId: s.shipmentLineId,
        purchaseReceiptLineId: receiptLineId,
        linkedQuantity: '6.001',
      },
    ]);
    expect(tooMuch.status).toBe(409);
    expect((await snapshot(s)).links).toBe(base.links);

    const linked = ctx.ok<ReceivingResult>(
      await linkExisting(s, [
        {
          importShipmentLineId: s.shipmentLineId,
          purchaseReceiptLineId: receiptLineId,
          linkedQuantity: '6.000',
        },
      ]),
      201,
      'vincular',
    );
    expect(linked.mode).toBe('LINK_EXISTING');
    expect(linked.receipt).toBeNull();
    expect(linked.links[0].linkedQuantity).toBe('6.000');
    let after = await snapshot(s);
    expect(after).toMatchObject({
      stock: base.stock,
      receipts: base.receipts,
      movements: base.movements,
      valuations: base.valuations,
      entries: base.entries,
      links: base.links + 1,
    });

    // Vínculo duplicado: la línea ya quedó totalmente vinculada
    const dup = await linkExisting(s, [
      {
        importShipmentLineId: s.shipmentLineId,
        purchaseReceiptLineId: receiptLineId,
        linkedQuantity: '0.001',
      },
    ]);
    expect(dup.status).toBe(409);

    // Lo que falta (4) se recibe desde Importaciones; no se vuelve a contar lo ya recibido
    sum = await summary(s);
    expect(sum.shipments[0].lines[0]).toMatchObject({
      linkedQuantity: '6.000',
      pendingQuantity: '4.000',
      maxReceivableNow: '4.000',
    });
    ctx.ok(await receive(s, [line('4.000', s)]), 201, 'resto');
    after = await snapshot(s);
    expect(after.stock).toBe('10.000');
    expect(after.receipts).toBe(2);
  });

  it('B4. una factura en varias importaciones: una recepción nunca se atribuye dos veces', async () => {
    const supplierId = await ctx.newSupplier();
    const sharedProduct = await ctx.newProduct(false);
    const invoice = await ctx.confirm(
      (
        await ctx.createInvoice(
          supplierId,
          {},
          { quantity: '10.000', productId: sharedProduct },
        )
      ).id,
    );
    const invoiceLineId = invoice.lines[0].id;
    const productId = sharedProduct;
    const mk = async () => {
      const op = await ctx.newOperation(invoice.id);
      const shipment = await ctx.createShipment(op.id, [
        { invoiceLineId, quantity: '5.000' },
      ]);
      await ctx.arriveShipment(shipment.id);
      return {
        invoice,
        invoiceLineId,
        op,
        shipment,
        shipmentLineId: shipment.lines[0].id,
        productId,
      } satisfies Scenario;
    };
    const a = await mk();
    const b = await mk();
    const receipt = await comprasReceipt(a, '6.000');
    const receiptLineId = receipt.lines[0].id;

    ctx.ok(
      await linkExisting(a, [
        {
          importShipmentLineId: a.shipmentLineId,
          purchaseReceiptLineId: receiptLineId,
          linkedQuantity: '5.000',
        },
      ]),
      201,
      'A vincula 5',
    );
    // B solo puede vincular el 1 restante de esa línea de recepción
    const tooMuch = await linkExisting(b, [
      {
        importShipmentLineId: b.shipmentLineId,
        purchaseReceiptLineId: receiptLineId,
        linkedQuantity: '2.000',
      },
    ]);
    expect(tooMuch.status).toBe(409);
    const sumB = await summary(b);
    expect(
      sumB.shipments[0].lines[0].candidateReceiptLines[0]
        .availableToLinkQuantity,
    ).toBe('1.000');
    ctx.ok(
      await linkExisting(b, [
        {
          importShipmentLineId: b.shipmentLineId,
          purchaseReceiptLineId: receiptLineId,
          linkedQuantity: '1.000',
        },
      ]),
      201,
      'B vincula 1',
    );
    // El resto de B se recibe físicamente: facturado 10 − recibido 6 = 4 disponibles
    const over = await receive(b, [line('4.001', b)]);
    expect(over.status).toBe(409);
    ctx.ok(await receive(b, [line('4.000', b)]), 201, 'B recibe 4');
    const total = await ctx.prisma.purchaseReceiptLine.aggregate({
      where: {
        purchaseInvoiceLineId: invoiceLineId,
        purchaseReceipt: { status: 'ACTIVE' },
      },
      _sum: { quantity: true },
    });
    expect(total._sum.quantity?.toFixed(3)).toBe('10.000');
  });

  it('B5. exceso frente a lo ya recibido por Compras (aunque la importación tenga pendiente)', async () => {
    const s = await scenario();
    await comprasReceipt(s, '7.000');
    const res = await receive(s, [line('4.000', s)]);
    expect(res.status).toBe(409);
    expect(ctx.err(res)).toMatchObject({
      code: 'INVOICE_QUANTITY_EXCEEDED',
      errors: [{ field: 'lines[0].quantity', type: 'BUSINESS' }],
    });
    const base = await snapshot(s);
    expect(base.stock).toBe('7.000');
    ctx.ok(await receive(s, [line('3.000', s)]), 201, 'solo lo disponible');
    expect(await stock(s.productId)).toBe('10.000');
  });

  it('B6. ubicación: destino válido recibe en esa ubicación; inexistente/inactiva se rechaza sin efectos', async () => {
    const s = await scenario();
    const locationId = await ctx.newLocation();
    const base = await snapshot(s);

    const missing = await receive(s, [
      line('2.000', s, '00000000-0000-4000-8000-000000000000'),
    ]);
    expect(missing.status).toBe(404);
    expect(await snapshot(s)).toEqual(base);

    const malformed = await receive(s, [line('2.000', s, 'no-es-uuid')]);
    expect(malformed.status).toBe(400);
    expect(ctx.err(malformed).errors?.[0].field).toBe('lines[0].locationId');

    ctx.ok(
      await receive(s, [line('2.000', s, locationId)]),
      201,
      'ubicación válida',
    );
    const balance = await ctx.prisma.stockBalance.findFirstOrThrow({
      where: { productId: s.productId, locationId },
    });
    expect(balance.quantity.toFixed(3)).toBe('2.000');

    // Ubicación sin movimientos que luego se desactiva: se rechaza sin efectos
    const inactiveLocation = await ctx.newLocation();
    const row = await ctx.prisma.warehouseLocation.findUniqueOrThrow({
      where: { id: inactiveLocation },
    });
    ctx.ok(
      await ctx.api(
        'post',
        `/warehouses/${row.warehouseId}/locations/${inactiveLocation}/deactivate`,
        ctx.adminCookie,
        {},
      ),
      200,
      'desactivar ubicación',
    );
    const afterInactive = await snapshot(s);
    const inactive = await receive(s, [line('2.000', s, inactiveLocation)]);
    expect(inactive.status).toBe(409);
    expect(await snapshot(s)).toEqual(afterInactive);
  });

  it('B7. factura en borrador, embarque no llegado y operación no activa se rechazan; ARRIVED y COMPLETED no mueven stock', async () => {
    // Factura DRAFT: la operación puede existir pero no recibe
    const draft = await scenario({ confirmed: false });
    const sumDraft = await summary(draft);
    expect(sumDraft).toMatchObject({
      canReceive: false,
      purchaseInvoiceStatus: 'DRAFT',
      status: 'DRAFT',
    });
    const onDraft = await request(app.getHttpServer())
      .post(
        `/api/v1/import-operations/${draft.op.id}/shipments/00000000-0000-4000-8000-000000000001/receive`,
      )
      .set('Cookie', ctx.purchasingCookie)
      .set('Idempotency-Key', nextKey())
      .send({
        lines: [
          {
            importShipmentLineId: '00000000-0000-4000-8000-000000000002',
            quantity: '1.000',
          },
        ],
      });
    expect(onDraft.status).toBe(409);
    expect(ctx.err(onDraft).code).toBe('IMPORT_OPERATION_NOT_ACTIVE');

    // Embarque PLANNED / IN_TRANSIT: no recibe
    const planned = await scenario({ arrived: false });
    const onPlanned = await receive(planned, [line('1.000', planned)]);
    expect(onPlanned.status).toBe(409);
    expect(ctx.err(onPlanned).code).toBe('SHIPMENT_NOT_ARRIVED');
    ctx.ok(
      await ctx.asP(
        'post',
        `/import-shipments/${planned.shipment.id}/depart`,
        {},
      ),
      200,
      'depart',
    );
    const onTransit = await receive(planned, [line('1.000', planned)]);
    expect(onTransit.status).toBe(409);
    expect(await stock(planned.productId)).toBe('0.000');

    // ARRIVED no mueve stock; COMPLETED (operativo) tampoco
    const s = await scenario();
    expect(await stock(s.productId)).toBe('0.000');
    ctx.ok(await receive(s, [line('10.000', s)]), 201, 'recibir');
    const beforeComplete = await snapshot(s);
    ctx.ok(
      await ctx.asP('post', `/import-operations/${s.op.id}/complete`, {}),
      200,
      'completar',
    );
    const afterComplete = await snapshot(s);
    expect(afterComplete).toMatchObject({
      stock: beforeComplete.stock,
      movements: beforeComplete.movements,
      valuations: beforeComplete.valuations,
      entries: beforeComplete.entries,
      receipts: beforeComplete.receipts,
      opStatus: 'COMPLETED',
    });
    const onCompleted = await receive(s, [line('1.000', s)]);
    expect(onCompleted.status).toBe(409);
    expect(ctx.err(onCompleted).code).toBe('IMPORT_OPERATION_NOT_ACTIVE');
  });

  it('B8. permisos: PURCHASING (único rol) opera; WAREHOUSE/SELLER/MANAGEMENT/ACCOUNTANT no escriben; lectura según rol', async () => {
    const s = await scenario();
    const base = await snapshot(s);
    for (const cookie of [
      ctx.warehouseCookie,
      ctx.sellerCookie,
      ctx.managementCookie,
      ctx.accountantCookie,
    ]) {
      expect((await receive(s, [line('1.000', s)], { cookie })).status).toBe(
        403,
      );
      expect(
        (
          await linkExisting(
            s,
            [
              {
                importShipmentLineId: s.shipmentLineId,
                purchaseReceiptLineId: '00000000-0000-4000-8000-000000000003',
                linkedQuantity: '1.000',
              },
            ],
            { cookie },
          )
        ).status,
      ).toBe(403);
    }
    expect(await snapshot(s)).toEqual(base);

    for (const cookie of [
      ctx.adminCookie,
      ctx.managementCookie,
      ctx.accountantCookie,
      ctx.purchasingCookie,
    ]) {
      expect(
        (
          await ctx.api(
            'get',
            `/import-operations/${s.op.id}/receiving`,
            cookie,
          )
        ).status,
      ).toBe(200);
    }
    for (const cookie of [ctx.warehouseCookie, ctx.sellerCookie]) {
      expect(
        (
          await ctx.api(
            'get',
            `/import-operations/${s.op.id}/receiving`,
            cookie,
          )
        ).status,
      ).toBe(403);
    }
    // ADMIN también puede, con auditoría a su nombre
    const adminRes = await receive(s, [line('1.000', s)], {
      cookie: ctx.adminCookie,
    });
    expect(adminRes.status).toBe(201);
    const admin = await ctx.prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
    });
    const lastAudit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'IMPORT_RECEIVING_RECEIVED', entityId: s.op.id },
    });
    expect(lastAudit.userId).toBe(admin.id);
    expect(lastAudit.userId).not.toBe(ctx.purchasingUserId);
  });

  it('B9. idempotencia persistente: misma clave y contenido devuelve el original; distinto contenido 409; sin clave 400', async () => {
    const s = await scenario();
    const key = nextKey();
    const first = ctx.ok<ReceivingResult>(
      await receive(s, [line('3.000', s)], { key }),
      201,
      'primera',
    );
    const afterFirst = await snapshot(s);
    const replay = ctx.ok<ReceivingResult>(
      await receive(s, [line('3.000', s)], { key }),
      201,
      'reintento',
    );
    expect(replay.requestId).toBe(first.requestId);
    expect(replay.idempotentReplay).toBe(true);
    expect(replay.receipt?.id).toBe(first.receipt?.id);
    expect(replay.links.map((l) => l.id)).toEqual(first.links.map((l) => l.id));
    expect(await snapshot(s)).toEqual(afterFirst);

    const different = await receive(s, [line('4.000', s)], { key });
    expect(different.status).toBe(409);
    expect(ctx.err(different).code).toBe('IDEMPOTENCY_KEY_CONFLICT');
    expect(await snapshot(s)).toEqual(afterFirst);

    const missing = await receive(s, [line('1.000', s)], { key: null });
    expect(missing.status).toBe(400);
    expect(ctx.err(missing).code).toBe('IDEMPOTENCY_KEY_REQUIRED');
    const invalid = await receive(s, [line('1.000', s)], {
      key: 'clave inválida!',
    });
    expect(invalid.status).toBe(400);
    expect(await snapshot(s)).toEqual(afterFirst);
  });

  it('B10. concurrencia: doble clic (misma clave), claves distintas sobre el mismo pendiente, y Compras vs Importaciones', async () => {
    // Doble clic / reintento HTTP simultáneo con la misma clave
    const a = await scenario();
    const key = nextKey();
    const dbl = await Promise.all(
      [1, 2, 3, 4].map(() => receive(a, [line('5.000', a)], { key })),
    );
    expect(dbl.map((r) => r.status)).toEqual([201, 201, 201, 201]);
    expect(
      new Set(dbl.map((r) => (r.body as ReceivingResult).requestId)).size,
    ).toBe(1);
    const snapA = await snapshot(a);
    expect(snapA).toMatchObject({
      stock: '5.000',
      receipts: 1,
      links: 1,
      requests: 1,
    });

    // Claves distintas intentando consumir el MISMO pendiente (6 + 6 > 10)
    const b = await scenario();
    const race = await Promise.all([
      receive(b, [line('6.000', b)]),
      receive(b, [line('6.000', b)]),
    ]);
    expect(race.map((r) => r.status).sort()).toEqual([201, 409]);
    expect(await stock(b.productId)).toBe('6.000');
    const snapB = await snapshot(b);
    expect(snapB).toMatchObject({ receipts: 1, links: 1, requests: 1 });

    // Recepción simultánea desde Compras e Importaciones (7 + 7 > 10)
    const c = await scenario();
    const [viaCompras, viaImport] = await Promise.all([
      ctx.asP('post', `/purchase-invoices/${c.invoice.id}/receipts`, {
        lines: [{ purchaseInvoiceLineId: c.invoiceLineId, quantity: '7.000' }],
      }),
      receive(c, [line('7.000', c)]),
    ]);
    expect([viaCompras.status, viaImport.status].sort()).toEqual([201, 409]);
    expect(await stock(c.productId)).toBe('7.000');
    const received = await ctx.prisma.purchaseReceiptLine.aggregate({
      where: {
        purchaseInvoiceLineId: c.invoiceLineId,
        purchaseReceipt: { status: 'ACTIVE' },
      },
      _sum: { quantity: true },
    });
    expect(received._sum.quantity?.toFixed(3)).toBe('7.000');
  });

  it('B11. recibir y completar es atómico: sin cantidades pendientes completa; con pendientes no registra NADA', async () => {
    // Con pendientes: 409 y nada cambia
    const p = await scenario();
    const baseP = await snapshot(p);
    const partial = await receive(p, [line('4.000', p)], {
      completeOperation: true,
    });
    expect(partial.status).toBe(409);
    expect(ctx.err(partial).code).toBe('IMPORT_PENDING_QUANTITIES');
    expect(await snapshot(p)).toEqual(baseP);

    // Recibe parte sin completar, luego el resto completando
    ctx.ok(await receive(p, [line('4.000', p)]), 201, 'parte');
    const done = ctx.ok<ReceivingResult>(
      await receive(p, [line('6.000', p)], { completeOperation: true }),
      201,
      'resto y completar',
    );
    expect(done.operationCompleted).toBe(true);
    expect(done.operation.status).toBe('COMPLETED');
    expect(await stock(p.productId)).toBe('10.000');
    const completedAudit = await ctx.prisma.auditLog.findFirstOrThrow({
      where: { action: 'IMPORT_OPERATION_COMPLETED', entityId: p.op.id },
    });
    expect(completedAudit.userId).toBe(ctx.purchasingUserId);
    // Reintento idempotente del cierre devuelve el resultado original
    const replayKey = nextKey();
    const q = await scenario();
    const first = ctx.ok<ReceivingResult>(
      await receive(q, [line('10.000', q)], {
        completeOperation: true,
        key: replayKey,
      }),
      201,
      'todo y completar',
    );
    const replay = ctx.ok<ReceivingResult>(
      await receive(q, [line('10.000', q)], {
        completeOperation: true,
        key: replayKey,
      }),
      201,
      'reintento',
    );
    expect(replay.requestId).toBe(first.requestId);
    expect(replay.operationCompleted).toBe(true);
    expect(await stock(q.productId)).toBe('10.000');

    // Otro embarque aún PLANNED (cantidad por llegar) bloquea el cierre y revierte TODO
    const supplierId = await ctx.newSupplier();
    const productId = await ctx.newProduct(false);
    const invoice = await ctx.confirm(
      (
        await ctx.createInvoice(
          supplierId,
          {},
          { quantity: '10.000', productId },
        )
      ).id,
    );
    const op = await ctx.newOperation(invoice.id);
    const first5 = await ctx.createShipment(op.id, [
      { invoiceLineId: invoice.lines[0].id, quantity: '5.000' },
    ]);
    await ctx.createShipment(op.id, [
      { invoiceLineId: invoice.lines[0].id, quantity: '5.000' },
    ]);
    await ctx.arriveShipment(first5.id);
    const sc: Scenario = {
      invoice,
      invoiceLineId: invoice.lines[0].id,
      op,
      shipment: first5,
      shipmentLineId: first5.lines[0].id,
      productId,
    };
    const baseSc = await snapshot(sc);
    const blocked = await receive(sc, [line('5.000', sc)], {
      completeOperation: true,
    });
    expect(blocked.status).toBe(409);
    expect(await snapshot(sc)).toEqual(baseSc);
    // Sin completar sí recibe, y la operación sigue abierta
    ctx.ok(await receive(sc, [line('5.000', sc)]), 201, 'solo recibir');
    expect((await snapshot(sc)).opStatus).toBe('IN_PROGRESS');
  });

  it('B12. fallo en cualquier paso revierte TODO (recepción, stock, valorización, vínculo, solicitud y estado)', async () => {
    const s = await scenario({ valued: true });
    const base = await snapshot(s);
    const operations = app.get(ImportOperationsService);
    const spy = jest
      .spyOn(operations, 'completeInTransaction')
      .mockRejectedValueOnce(new Error('fallo simulado al completar'));
    const res = await receive(s, [line('10.000', s)], {
      completeOperation: true,
    });
    spy.mockRestore();
    expect(res.status).toBe(500);
    expect(JSON.stringify(res.body)).not.toMatch(/fallo simulado/);
    expect(await snapshot(s)).toEqual(base);
    expect(base.stock).toBe('0.000');
    expect(base.opStatus).toBe('IN_PROGRESS');

    // El mismo intento, ya sin fallo, funciona y no duplica nada
    ctx.ok(
      await receive(s, [line('10.000', s)], { completeOperation: true }),
      201,
      'reintento sin fallo',
    );
    const after = await snapshot(s);
    expect(after).toMatchObject({
      stock: '10.000',
      receipts: 1,
      links: 1,
      requests: 1,
      opStatus: 'COMPLETED',
    });
  });

  it('B13. vincular y completar con una recepción de Compras; recepción de otra factura o anulada se rechaza', async () => {
    const s = await scenario();
    const receipt = await comprasReceipt(s, '10.000');
    const other = await scenario();
    const otherReceipt = await comprasReceipt(other, '10.000');

    const foreign = await linkExisting(s, [
      {
        importShipmentLineId: s.shipmentLineId,
        purchaseReceiptLineId: otherReceipt.lines[0].id,
        linkedQuantity: '1.000',
      },
    ]);
    expect([400, 409]).toContain(foreign.status);

    const done = ctx.ok<ReceivingResult>(
      await linkExisting(
        s,
        [
          {
            importShipmentLineId: s.shipmentLineId,
            purchaseReceiptLineId: receipt.lines[0].id,
            linkedQuantity: '10.000',
          },
        ],
        { completeOperation: true },
      ),
      201,
      'vincular y completar',
    );
    expect(done.operationCompleted).toBe(true);
    expect(done.operation.status).toBe('COMPLETED');
    expect(await stock(s.productId)).toBe('10.000');

    // Recepción anulada no se vincula
    const t = await scenario();
    const cancelled = await comprasReceipt(t, '5.000');
    ctx.ok(
      await ctx.asP('post', `/purchase-receipts/${cancelled.id}/cancel`, {
        reason: 'prueba R5',
      }),
      200,
      'anular recepción',
    );
    const onCancelled = await linkExisting(t, [
      {
        importShipmentLineId: t.shipmentLineId,
        purchaseReceiptLineId: cancelled.lines[0].id,
        linkedQuantity: '1.000',
      },
    ]);
    expect(onCancelled.status).toBe(409);
  });

  it('B14. costos multimoneda: recibir desde Importaciones valoriza igual que desde Compras (moneda de la empresa, tasa congelada)', async () => {
    const usd = { currencyCode: 'USD', exchangeRate: '3.70' };
    const viaImport = await scenario({ valued: true, invoiceOver: usd });
    const viaCompras = await scenario({ valued: true, invoiceOver: usd });
    ctx.ok(
      await receive(viaImport, [line('10.000', viaImport)]),
      201,
      'importación',
    );
    await comprasReceipt(viaCompras, '10.000');

    const valuation = async (s: Scenario) =>
      ctx.prisma.inventoryValuation.findFirstOrThrow({
        where: {
          purchaseReceiptLine: { purchaseInvoiceLineId: s.invoiceLineId },
        },
        select: { quantity: true, unitCost: true, totalCost: true },
      });
    const a = await valuation(viaImport);
    const b = await valuation(viaCompras);
    expect(a.quantity.toFixed(3)).toBe(b.quantity.toFixed(3));
    expect(a.totalCost.toFixed(2)).toBe(b.totalCost.toFixed(2));
    expect(a.unitCost.toFixed(6)).toBe(b.unitCost.toFixed(6));
    // 10 × 100.00 USD × 3.70 = 3 700.00 en la moneda de la empresa
    expect(a.totalCost.toFixed(2)).toBe('3700.00');
    expect(
      await ctx.prisma.accountingEntry.count({
        where: { sourceId: viaImport.invoice.id },
      }),
    ).toBe(1);
  });

  it('B15. el resumen distingue facturado, asignado, recibido, vinculado y pendiente; valida entrada por campo', async () => {
    const s = await scenario({ quantity: '10.000', shipped: '8.000' });
    const sum = await summary(s);
    expect(sum.canReceive).toBe(true);
    expect(sum.shipments[0].canReceive).toBe(true);
    expect(sum.shipments[0].lines[0]).toMatchObject({
      isReceivable: true,
      invoicedQuantity: '10.000',
      assignedToShipmentsQuantity: '8.000',
      receivedQuantity: '0.000',
      shipmentLineQuantity: '8.000',
      linkedQuantity: '0.000',
      pendingQuantity: '8.000',
      invoicePendingReceivableQuantity: '10.000',
      maxReceivableNow: '8.000',
    });

    const bad = await request(app.getHttpServer())
      .post(
        `/api/v1/import-operations/${s.op.id}/shipments/${s.shipment.id}/receive`,
      )
      .set('Cookie', ctx.purchasingCookie)
      .set('Idempotency-Key', nextKey())
      .send({ lines: [{ importShipmentLineId: 'x', quantity: '-1' }] });
    expect(bad.status).toBe(400);
    const fields = ctx.err(bad).errors?.map((e) => e.field) ?? [];
    expect(fields).toEqual(
      expect.arrayContaining([
        'lines[0].importShipmentLineId',
        'lines[0].quantity',
      ]),
    );
    const dup = await receive(s, [line('1.000', s), line('1.000', s)]);
    expect(dup.status).toBe(400);
    expect(ctx.err(dup).errors?.[0]).toMatchObject({
      field: 'lines[1].importShipmentLineId',
      type: 'BUSINESS',
    });
    const zero = await receive(s, [line('0.000', s)]);
    expect(zero.status).toBe(400);
    const empty = await receive(s, []);
    expect(empty.status).toBe(400);
    const foreignLine = await receive(s, [
      {
        importShipmentLineId: '00000000-0000-4000-8000-000000000009',
        quantity: '1.000',
      },
    ]);
    expect(foreignLine.status).toBe(400);
    expect(ctx.err(foreignLine).code).toBe('SHIPMENT_LINE_NOT_IN_SHIPMENT');
    expect(await stock(s.productId)).toBe('0.000');
  });
});
