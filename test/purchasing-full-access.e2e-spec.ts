import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  ImportExpenseAllocationMethod,
  ImportExpenseCategory,
  ImportTransportMode,
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
import { AuditAction } from '../src/audit/audit-action.enum';
import { businessToday } from '../src/common/date/business-date';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';
import { purgePurchasingResidue } from './helpers/purchasing-cleanup';
import {
  createProductRow,
  getDefaultLocationId,
} from './helpers/stock-fixtures';

/**
 * R3 — PURCHASING opera Compras e Importaciones completas. HTTP real y
 * PostgreSQL real (descartable, verificado por la guardia E2E).
 *
 * REGLA DE LA SUITE: toda operación del flujo se ejecuta con la cookie de un
 * usuario cuyo ÚNICO rol (y por tanto rol ACTIVO) es PURCHASING. La cookie de
 * ADMIN se usa EXCLUSIVAMENTE para preparar fixtures de catálogo/contabilidad
 * que PURCHASING no administra (mapeos contables, categoría/unidad) y para
 * contrastar permisos de otros roles; nunca para completar el flujo.
 */

interface IdBody {
  id: string;
}
interface InvoiceBody extends IdBody {
  status: string;
  lines: { id: string }[];
}
interface ReceiptBody extends IdBody {
  status: string;
  lines: { id: string }[];
}
interface ShipmentBody extends IdBody {
  status: string;
  lines: { id: string }[];
}
interface SessionBody {
  roles: RoleName[];
  activeRole: RoleName;
}

const PASSWORD = 'R3PurchasingFixture2026Aa';
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('R3 — PURCHASING: Compras e Importaciones completas (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let purchasingCookie: string;
  let purchasingUserId: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;
  let accountantCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let defaultLocationId: string;

  const RUN_ID = Date.now();
  let counter = 0;
  const nextSuffix = (): string => {
    counter += 1;
    return `${RUN_ID}${counter}`;
  };

  type Method = 'get' | 'post' | 'patch' | 'put' | 'delete';
  function api(
    method: Method,
    path: string,
    cookie: string,
    body?: Record<string, unknown>,
  ): Promise<request.Response> {
    const req = request(app.getHttpServer())
      [method](`/api/v1${path}`)
      .set('Cookie', cookie);
    return body === undefined ? req : req.send(body);
  }
  const asPurchasing = (
    method: Method,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<request.Response> => api(method, path, purchasingCookie, body);

  function mustOk<T>(res: request.Response, status: number, label: string): T {
    if (res.status !== status) {
      throw new Error(
        `${label}: esperado ${status}, recibido ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body as T;
  }

  async function createTestAccount(
    code: string,
    type: AccountType,
  ): Promise<string> {
    const res = await api('post', '/chart-of-accounts', adminCookie, {
      code,
      name: `Cuenta e2e R3 ${code}`,
      type,
      isPostable: true,
    });
    return mustOk<IdBody>(res, 201, `cuenta ${code}`).id;
  }

  async function mapKey(
    key: AccountingSystemKey,
    accountId: string,
  ): Promise<void> {
    mustOk(
      await api('patch', `/chart-of-accounts/system-keys/${key}`, adminCookie, {
        accountId,
      }),
      200,
      `mapeo ${key}`,
    );
  }

  /** Alta de proveedor y factura CONFIRMED, todo como PURCHASING. */
  async function newSupplier(): Promise<string> {
    const s = nextSuffix();
    const body = mustOk<IdBody>(
      await asPurchasing('post', '/suppliers', {
        documentType: SupplierDocumentType.RUC,
        documentNumber: s.slice(-11).padStart(11, '0'),
        legalName: `Proveedor e2e R3 ${s}`,
      }),
      201,
      'crear proveedor',
    );
    return body.id;
  }

  function invoiceBody(
    supplierId: string,
    quantity: string,
    unitCost = '10.00',
  ): Record<string, unknown> {
    const s = nextSuffix();
    return {
      supplierId,
      documentType: PurchaseInvoiceDocumentType.FACTURA,
      documentSeries: 'F903',
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
    };
  }

  async function confirmedInvoice(
    supplierId: string,
    quantity: string,
    unitCost = '10.00',
  ): Promise<InvoiceBody> {
    const draft = mustOk<InvoiceBody>(
      await asPurchasing(
        'post',
        '/purchase-invoices',
        invoiceBody(supplierId, quantity, unitCost),
      ),
      201,
      'crear factura',
    );
    return mustOk<InvoiceBody>(
      await asPurchasing('post', `/purchase-invoices/${draft.id}/confirm`, {}),
      200,
      'confirmar factura',
    );
  }

  async function auditActors(
    action: AuditAction,
    entityId: string,
  ): Promise<string[]> {
    const rows = await prisma.auditLog.findMany({
      where: { action, entityId },
    });
    return rows.map((r) => r.userId as string);
  }

  async function expectActor(
    action: AuditAction,
    entityId: string,
  ): Promise<void> {
    const actors = await auditActors(action, entityId);
    expect(actors.length).toBeGreaterThanOrEqual(1);
    for (const a of actors) expect(a).toBe(purchasingUserId);
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

    const s = nextSuffix();
    const mk = async (
      role: RoleName,
      tag: string,
    ): Promise<{ cookie: string; id: string }> => {
      const username = `e2e_r3_${tag}_${s}`.slice(0, 50);
      const user = await upsertFixtureUser(prisma, {
        username,
        email: `${username}@demosystem.test`,
        password: PASSWORD,
        roleName: role,
      });
      const res = await login(app.getHttpServer(), username, PASSWORD);
      if (res.status !== 200) throw new Error(`login ${tag}`);
      return { cookie: res.cookie, id: user.id };
    };
    const purchasing = await mk(RoleName.PURCHASING, 'purch');
    purchasingCookie = purchasing.cookie;
    purchasingUserId = purchasing.id;
    sellerCookie = (await mk(RoleName.SELLER, 'sell')).cookie;
    warehouseCookie = (await mk(RoleName.WAREHOUSE, 'wh')).cookie;
    managementCookie = (await mk(RoleName.MANAGEMENT, 'mgmt')).cookie;
    accountantCookie = (await mk(RoleName.ACCOUNTANT, 'acc')).cookie;

    categoryId = (
      await prisma.category.findFirstOrThrow({ where: { code: 'SERVICIOS' } })
    ).id;
    unitId = (await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } }))
      .id;
    const product = await createProductRow(prisma, {
      data: {
        sku: `R3-${s}`,
        name: `Producto e2e R3 ${s}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('50.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('0.000'),
        status: ProductStatus.ACTIVE,
      },
      select: { id: true },
    });
    productId = product.id;
    defaultLocationId = await getDefaultLocationId(prisma);

    // Mapeos contables sintéticos: administración contable que PURCHASING no
    // tiene; se preparan como fixture con ADMIN.
    const short = Date.now() % 1000000;
    await mapKey(
      AccountingSystemKey.ACCOUNTS_PAYABLE,
      await createTestAccount(`R3AP${short}`, AccountType.LIABILITY),
    );
    await mapKey(
      AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
      await createTestAccount(`R3RES${short}`, AccountType.ASSET),
    );
  }, 120000);

  afterAll(async () => {
    try {
      // Retira el residuo propio (facturas, pagos, importaciones, asientos, cuentas y
      // proveedores) para no romper otras suites que comparten la base.
      await purgePurchasingResidue(prisma, {
        supplierLegalNamePrefix: 'Proveedor e2e R3',
        accountCodePrefixes: ['R3AP', 'R3RES'],
      });
      await prisma.account.updateMany({
        where: {
          systemKey: {
            in: [
              AccountingSystemKey.ACCOUNTS_PAYABLE,
              AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
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
  // 6. Rol activo
  // ==================================================================
  it('R0. el usuario del flujo tiene PURCHASING como único rol y como rol activo', async () => {
    const me = await api('get', '/auth/me', purchasingCookie);
    expect(me.status).toBe(200);
    expect((me.body as { role: RoleName }).role).toBe(RoleName.PURCHASING);
    const roles = await prisma.userRole.findMany({
      where: { userId: purchasingUserId },
      include: { role: true },
    });
    expect(roles.map((r) => r.role.name)).toEqual([RoleName.PURCHASING]);
    const session = await login(
      app.getHttpServer(),
      (await prisma.user.findUniqueOrThrow({ where: { id: purchasingUserId } }))
        .username,
      PASSWORD,
    );
    expect((session.body as unknown as SessionBody).activeRole).toBe(
      RoleName.PURCHASING,
    );
  });

  // ==================================================================
  // 9.A Flujo completo de Compras
  // ==================================================================
  describe('flujo de Compras con PURCHASING', () => {
    it('P1. proveedor, factura, recepción (con ubicación), cuenta por pagar, pago y anulaciones — sin 403', async () => {
      // Proveedor
      const supplierId = await newSupplier();
      expect(
        (await asPurchasing('get', `/suppliers/${supplierId}`)).status,
      ).toBe(200);
      expect(
        (
          await asPurchasing('patch', `/suppliers/${supplierId}`, {
            tradeName: 'Comercial R3',
          })
        ).status,
      ).toBe(200);
      await expectActor(AuditAction.SUPPLIER_CREATED, supplierId);
      await expectActor(AuditAction.SUPPLIER_UPDATED, supplierId);

      // Factura: crear, editar DRAFT, confirmar
      const draft = mustOk<InvoiceBody>(
        await asPurchasing(
          'post',
          '/purchase-invoices',
          invoiceBody(supplierId, '10.000'),
        ),
        201,
        'crear factura',
      );
      mustOk(
        await asPurchasing('patch', `/purchase-invoices/${draft.id}`, {
          paymentTermsDays: 15,
        }),
        200,
        'editar DRAFT',
      );
      expect((await asPurchasing('get', '/purchase-invoices')).status).toBe(
        200,
      );
      const invoice = mustOk<InvoiceBody>(
        await asPurchasing(
          'post',
          `/purchase-invoices/${draft.id}/confirm`,
          {},
        ),
        200,
        'confirmar',
      );
      expect(invoice.status).toBe('CONFIRMED');
      await expectActor(AuditAction.PURCHASE_INVOICE_CREATED, draft.id);
      await expectActor(AuditAction.PURCHASE_INVOICE_UPDATED, draft.id);
      await expectActor(AuditAction.PURCHASE_INVOICE_CONFIRMED, draft.id);

      // Consultas auxiliares: vistas de recepción, almacenes y ubicaciones
      const pending = await asPurchasing('get', '/purchase-receiving/invoices');
      expect(pending.status).toBe(200);
      expect(
        (await asPurchasing('get', `/purchase-receiving/invoices/${draft.id}`))
          .status,
      ).toBe(200);
      const warehouses = await asPurchasing('get', '/warehouses');
      expect(warehouses.status).toBe(200);
      const wh = (warehouses.body as { data?: IdBody[] } | IdBody[]) ?? [];
      const warehouseList = Array.isArray(wh) ? wh : (wh.data ?? []);
      expect(warehouseList.length).toBeGreaterThan(0);
      const locations = await asPurchasing(
        'get',
        `/warehouses/${warehouseList[0].id}/locations`,
      );
      expect(locations.status).toBe(200);

      // Recepción física con ubicación explícita
      const receipt = mustOk<ReceiptBody>(
        await asPurchasing('post', `/purchase-invoices/${draft.id}/receipts`, {
          lines: [
            {
              purchaseInvoiceLineId: invoice.lines[0].id,
              quantity: '6.000',
              locationId: defaultLocationId,
            },
          ],
          idempotencyKey: `r3-rec-${nextSuffix()}`,
        }),
        201,
        'recepción',
      );
      await expectActor(AuditAction.PURCHASE_RECEIPT_CREATED, receipt.id);
      expect(
        (await asPurchasing('get', `/purchase-receipts/${receipt.id}`)).status,
      ).toBe(200);
      expect(
        (await asPurchasing('get', `/purchase-invoices/${draft.id}/receipts`))
          .status,
      ).toBe(200);

      // Cuentas por pagar: detalle, listados, resúmenes y exportaciones
      const detail = await asPurchasing('get', `/accounts-payable/${draft.id}`);
      expect(detail.status).toBe(200);
      for (const path of [
        '/accounts-payable',
        '/accounts-payable/summary',
        '/accounts-payable/aging',
        '/accounts-payable/reconciliation',
        '/accounts-payable/export.xlsx',
        '/accounts-payable/summary/export.xlsx',
        '/accounts-payable/aging/export.xlsx',
        '/accounts-payable/reconciliation/export.xlsx',
      ]) {
        expect((await asPurchasing('get', path)).status).toBe(200);
      }

      // Pago a proveedor (método activo conocido por GET /payment-methods)
      const methods = await asPurchasing('get', '/payment-methods');
      expect(methods.status).toBe(200);
      expect(
        (methods.body as { code: string }[]).some((m) => m.code === 'CASH'),
      ).toBe(true);
      const payment = mustOk<IdBody & { status: string }>(
        await asPurchasing('post', '/supplier-payments', {
          supplierId,
          amount: '40.00',
          method: 'CASH',
          idempotencyKey: `r3-pay-${nextSuffix()}`,
          allocations: [{ purchaseInvoiceId: draft.id, amount: '40.00' }],
        }),
        201,
        'pago',
      );
      await expectActor(AuditAction.SUPPLIER_PAYMENT_REGISTERED, payment.id);
      expect(
        (await asPurchasing('get', `/supplier-payments/${payment.id}`)).status,
      ).toBe(200);
      expect((await asPurchasing('get', '/supplier-payments')).status).toBe(
        200,
      );

      // Anulaciones según estado: pago -> recepción -> factura
      mustOk(
        await asPurchasing('post', `/supplier-payments/${payment.id}/cancel`, {
          reason: 'Anulación e2e R3',
        }),
        200,
        'anular pago',
      );
      await expectActor(AuditAction.SUPPLIER_PAYMENT_CANCELLED, payment.id);
      mustOk(
        await asPurchasing('post', `/purchase-receipts/${receipt.id}/cancel`, {
          reason: 'Anulación e2e R3',
        }),
        200,
        'anular recepción',
      );
      await expectActor(AuditAction.PURCHASE_RECEIPT_CANCELLED, receipt.id);
      mustOk(
        await asPurchasing('post', `/purchase-invoices/${draft.id}/cancel`, {
          reason: 'Anulación e2e R3',
        }),
        200,
        'anular factura',
      );
      await expectActor(AuditAction.PURCHASE_INVOICE_CANCELLED, draft.id);
    });
  });

  // ==================================================================
  // 9.A Flujo completo de Importaciones
  // ==================================================================
  describe('flujo de Importaciones con PURCHASING', () => {
    it('I1. operación, embarque, gastos, distribución, vínculo con recepción, finalización, reportes y anulaciones — sin 403', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirmedInvoice(supplierId, '20.000');
      const invoiceLineId = invoice.lines[0].id;

      // Operación
      const op = mustOk<IdBody & { status: string }>(
        await asPurchasing('post', '/import-operations', {
          // R4: la operación se vincula a la factura de compra (referencia generada por el servidor).
          purchaseInvoiceId: invoice.id,
          originCountry: 'CN',
          destinationCountry: 'PE',
        }),
        201,
        'crear operación',
      );
      await expectActor(AuditAction.IMPORT_OPERATION_CREATED, op.id);
      mustOk(
        await asPurchasing('patch', `/import-operations/${op.id}`, {
          description: 'Operación editada por PURCHASING',
        }),
        200,
        'editar operación',
      );
      expect((await asPurchasing('get', '/import-operations')).status).toBe(
        200,
      );
      expect(
        (await asPurchasing('get', `/import-operations/${op.id}`)).status,
      ).toBe(200);

      // Embarque: crear, editar, depart, arrive
      const shipment = mustOk<ShipmentBody>(
        await asPurchasing('post', `/import-operations/${op.id}/shipments`, {
          transportMode: ImportTransportMode.SEA,
          lines: [
            {
              descriptionSnapshot: 'Carga e2e R3',
              plannedQuantity: '20.000',
              purchaseInvoiceLineId: invoiceLineId,
            },
          ],
        }),
        201,
        'crear embarque',
      );
      await expectActor(AuditAction.IMPORT_SHIPMENT_CREATED, shipment.id);
      mustOk(
        await asPurchasing('patch', `/import-shipments/${shipment.id}`, {
          notes: 'editado por PURCHASING',
        }),
        200,
        'editar embarque',
      );
      mustOk(
        await asPurchasing(
          'post',
          `/import-shipments/${shipment.id}/depart`,
          {},
        ),
        200,
        'depart',
      );
      mustOk(
        await asPurchasing(
          'post',
          `/import-shipments/${shipment.id}/arrive`,
          {},
        ),
        200,
        'arrive',
      );
      await expectActor(AuditAction.IMPORT_SHIPMENT_DEPARTED, shipment.id);
      await expectActor(AuditAction.IMPORT_SHIPMENT_ARRIVED, shipment.id);
      expect(
        (await asPurchasing('get', `/import-shipments/${shipment.id}`)).status,
      ).toBe(200);
      expect(
        (await asPurchasing('get', `/import-operations/${op.id}/shipments`))
          .status,
      ).toBe(200);
      const arrived = (
        await asPurchasing('get', `/import-shipments/${shipment.id}`)
      ).body as ShipmentBody;
      const shipmentLineId = arrived.lines[0].id;

      // Gastos: crear, editar, previsualizar, distribuir, finalizar
      const currency = (
        await prisma.companySettings.findFirstOrThrow({
          select: { currencyCode: true },
        })
      ).currencyCode;
      const expense = mustOk<IdBody>(
        await asPurchasing('post', `/import-operations/${op.id}/expenses`, {
          category: ImportExpenseCategory.FREIGHT,
          expenseDate: businessToday(),
          currencyCode: currency,
          amount: '200.00',
        }),
        201,
        'crear gasto',
      );
      await expectActor(AuditAction.IMPORT_EXPENSE_CREATED, expense.id);
      mustOk(
        await asPurchasing('patch', `/import-expenses/${expense.id}`, {
          description: 'Flete editado por PURCHASING',
        }),
        200,
        'editar gasto',
      );
      expect(
        (await asPurchasing('get', `/import-expenses/${expense.id}`)).status,
      ).toBe(200);
      expect(
        (await asPurchasing('get', `/import-operations/${op.id}/expenses`))
          .status,
      ).toBe(200);
      const allocation = {
        method: ImportExpenseAllocationMethod.MANUAL,
        amountToAllocate: '200.00',
        manualAllocations: [
          { importShipmentLineId: shipmentLineId, amount: '200.00' },
        ],
      };
      mustOk(
        await asPurchasing(
          'post',
          `/import-expenses/${expense.id}/allocate/preview`,
          allocation,
        ),
        200,
        'previsualizar distribución',
      );
      const allocated = mustOk<{ allocations: IdBody[] }>(
        await asPurchasing(
          'post',
          `/import-expenses/${expense.id}/allocate`,
          allocation,
        ),
        201,
        'distribuir gasto',
      );
      // La auditoría de distribución se ancla al lote (ImportExpenseAllocationBatch).
      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.IMPORT_EXPENSE_ALLOCATED,
            userId: purchasingUserId,
          },
        }),
      ).toBeGreaterThanOrEqual(1);
      expect(
        await prisma.auditLog.count({
          where: {
            action: AuditAction.IMPORT_EXPENSE_ALLOCATED,
            userId: { not: purchasingUserId },
            createdAt: { gte: new Date(RUN_ID) },
          },
        }),
      ).toBe(0);
      expect(
        (
          await asPurchasing(
            'get',
            `/import-expenses/${expense.id}/allocations`,
          )
        ).status,
      ).toBe(200);
      mustOk(
        await asPurchasing(
          'post',
          `/import-expenses/${expense.id}/finalize`,
          {},
        ),
        200,
        'finalizar gasto',
      );
      await expectActor(AuditAction.IMPORT_EXPENSE_FINALIZED, expense.id);

      // Recepción real y vínculo importación-recepción
      const receipt = mustOk<ReceiptBody>(
        await asPurchasing(
          'post',
          `/purchase-invoices/${invoice.id}/receipts`,
          {
            lines: [
              { purchaseInvoiceLineId: invoiceLineId, quantity: '20.000' },
            ],
          },
        ),
        201,
        'recepción',
      );
      const link = mustOk<IdBody>(
        await asPurchasing(
          'post',
          `/import-shipment-lines/${shipmentLineId}/receipt-links`,
          {
            purchaseReceiptLineId: receipt.lines[0].id,
            linkedQuantity: '20.000',
          },
        ),
        201,
        'vincular',
      );
      await expectActor(AuditAction.IMPORT_RECEIPT_LINK_CREATED, link.id);
      expect(
        (
          await asPurchasing(
            'get',
            `/import-shipment-lines/${shipmentLineId}/receipt-links`,
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await asPurchasing(
            'get',
            `/import-expense-allocations/${allocated.allocations[0].id}/cost-attribution-preview`,
          )
        ).status,
      ).toBe(200);

      // Reportes y exportaciones de importaciones
      for (const path of [
        '/import-reports/operations',
        '/import-reports/operations/export.xlsx',
        '/import-reports/shipments',
        '/import-reports/shipments/export.xlsx',
        '/import-reports/expenses',
        '/import-reports/expenses/export.xlsx',
        '/import-reports/reconciliation',
        '/import-reports/reconciliation/export.xlsx',
      ]) {
        expect((await asPurchasing('get', path)).status).toBe(200);
      }

      // Regla de negocio intacta: no se puede anular la recepción con vínculo ACTIVO
      expect(
        (
          await asPurchasing(
            'post',
            `/purchase-receipts/${receipt.id}/cancel`,
            {
              reason: 'x',
            },
          )
        ).status,
      ).toBe(409);
      // Desvincular, y luego finalizar la operación
      mustOk(
        await asPurchasing('post', `/import-receipt-links/${link.id}/cancel`, {
          reason: 'Desvinculación e2e R3',
        }),
        200,
        'desvincular',
      );
      await expectActor(AuditAction.IMPORT_RECEIPT_LINK_CANCELLED, link.id);
      mustOk(
        await asPurchasing('post', `/import-operations/${op.id}/complete`, {}),
        200,
        'completar operación',
      );
      await expectActor(AuditAction.IMPORT_OPERATION_COMPLETED, op.id);
    });

    it('I2. anulaciones según estado: operación, embarque y gasto (200) y estados terminales siguen rechazando (409)', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirmedInvoice(supplierId, '2.000');
      const op = mustOk<IdBody>(
        await asPurchasing('post', '/import-operations', {
          purchaseInvoiceId: invoice.id,
          originCountry: 'CN',
          destinationCountry: 'PE',
        }),
        201,
        'crear operación',
      );
      const shipment = mustOk<ShipmentBody>(
        await asPurchasing('post', `/import-operations/${op.id}/shipments`, {
          transportMode: ImportTransportMode.AIR,
          lines: [
            {
              descriptionSnapshot: 'Carga',
              plannedQuantity: '1.000',
              purchaseInvoiceLineId: invoice.lines[0].id,
            },
          ],
        }),
        201,
        'crear embarque',
      );
      const currency = (
        await prisma.companySettings.findFirstOrThrow({
          select: { currencyCode: true },
        })
      ).currencyCode;
      const expense = mustOk<IdBody>(
        await asPurchasing('post', `/import-operations/${op.id}/expenses`, {
          category: ImportExpenseCategory.OTHER,
          expenseDate: businessToday(),
          currencyCode: currency,
          amount: '10.00',
        }),
        201,
        'crear gasto',
      );
      mustOk(
        await asPurchasing('post', `/import-expenses/${expense.id}/cancel`, {
          reason: 'Gasto anulado e2e R3',
        }),
        200,
        'anular gasto',
      );
      await expectActor(AuditAction.IMPORT_EXPENSE_CANCELLED, expense.id);
      expect(
        (
          await asPurchasing('post', `/import-expenses/${expense.id}/cancel`, {
            reason: 'otra vez',
          })
        ).status,
      ).toBe(409);
      mustOk(
        await asPurchasing('post', `/import-shipments/${shipment.id}/cancel`, {
          reason: 'Embarque anulado e2e R3',
        }),
        200,
        'anular embarque',
      );
      await expectActor(AuditAction.IMPORT_SHIPMENT_CANCELLED, shipment.id);
      mustOk(
        await asPurchasing('post', `/import-operations/${op.id}/cancel`, {
          reason: 'Operación anulada e2e R3',
        }),
        200,
        'anular operación',
      );
      await expectActor(AuditAction.IMPORT_OPERATION_CANCELLED, op.id);
      // Una operación ANULADA ya no se edita ni se completa
      expect(
        (
          await asPurchasing('patch', `/import-operations/${op.id}`, {
            description: 'x',
          })
        ).status,
      ).toBe(409);
      expect(
        (await asPurchasing('post', `/import-operations/${op.id}/complete`, {}))
          .status,
      ).toBe(409);
    });
  });

  // ==================================================================
  // 9.B Las validaciones de negocio se mantienen para PURCHASING
  // ==================================================================
  describe('validaciones de negocio intactas', () => {
    it('V1. estados de factura: reconfirmar 409, editar CONFIRMED 409, anular dos veces 409', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirmedInvoice(supplierId, '5.000');
      expect(
        (
          await asPurchasing(
            'post',
            `/purchase-invoices/${invoice.id}/confirm`,
            {},
          )
        ).status,
      ).toBe(409);
      expect(
        (
          await asPurchasing('patch', `/purchase-invoices/${invoice.id}`, {
            paymentTermsDays: 30,
          })
        ).status,
      ).toBe(409);
      expect(
        (
          await asPurchasing(
            'post',
            `/purchase-invoices/${invoice.id}/cancel`,
            {
              reason: 'ok',
            },
          )
        ).status,
      ).toBe(200);
      expect(
        (
          await asPurchasing(
            'post',
            `/purchase-invoices/${invoice.id}/cancel`,
            {
              reason: 'otra',
            },
          )
        ).status,
      ).toBe(409);
    });

    it('V2. recepción: no excede lo facturado (409), idempotencia devuelve la misma y sin efectos extra', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirmedInvoice(supplierId, '5.000');
      const lineId = invoice.lines[0].id;
      const over = await asPurchasing(
        'post',
        `/purchase-invoices/${invoice.id}/receipts`,
        { lines: [{ purchaseInvoiceLineId: lineId, quantity: '6.000' }] },
      );
      expect(over.status).toBe(409);
      expect(
        await prisma.purchaseReceipt.count({
          where: { purchaseInvoiceId: invoice.id },
        }),
      ).toBe(0);

      const key = `r3-idem-${nextSuffix()}`;
      const body = {
        idempotencyKey: key,
        lines: [{ purchaseInvoiceLineId: lineId, quantity: '2.000' }],
      };
      const first = mustOk<ReceiptBody>(
        await asPurchasing(
          'post',
          `/purchase-invoices/${invoice.id}/receipts`,
          body,
        ),
        201,
        'recepción 1',
      );
      const second = await asPurchasing(
        'post',
        `/purchase-invoices/${invoice.id}/receipts`,
        body,
      );
      expect([200, 201]).toContain(second.status);
      expect((second.body as ReceiptBody).id).toBe(first.id);
      expect(
        await prisma.purchaseReceipt.count({
          where: { purchaseInvoiceId: invoice.id },
        }),
      ).toBe(1);
      // ubicación inexistente: 404, sin efectos
      expect(
        (
          await asPurchasing(
            'post',
            `/purchase-invoices/${invoice.id}/receipts`,
            {
              lines: [
                {
                  purchaseInvoiceLineId: lineId,
                  quantity: '1.000',
                  locationId: NON_EXISTENT_UUID,
                },
              ],
            },
          )
        ).status,
      ).toBe(404);
    });

    it('V3. pagos: no superan el saldo (409), idempotencia, y un pago anulado no se anula dos veces', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirmedInvoice(supplierId, '10.000');
      const over = await asPurchasing('post', '/supplier-payments', {
        supplierId,
        amount: '100.01',
        method: 'CASH',
        allocations: [{ purchaseInvoiceId: invoice.id, amount: '100.01' }],
      });
      expect(over.status).toBe(409);
      const key = `r3-pay-${nextSuffix()}`;
      const body = {
        supplierId,
        amount: '30.00',
        method: 'CASH',
        idempotencyKey: key,
        allocations: [{ purchaseInvoiceId: invoice.id, amount: '30.00' }],
      };
      const first = mustOk<IdBody>(
        await asPurchasing('post', '/supplier-payments', body),
        201,
        'pago',
      );
      const again = await asPurchasing('post', '/supplier-payments', body);
      expect([200, 201]).toContain(again.status);
      expect((again.body as IdBody).id).toBe(first.id);
      expect(
        await prisma.supplierPayment.count({ where: { supplierId } }),
      ).toBe(1);
      mustOk(
        await asPurchasing('post', `/supplier-payments/${first.id}/cancel`, {
          reason: 'x',
        }),
        200,
        'anular pago',
      );
      expect(
        (
          await asPurchasing('post', `/supplier-payments/${first.id}/cancel`, {
            reason: 'y',
          })
        ).status,
      ).toBe(409);
      // método inexistente: 404 (la regla dinámica de métodos sigue vigente)
      const bad = await asPurchasing('post', '/supplier-payments', {
        supplierId,
        amount: '1.00',
        method: 'NO_EXISTE',
        allocations: [{ purchaseInvoiceId: invoice.id, amount: '1.00' }],
      });
      expect([404, 409]).toContain(bad.status);
    });

    it('V4. importaciones: embarque no arribado no admite vínculo (409); cantidades inválidas se rechazan', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirmedInvoice(supplierId, '4.000');
      const op = mustOk<IdBody>(
        await asPurchasing('post', '/import-operations', {
          purchaseInvoiceId: invoice.id,
          originCountry: 'CN',
          destinationCountry: 'PE',
        }),
        201,
        'operación',
      );
      const shipment = mustOk<ShipmentBody>(
        await asPurchasing('post', `/import-operations/${op.id}/shipments`, {
          transportMode: ImportTransportMode.SEA,
          lines: [
            {
              descriptionSnapshot: 'Carga',
              plannedQuantity: '4.000',
              purchaseInvoiceLineId: invoice.lines[0].id,
            },
          ],
        }),
        201,
        'embarque',
      );
      const receipt = mustOk<ReceiptBody>(
        await asPurchasing(
          'post',
          `/purchase-invoices/${invoice.id}/receipts`,
          {
            lines: [
              { purchaseInvoiceLineId: invoice.lines[0].id, quantity: '4.000' },
            ],
          },
        ),
        201,
        'recepción',
      );
      const blocked = await asPurchasing(
        'post',
        `/import-shipment-lines/${shipment.lines[0].id}/receipt-links`,
        { purchaseReceiptLineId: receipt.lines[0].id, linkedQuantity: '4.000' },
      );
      expect(blocked.status).toBe(409);
      expect(
        await prisma.importReceiptLink.count({
          where: { importShipmentLineId: shipment.lines[0].id },
        }),
      ).toBe(0);
      expect(
        (
          await asPurchasing('post', '/import-operations', {
            reference: '',
            originCountry: 'CN',
            destinationCountry: 'PE',
          })
        ).status,
      ).toBe(400);
    });
  });

  // ==================================================================
  // 9.B/C Restricciones: lo que PURCHASING NO puede hacer sigue en 403
  // ==================================================================
  describe('operaciones prohibidas para PURCHASING (403)', () => {
    it('X1. usuarios, roles, configuración, credenciales y administración', async () => {
      for (const [method, path] of [
        ['get', '/users'],
        ['post', '/users'],
        ['get', '/roles'],
        ['patch', `/users/${purchasingUserId}`],
        ['get', '/configuration'],
        ['patch', '/configuration'],
        ['get', '/audit'],
        ['get', '/payment-methods?includeInactive=true'],
        ['post', '/payment-methods'],
        ['patch', `/payment-methods/${NON_EXISTENT_UUID}`],
        ['post', '/warehouses'],
        ['post', `/warehouses/${NON_EXISTENT_UUID}/locations`],
      ] as const) {
        const res = await asPurchasing(method, path, {});
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
    });

    it('X2. inventario manual, transferencias y stock; contabilidad, ventas y clientes', async () => {
      for (const [method, path] of [
        ['post', '/inventory/entries'],
        ['post', '/inventory/exits'],
        ['post', '/inventory/adjustments/in'],
        ['post', '/inventory/initial-balances'],
        ['post', '/inventory/transfers'],
        ['get', '/inventory/transfers'],
        ['get', '/inventory/movements'],
        ['get', `/inventory/products/${productId}/stock`],
        ['get', '/accounting/entries'],
        ['post', '/accounting/manual-entries'],
        ['get', '/sales'],
        ['get', '/customers'],
        ['get', '/payments'],
      ] as const) {
        const res = await asPurchasing(method, path, {});
        expect([method, path, res.status]).toEqual([method, path, 403]);
      }
    });

    it('X3. proveedores: no activa ni desactiva (solo ADMIN)', async () => {
      const supplierId = await newSupplier();
      for (const action of ['activate', 'deactivate']) {
        expect(
          (await asPurchasing('post', `/suppliers/${supplierId}/${action}`, {}))
            .status,
        ).toBe(403);
      }
      const row = await prisma.supplier.findUniqueOrThrow({
        where: { id: supplierId },
      });
      expect(row.status).toBe('ACTIVE');
    });

    it('X4. sin sesión: 401 en las rutas ampliadas', async () => {
      for (const [method, path] of [
        ['get', '/import-operations'],
        ['post', '/import-operations'],
        ['get', '/supplier-payments'],
        ['post', `/purchase-invoices/${NON_EXISTENT_UUID}/confirm`],
        ['get', '/warehouses'],
      ] as const) {
        const res = await request(app.getHttpServer())
          [method](`/api/v1${path}`)
          .send({});
        expect([method, path, res.status]).toEqual([method, path, 401]);
      }
    });
  });

  // ==================================================================
  // 9.B Otros roles no adquieren permisos adicionales
  // ==================================================================
  describe('matriz de los demás roles sin cambios', () => {
    it('M1. SELLER y WAREHOUSE: sin acceso a importaciones ni pagos a proveedores; WAREHOUSE no confirma/anula facturas ni anula recepciones', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        for (const path of [
          '/import-operations',
          '/import-reports/operations',
          '/supplier-payments',
          '/accounts-payable',
        ]) {
          expect((await api('get', path, cookie)).status).toBe(403);
        }
        expect(
          (await api('post', '/import-operations', cookie, {})).status,
        ).toBe(403);
        expect(
          (await api('post', '/supplier-payments', cookie, {})).status,
        ).toBe(403);
      }
      expect(
        (
          await api(
            'post',
            `/purchase-invoices/${NON_EXISTENT_UUID}/confirm`,
            warehouseCookie,
            {},
          )
        ).status,
      ).toBe(403);
      expect(
        (
          await api(
            'post',
            `/purchase-receipts/${NON_EXISTENT_UUID}/cancel`,
            warehouseCookie,
            { reason: 'x' },
          )
        ).status,
      ).toBe(403);
    });

    it('M2. MANAGEMENT y ACCOUNTANT: leen importaciones y pagos (200) pero no escriben (403)', async () => {
      for (const cookie of [managementCookie, accountantCookie]) {
        for (const path of [
          '/import-operations',
          '/import-reports/operations',
          '/supplier-payments',
        ]) {
          expect((await api('get', path, cookie)).status).toBe(200);
        }
        expect(
          (await api('post', '/import-operations', cookie, {})).status,
        ).toBe(403);
        expect(
          (await api('post', '/supplier-payments', cookie, {})).status,
        ).toBe(403);
        expect(
          (
            await api(
              'post',
              `/purchase-receipts/${NON_EXISTENT_UUID}/cancel`,
              cookie,
              { reason: 'x' },
            )
          ).status,
        ).toBe(403);
      }
    });
  });
});
