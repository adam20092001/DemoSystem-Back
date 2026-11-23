import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSourceType,
  AccountingSystemKey,
  ImportOperationStatus,
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
  formatImportOperationReference,
  nextImportOperationNumber,
} from '../src/import-operations/import-operation-reference';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createLegacyImportOperation } from './helpers/import-fixtures';
import { createTestPrismaClient } from './helpers/prisma-test-client';
import { purgePurchasingResidue } from './helpers/purchasing-cleanup';
import { createProductRow } from './helpers/stock-fixtures';

/**
 * R4 — cinco requerimientos integrados. HTTP real y PostgreSQL real
 * (descartable, validado por la guardia E2E).
 *
 * REGLA: todo el flujo de Compras/Importaciones/Países se ejecuta con la
 * cookie de un usuario cuyo ÚNICO rol (y rol activo) es PURCHASING. ADMIN solo
 * prepara fixtures que PURCHASING no administra (mapeos contables, IGV,
 * moneda de empresa) y contrasta permisos de otros roles.
 */

type Method = 'get' | 'post' | 'patch';
interface IdBody {
  id: string;
}
interface ErrBody {
  statusCode: number;
  message: string | string[];
  kind: 'FORM' | 'GENERAL';
  code?: string;
  errors?: { field: string; code: string; type: string; message: string }[];
}
interface InvoiceBody extends IdBody {
  status: string;
  currencyCode: string;
  baseCurrencyCode: string;
  exchangeRate: string;
  exchangeRateDate: string;
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  baseSubtotal: string;
  baseTaxAmount: string;
  baseTotalAmount: string;
  postedEntryId: string | null;
  lines: {
    id: string;
    unitCost: string;
    baseUnitCost: string;
    taxableBaseAmount: string;
    baseTaxableBaseAmount: string;
    baseTaxAmount: string;
    baseLineTotal: string;
  }[];
}
interface PaymentBody extends IdBody {
  status: string;
  amount: string;
  currencyCode: string;
  baseCurrencyCode: string;
  exchangeRate: string;
  baseAmount: string;
  fxDifferenceAmount: string;
  allocations: {
    purchaseInvoiceId: string;
    amount: string;
    carryingBaseAmount: string;
    settledBaseAmount: string;
    fxDifferenceAmount: string;
  }[];
}
interface OperationBody extends IdBody {
  reference: string;
  status: string;
  purchaseInvoiceId: string | null;
  isLegacyUnlinked: boolean;
  purchaseInvoice: {
    status: string;
    canAssignLines: boolean;
    supplier: { id: string; legalName: string };
  } | null;
  invoiceLines:
    | {
        purchaseInvoiceLineId: string;
        invoicedQuantity: string;
        assignedQuantity: string;
        availableQuantity: string;
        receivedQuantity: string;
        pendingReceiptQuantity: string;
      }[]
    | null;
}
interface ShipmentBody extends IdBody {
  status: string;
  transportMode: string;
  incoterm: string | null;
  incotermNamedPlace: string | null;
  incotermVersion: string | null;
  lines: { id: string }[];
}

const PASSWORD = 'R4Purchasing2026Fixture';
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('R4 — Incoterm, multimoneda, importación↔compra, países y errores (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let purchasingCookie: string;
  let purchasingUserId: string;
  let sellerCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let categoryId: string;
  let unitId: string;
  let productId: string;
  let valuedProductId: string;
  let originalTax: { taxEnabled: boolean; taxRate: Prisma.Decimal } | null =
    null;
  const acc: Record<
    'ap' | 'resale' | 'vat' | 'fxGain' | 'fxLoss' | 'cash',
    string
  > = { ap: '', resale: '', vat: '', fxGain: '', fxLoss: '', cash: '' };

  const RUN_ID = Date.now();
  let counter = 0;
  const nextSuffix = (): string => {
    counter += 1;
    return `${RUN_ID}${counter}`;
  };

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
  const asP = (
    method: Method,
    path: string,
    body?: Record<string, unknown>,
  ): Promise<request.Response> => api(method, path, purchasingCookie, body);

  function ok<T>(res: request.Response, status: number, label: string): T {
    if (res.status !== status) {
      throw new Error(
        `${label}: esperado ${status}, recibido ${res.status} ${JSON.stringify(res.body)}`,
      );
    }
    return res.body as T;
  }
  const err = (res: request.Response): ErrBody => res.body as ErrBody;

  async function createAccount(
    code: string,
    type: AccountType,
  ): Promise<string> {
    const res = await api('post', '/chart-of-accounts', adminCookie, {
      code,
      name: `Cuenta e2e R4 ${code}`,
      type,
      isPostable: true,
    });
    return ok<IdBody>(res, 201, `cuenta ${code}`).id;
  }
  async function mapKey(
    key: AccountingSystemKey,
    accountId: string,
  ): Promise<void> {
    ok(
      await api('patch', `/chart-of-accounts/system-keys/${key}`, adminCookie, {
        accountId,
      }),
      200,
      `mapeo ${key}`,
    );
  }

  async function newSupplier(): Promise<string> {
    const s = nextSuffix();
    return ok<IdBody>(
      await asP('post', '/suppliers', {
        documentType: SupplierDocumentType.RUC,
        documentNumber: s.slice(-11).padStart(11, '0'),
        legalName: `Proveedor e2e R4 ${s}`,
      }),
      201,
      'proveedor',
    ).id;
  }

  function invoiceBody(
    supplierId: string,
    over: Record<string, unknown> = {},
    line: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const s = nextSuffix();
    return {
      supplierId,
      documentType: PurchaseInvoiceDocumentType.FACTURA,
      documentSeries: 'F904',
      documentNumber: s.slice(-8),
      issueDate: businessToday(),
      lines: [
        {
          productId,
          acquisitionKind: 'GOOD',
          purchasePurpose: 'RESALE_INVENTORY',
          quantity: '10.000',
          unitCost: '100.00',
          taxCategory: 'UNAFFECTED',
          ...line,
        },
      ],
      ...over,
    };
  }

  async function createInvoice(
    supplierId: string,
    over: Record<string, unknown> = {},
    line: Record<string, unknown> = {},
  ): Promise<InvoiceBody> {
    return ok<InvoiceBody>(
      await asP(
        'post',
        '/purchase-invoices',
        invoiceBody(supplierId, over, line),
      ),
      201,
      'crear factura',
    );
  }
  async function confirm(id: string): Promise<InvoiceBody> {
    return ok<InvoiceBody>(
      await asP('post', `/purchase-invoices/${id}/confirm`, {}),
      200,
      'confirmar',
    );
  }
  async function usdInvoice(
    supplierId: string,
    rate = '3.70',
    quantity = '10.000',
    unitCost = '100.00',
  ): Promise<InvoiceBody> {
    const draft = await createInvoice(
      supplierId,
      { currencyCode: 'USD', exchangeRate: rate },
      { quantity, unitCost },
    );
    return confirm(draft.id);
  }

  async function lines(sourceType: AccountingSourceType, sourceId: string) {
    const entries = await prisma.accountingEntry.findMany({
      where: { sourceType, sourceId },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });
    return entries.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      lines: e.lines.map((l) => ({
        accountId: l.accountId,
        debit: l.debitAmount.toFixed(2),
        credit: l.creditAmount.toFixed(2),
      })),
    }));
  }
  const find = (
    entry: { lines: { accountId: string; debit: string; credit: string }[] },
    accountId: string,
  ) => entry.lines.filter((l) => l.accountId === accountId);
  function assertBalanced(entry: {
    lines: { debit: string; credit: string }[];
  }): void {
    const debit = entry.lines.reduce(
      (s, l) => s.plus(l.debit),
      new Prisma.Decimal(0),
    );
    const credit = entry.lines.reduce(
      (s, l) => s.plus(l.credit),
      new Prisma.Decimal(0),
    );
    expect(debit.toFixed(2)).toBe(credit.toFixed(2));
  }

  async function pay(
    supplierId: string,
    allocations: { purchaseInvoiceId: string; amount: string }[],
    over: Record<string, unknown> = {},
  ): Promise<request.Response> {
    const amount = allocations
      .reduce((s, a) => s.plus(a.amount), new Prisma.Decimal(0))
      .toFixed(2);
    return asP('post', '/supplier-payments', {
      supplierId,
      amount,
      method: 'CASH',
      allocations,
      ...over,
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
    if (adminLogin.status !== 200) throw new Error('login admin');
    adminCookie = adminLogin.cookie;

    const s = nextSuffix();
    const mk = async (
      role: RoleName,
      tag: string,
    ): Promise<{ cookie: string; id: string }> => {
      const username = `e2e_r4_${tag}_${s}`.slice(0, 50);
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
    const p = await mk(RoleName.PURCHASING, 'purch');
    purchasingCookie = p.cookie;
    purchasingUserId = p.id;
    sellerCookie = (await mk(RoleName.SELLER, 'sell')).cookie;
    managementCookie = (await mk(RoleName.MANAGEMENT, 'mgmt')).cookie;
    accountantCookie = (await mk(RoleName.ACCOUNTANT, 'acc')).cookie;

    categoryId = (
      await prisma.category.findFirstOrThrow({ where: { code: 'SERVICIOS' } })
    ).id;
    unitId = (await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } }))
      .id;
    const mkProduct = async (valued: boolean): Promise<string> => {
      const row = await createProductRow(prisma, {
        data: {
          sku: `R4-${valued ? 'V' : 'N'}-${nextSuffix()}`,
          name: `Producto e2e R4 ${nextSuffix()}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId,
          salePrice: new Prisma.Decimal('900.00'),
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
    };
    productId = await mkProduct(false);
    valuedProductId = await mkProduct(true);

    // IGV activado como fixture (la seed lo deja apagado); se restaura en afterAll.
    const settings = await prisma.companySettings.findFirstOrThrow();
    originalTax = {
      taxEnabled: settings.taxEnabled,
      taxRate: settings.taxRate,
    };
    await prisma.companySettings.updateMany({
      data: { taxEnabled: true, taxRate: new Prisma.Decimal('18.00') },
    });

    const short = Date.now() % 1000000;
    acc.ap = await createAccount(`R4AP${short}`, AccountType.LIABILITY);
    acc.resale = await createAccount(`R4RES${short}`, AccountType.ASSET);
    acc.vat = await createAccount(`R4VAT${short}`, AccountType.ASSET);
    await mapKey(AccountingSystemKey.ACCOUNTS_PAYABLE, acc.ap);
    await mapKey(AccountingSystemKey.PURCHASE_RESALE_INVENTORY, acc.resale);
    await mapKey(AccountingSystemKey.VAT_RECEIVABLE, acc.vat);
    // FX_GAIN_REALIZED / FX_LOSS_REALIZED quedan SIN mapear a propósito (se
    // verifica el 409 controlado y luego se mapean en la prueba correspondiente).
    acc.fxGain = await createAccount(`R4FXG${short}`, AccountType.REVENUE);
    acc.fxLoss = await createAccount(`R4FXL${short}`, AccountType.EXPENSE);
    acc.cash = (
      await prisma.account.findFirstOrThrow({
        where: { systemKey: AccountingSystemKey.CASH },
      })
    ).id;
  }, 180000);

  afterAll(async () => {
    try {
      await purgePurchasingResidue(prisma, {
        supplierLegalNamePrefix: 'Proveedor e2e R4',
        accountCodePrefixes: ['R4AP', 'R4RES', 'R4VAT', 'R4FXG', 'R4FXL'],
        importOperationReferencePrefixes: ['LEG-', 'INC-', 'BAD-'],
      });
      if (originalTax !== null) {
        await prisma.companySettings.updateMany({ data: originalTax });
      }
      await prisma.account.updateMany({
        where: {
          systemKey: {
            in: [
              AccountingSystemKey.ACCOUNTS_PAYABLE,
              AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
              AccountingSystemKey.VAT_RECEIVABLE,
              AccountingSystemKey.FX_GAIN_REALIZED,
              AccountingSystemKey.FX_LOSS_REALIZED,
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

  // ====================================================================
  // 5. Errores de validación por campo
  // ====================================================================
  describe('contrato de errores (req. 5)', () => {
    it('E1. campos obligatorios faltantes y líneas anidadas: 400, kind FORM, errors[] con rutas exactas', async () => {
      const res = await asP('post', '/purchase-invoices', {
        documentType: 'FACTURA',
        lines: [{ acquisitionKind: 'GOOD' }, 'no-es-objeto'],
      });
      expect(res.status).toBe(400);
      const e = err(res);
      expect(e.kind).toBe('FORM');
      expect(e.code).toBe('VALIDATION_ERROR');
      expect(Array.isArray(e.message)).toBe(true); // compatibilidad: message sigue siendo arreglo
      const byField = new Map(e.errors!.map((x) => [x.field, x]));
      expect(byField.get('supplierId')).toMatchObject({
        type: 'REQUIRED',
        code: 'REQUIRED',
      });
      expect(byField.get('documentNumber')?.type).toBe('REQUIRED');
      expect(byField.get('lines[0].quantity')?.type).toBe('REQUIRED');
      expect(byField.get('lines[0].unitCost')?.type).toBe('REQUIRED');
      expect(byField.get('lines[0].taxCategory')?.type).toBe('REQUIRED');
    });

    it('E2. formato inválido y propiedad no declarada', async () => {
      const res = await asP('post', '/purchase-invoices', {
        ...invoiceBody(NON_EXISTENT_UUID),
        issueDate: 'ayer',
        paymentTermsDays: 'x',
        intruso: 1,
      });
      expect(res.status).toBe(400);
      const e = err(res);
      const fields = e.errors!.map((x) => `${x.field}:${x.type}`);
      expect(fields).toEqual(
        expect.arrayContaining([
          'issueDate:FORMAT',
          'paymentTermsDays:FORMAT',
          'intruso:FORMAT',
        ]),
      );
      expect(e.errors!.find((x) => x.field === 'intruso')?.code).toBe(
        'UNKNOWN_FIELD',
      );
    });

    it('E3. regla de negocio atribuida a un campo (BUSINESS) y conflicto general (GENERAL), con sus códigos HTTP', async () => {
      const supplierId = await newSupplier();
      const noRate = await asP(
        'post',
        '/purchase-invoices',
        invoiceBody(supplierId, { currencyCode: 'USD' }),
      );
      expect(noRate.status).toBe(400);
      expect(err(noRate)).toMatchObject({
        kind: 'FORM',
        code: 'EXCHANGE_RATE_REQUIRED',
        errors: [{ field: 'exchangeRate', type: 'REQUIRED' }],
      });

      const inv = await createInvoice(supplierId);
      await confirm(inv.id);
      const again = await asP(
        'post',
        `/purchase-invoices/${inv.id}/confirm`,
        {},
      );
      expect(again.status).toBe(409);
      expect(err(again).kind).toBe('GENERAL');
      expect(err(again).errors).toBeUndefined();
      expect(typeof err(again).message).toBe('string');
    });

    it('E4. 404/403/401 conservan su semántica y no exponen detalles internos', async () => {
      const nf = await asP('get', `/purchase-invoices/${NON_EXISTENT_UUID}`);
      expect(nf.status).toBe(404);
      expect(err(nf).kind).toBe('GENERAL');
      const forbidden = await api('get', '/users', purchasingCookie);
      expect(forbidden.status).toBe(403);
      const unauth = await request(app.getHttpServer()).get('/api/v1/users');
      expect(unauth.status).toBe(401);
      expect(JSON.stringify(nf.body)).not.toMatch(/prisma|select|stack/i);
    });

    it('E5. muestras de otros módulos usan el mismo contrato (países, importaciones, pagos, ventas)', async () => {
      const c = await asP('post', '/countries', { code: 'x' });
      expect(c.status).toBe(400);
      expect(err(c).errors!.map((x) => x.field)).toEqual(
        expect.arrayContaining(['code', 'name']),
      );
      const op = await asP('post', '/import-operations', {});
      expect(op.status).toBe(400);
      expect(err(op).errors!.map((x) => x.field)).toEqual(
        expect.arrayContaining(['purchaseInvoiceId']),
      );
      const pm = await asP('post', '/supplier-payments', { allocations: [{}] });
      expect(pm.status).toBe(400);
      expect(err(pm).errors!.map((x) => x.field)).toEqual(
        expect.arrayContaining(['allocations[0].purchaseInvoiceId']),
      );
      const sale = await api('post', '/sales', adminCookie, { items: [{}] });
      expect(sale.status).toBe(400);
      expect(err(sale).errors!.map((x) => x.field)).toEqual(
        expect.arrayContaining(['items[0].productId']),
      );
    });
  });

  // ====================================================================
  // 4. Catálogo de países
  // ====================================================================
  describe('catálogo de países (req. 4)', () => {
    it('C1. CN, PE e IN existen desde la migración, sin duplicados', async () => {
      const rows = await prisma.country.findMany({
        where: { code: { in: ['CN', 'PE', 'IN'] } },
        orderBy: { code: 'asc' },
      });
      expect(rows.map((r) => [r.code, r.name, r.pendingReview])).toEqual([
        ['CN', 'China', false],
        ['IN', 'India', false],
        ['PE', 'Perú', false],
      ]);
    });

    it('C2. PURCHASING registra un país y otra sesión (otro rol) lo ve inmediatamente', async () => {
      const code = `Z${String.fromCharCode(65 + (RUN_ID % 26))}`;
      const created = ok<{ code: string; active: boolean }>(
        await asP('post', '/countries', {
          code: code.toLowerCase(),
          name: `País e2e ${RUN_ID}`,
        }),
        201,
        'crear país',
      );
      expect(created).toMatchObject({ code, active: true });
      for (const cookie of [
        adminCookie,
        sellerCookie,
        managementCookie,
        accountantCookie,
      ]) {
        const res = await api('get', `/countries/${code}`, cookie);
        expect(res.status).toBe(200);
        const list = await api('get', '/countries', cookie);
        expect(
          (list.body as { code: string }[]).some((c) => c.code === code),
        ).toBe(true);
      }
      expect(
        await prisma.auditLog.count({
          where: { action: 'COUNTRY_CREATED', userId: purchasingUserId },
        }),
      ).toBeGreaterThan(0);

      // Duplicados (código y nombre) y formato
      expect(
        (await asP('post', '/countries', { code, name: 'Otro nombre' })).status,
      ).toBe(409);
      expect(
        (
          await asP('post', '/countries', {
            code: 'QQ',
            name: `país E2E ${RUN_ID}`,
          })
        ).status,
      ).toBe(409);
      expect(
        (await asP('post', '/countries', { code: 'ABC', name: 'Mal' })).status,
      ).toBe(400);

      // PURCHASING no edita ni desactiva; ADMIN sí
      expect(
        (await asP('patch', `/countries/${code}`, { name: 'Nuevo' })).status,
      ).toBe(403);
      expect(
        (await asP('post', `/countries/${code}/deactivate`, {})).status,
      ).toBe(403);
      expect(
        (
          await api('patch', `/countries/${code}`, adminCookie, {
            name: `Editado ${RUN_ID}`,
          })
        ).status,
      ).toBe(200);
      // Otros roles no crean
      for (const cookie of [sellerCookie, managementCookie, accountantCookie]) {
        expect(
          (await api('post', '/countries', cookie, { code: 'QX', name: 'No' }))
            .status,
        ).toBe(403);
      }
    });

    it('C3. concurrencia: dos altas simultáneas del mismo código: una sola gana', async () => {
      const code = `Y${String.fromCharCode(65 + ((RUN_ID >> 3) % 26))}`;
      const results = await Promise.all([
        asP('post', '/countries', { code, name: `Concurrente A ${RUN_ID}` }),
        asP('post', '/countries', { code, name: `Concurrente B ${RUN_ID}` }),
      ]);
      expect(results.map((r) => r.status).sort()).toEqual([201, 409]);
      expect(await prisma.country.count({ where: { code } })).toBe(1);
    });

    it('C4. desactivar impide documentos NUEVOS pero conserva los históricos; nunca se elimina un país usado', async () => {
      const code = `W${String.fromCharCode(65 + ((RUN_ID >> 5) % 26))}`;
      ok(
        await asP('post', '/countries', {
          code,
          name: `Desactivable ${RUN_ID}`,
        }),
        201,
        'país',
      );
      const supplierId = ok<IdBody>(
        await asP('post', '/suppliers', {
          documentType: SupplierDocumentType.RUC,
          documentNumber: nextSuffix().slice(-11).padStart(11, '0'),
          legalName: 'Proveedor país e2e',
          countryCode: code,
        }),
        201,
        'proveedor con país',
      ).id;
      ok(
        await api('post', `/countries/${code}/deactivate`, adminCookie, {}),
        200,
        'desactivar',
      );
      expect(
        (await api('post', `/countries/${code}/deactivate`, adminCookie, {}))
          .status,
      ).toBe(409);

      // por defecto no aparece; includeInactive sí
      const active = await asP('get', '/countries');
      expect(
        (active.body as { code: string }[]).some((c) => c.code === code),
      ).toBe(false);
      const all = await asP('get', '/countries?includeInactive=true');
      expect(
        (all.body as { code: string }[]).some((c) => c.code === code),
      ).toBe(true);

      // documento nuevo con país inactivo: 409 (campo countryCode)
      const blocked = await asP('post', '/suppliers', {
        documentType: SupplierDocumentType.RUC,
        documentNumber: nextSuffix().slice(-11).padStart(11, '0'),
        legalName: 'Otro proveedor',
        countryCode: code,
      });
      expect(blocked.status).toBe(409);
      expect(err(blocked).errors![0]).toMatchObject({
        field: 'countryCode',
        code: 'COUNTRY_INACTIVE',
      });
      // el proveedor histórico sigue editable y conserva su país
      ok(
        await asP('patch', `/suppliers/${supplierId}`, {
          tradeName: 'Histórico',
        }),
        200,
        'editar histórico',
      );
      expect(
        (await prisma.supplier.findUniqueOrThrow({ where: { id: supplierId } }))
          .countryCode,
      ).toBe(code);

      // país inexistente: 400; FK Restrict: no se elimina un país usado
      const missing = await asP('post', '/suppliers', {
        documentType: SupplierDocumentType.RUC,
        documentNumber: nextSuffix().slice(-11).padStart(11, '0'),
        legalName: 'Sin país',
        countryCode: 'QZ',
      });
      expect(missing.status).toBe(400);
      await expect(
        prisma.country.delete({ where: { code } }),
      ).rejects.toThrow();
      ok(
        await api('post', `/countries/${code}/activate`, adminCookie, {}),
        200,
        'reactivar',
      );
    });
  });

  // ====================================================================
  // 1 + 3. Importación vinculada a compra e Incoterm
  // ====================================================================
  describe('importación vinculada a compra (req. 3) e incoterm (req. 1)', () => {
    async function newOperation(invoiceId: string): Promise<OperationBody> {
      return ok<OperationBody>(
        await asP('post', '/import-operations', {
          purchaseInvoiceId: invoiceId,
          originCountry: 'CN',
          destinationCountry: 'PE',
        }),
        201,
        'crear operación',
      );
    }
    async function ship(
      operationId: string,
      body: Record<string, unknown>,
    ): Promise<request.Response> {
      return asP('post', `/import-operations/${operationId}/shipments`, body);
    }

    it('I1. exige factura; referencia generada por el servidor IMP-AAAA-NNNNNN; proveedor heredado', async () => {
      const noInvoice = await asP('post', '/import-operations', {
        originCountry: 'CN',
        destinationCountry: 'PE',
      });
      expect(noInvoice.status).toBe(400);
      expect(err(noInvoice).errors![0]).toMatchObject({
        field: 'purchaseInvoiceId',
        type: 'REQUIRED',
      });

      const withRef = await asP('post', '/import-operations', {
        reference: 'IMP-MIO',
        purchaseInvoiceId: NON_EXISTENT_UUID,
        originCountry: 'CN',
        destinationCountry: 'PE',
      });
      expect(withRef.status).toBe(400);
      expect(
        err(withRef).errors!.some(
          (e) => e.field === 'reference' && e.code === 'UNKNOWN_FIELD',
        ),
      ).toBe(true);

      const missing = await asP('post', '/import-operations', {
        purchaseInvoiceId: NON_EXISTENT_UUID,
        originCountry: 'CN',
        destinationCountry: 'PE',
      });
      expect(missing.status).toBe(400);
      expect(err(missing).errors![0].field).toBe('purchaseInvoiceId');

      const supplierId = await newSupplier();
      const invoice = await createInvoice(supplierId); // DRAFT
      const op = await newOperation(invoice.id);
      const year = Number(businessToday().slice(0, 4));
      expect(op.reference).toMatch(new RegExp(`^IMP-${year}-\\d{6}$`));
      expect(op).toMatchObject({
        purchaseInvoiceId: invoice.id,
        isLegacyUnlinked: false,
        status: 'DRAFT',
      });
      expect(op.purchaseInvoice).toMatchObject({
        status: 'DRAFT',
        canAssignLines: false,
      });
      expect(op.purchaseInvoice!.supplier.id).toBe(supplierId);
      const detail = ok<OperationBody>(
        await asP('get', `/import-operations/${op.id}`),
        200,
        'detalle',
      );
      expect(detail.invoiceLines).toHaveLength(1);
      expect(detail.invoiceLines![0]).toMatchObject({
        invoicedQuantity: '10.000',
        assignedQuantity: '0.000',
        availableQuantity: '10.000',
        receivedQuantity: '0.000',
        pendingReceiptQuantity: '10.000',
      });
      const list = ok<{ data: OperationBody[] }>(
        await asP('get', `/import-operations?purchaseInvoiceId=${invoice.id}`),
        200,
        'listado',
      );
      expect(list.data.map((o) => o.id)).toEqual([op.id]);
      expect(list.data[0].invoiceLines).toBeNull();
      await expectActorAudit('IMPORT_OPERATION_CREATED', op.id);
    });

    async function expectActorAudit(
      action: string,
      entityId: string,
    ): Promise<void> {
      const rows = await prisma.auditLog.findMany({
        where: { action, entityId },
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) expect(r.userId).toBe(purchasingUserId);
    }

    it('I2. con la factura en DRAFT no se asignan líneas; confirmar nunca es automático; luego sí', async () => {
      const supplierId = await newSupplier();
      const invoice = await createInvoice(supplierId);
      const op = await newOperation(invoice.id);
      const draftLineId = invoice.lines[0].id;

      const blocked = await ship(op.id, {
        transportMode: 'SEA',
        lines: [
          {
            descriptionSnapshot: 'Carga',
            plannedQuantity: '4.000',
            purchaseInvoiceLineId: draftLineId,
          },
        ],
      });
      expect(blocked.status).toBe(409);
      expect(err(blocked)).toMatchObject({
        code: 'PURCHASE_INVOICE_NOT_CONFIRMED',
      });
      expect(
        (
          await prisma.purchaseInvoice.findUniqueOrThrow({
            where: { id: invoice.id },
          })
        ).status,
      ).toBe('DRAFT');
      expect(
        await prisma.importShipment.count({
          where: { importOperationId: op.id },
        }),
      ).toBe(0);

      // la factura DRAFT sigue editable estando vinculada
      ok(
        await asP('patch', `/purchase-invoices/${invoice.id}`, {
          paymentTermsDays: 30,
        }),
        200,
        'editar borrador',
      );
      const confirmed = await confirm(invoice.id);
      const lineId = confirmed.lines[0].id;

      const created = ok<ShipmentBody>(
        await ship(op.id, {
          transportMode: 'SEA',
          lines: [
            {
              descriptionSnapshot: 'Carga',
              plannedQuantity: '4.000',
              purchaseInvoiceLineId: lineId,
            },
          ],
        }),
        201,
        'embarque',
      );
      const detail = ok<OperationBody>(
        await asP('get', `/import-operations/${op.id}`),
        200,
        'detalle',
      );
      expect(detail.purchaseInvoice).toMatchObject({
        status: 'CONFIRMED',
        canAssignLines: true,
      });
      expect(detail.invoiceLines![0]).toMatchObject({
        assignedQuantity: '4.000',
        assignedToThisOperationQuantity: '4.000',
        availableQuantity: '6.000',
      });
      expect(created.status).toBe('PLANNED');
    });

    it('I3. solo líneas y productos de la compra; sobreasignación entre operaciones y concurrente', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirm((await createInvoice(supplierId)).id);
      const other = await confirm((await createInvoice(supplierId)).id);
      const op = await newOperation(invoice.id);
      const op2 = await newOperation(invoice.id);

      // sin línea de factura: 400 REQUIRED en la ruta de la línea
      const noLine = await ship(op.id, {
        transportMode: 'SEA',
        lines: [{ descriptionSnapshot: 'X', plannedQuantity: '1.000' }],
      });
      expect(noLine.status).toBe(400);
      expect(err(noLine).errors![0]).toMatchObject({
        field: 'lines[0].purchaseInvoiceLineId',
        type: 'REQUIRED',
      });
      // línea de OTRA factura
      const foreign = await ship(op.id, {
        transportMode: 'SEA',
        lines: [
          {
            descriptionSnapshot: 'X',
            plannedQuantity: '1.000',
            purchaseInvoiceLineId: other.lines[0].id,
          },
        ],
      });
      expect(foreign.status).toBe(400);
      expect(err(foreign).errors![0]).toMatchObject({
        code: 'LINE_NOT_IN_OPERATION_INVOICE',
        field: 'lines[0].purchaseInvoiceLineId',
      });
      // producto distinto del de la línea
      const wrongProduct = await ship(op.id, {
        transportMode: 'SEA',
        lines: [
          {
            productId: valuedProductId,
            plannedQuantity: '1.000',
            purchaseInvoiceLineId: invoice.lines[0].id,
          },
        ],
      });
      expect(wrongProduct.status).toBe(400);
      // cantidad no positiva
      expect(
        (
          await ship(op.id, {
            transportMode: 'SEA',
            lines: [
              {
                descriptionSnapshot: 'X',
                plannedQuantity: '0',
                purchaseInvoiceLineId: invoice.lines[0].id,
              },
            ],
          })
        ).status,
      ).toBe(400);

      // 6 + 5 > 10 entre DOS operaciones distintas de la misma factura
      ok(
        await ship(op.id, {
          transportMode: 'SEA',
          lines: [
            {
              descriptionSnapshot: 'A',
              plannedQuantity: '6.000',
              purchaseInvoiceLineId: invoice.lines[0].id,
            },
          ],
        }),
        201,
        'embarque A',
      );
      const over = await ship(op2.id, {
        transportMode: 'SEA',
        lines: [
          {
            descriptionSnapshot: 'B',
            plannedQuantity: '5.000',
            purchaseInvoiceLineId: invoice.lines[0].id,
          },
        ],
      });
      expect(over.status).toBe(409);

      // concurrencia: quedan 4; dos solicitudes de 3 -> exactamente una
      const [a, b] = await Promise.all([
        ship(op2.id, {
          transportMode: 'SEA',
          lines: [
            {
              descriptionSnapshot: 'C1',
              plannedQuantity: '3.000',
              purchaseInvoiceLineId: invoice.lines[0].id,
            },
          ],
        }),
        ship(op2.id, {
          transportMode: 'SEA',
          lines: [
            {
              descriptionSnapshot: 'C2',
              plannedQuantity: '3.000',
              purchaseInvoiceLineId: invoice.lines[0].id,
            },
          ],
        }),
      ]);
      expect([a.status, b.status].sort()).toEqual([201, 409]);
      const assigned = await prisma.importShipmentLine.aggregate({
        where: {
          purchaseInvoiceLineId: invoice.lines[0].id,
          importShipment: { status: { not: 'CANCELLED' } },
        },
        _sum: { plannedQuantity: true },
      });
      expect(assigned._sum.plannedQuantity!.toFixed(3)).toBe('9.000');
    });

    it('I4. correlativo: único y sin huecos bajo concurrencia; reinicia al cambiar de año', async () => {
      const supplierId = await newSupplier();
      const invoice = await createInvoice(supplierId);
      const results = await Promise.all(
        Array.from({ length: 8 }, () =>
          asP('post', '/import-operations', {
            purchaseInvoiceId: invoice.id,
            originCountry: 'CN',
            destinationCountry: 'PE',
          }),
        ),
      );
      expect(results.every((r) => r.status === 201)).toBe(true);
      const refs = results
        .map((r) => (r.body as OperationBody).reference)
        .sort();
      expect(new Set(refs).size).toBe(8);
      const numbers = refs.map((r) => Number(r.slice(-6)));
      expect(Math.max(...numbers) - Math.min(...numbers)).toBe(7); // consecutivos, sin huecos

      // reinicio anual: un año nuevo empieza en 1 y no afecta al año vigente
      const year = 2090 + (RUN_ID % 9);
      const first = await prisma.$transaction((tx) =>
        nextImportOperationNumber(tx, year),
      );
      const second = await prisma.$transaction((tx) =>
        nextImportOperationNumber(tx, year),
      );
      expect([first, second]).toEqual([1, 2]);
      expect(formatImportOperationReference(year, first)).toBe(
        `IMP-${year}-000001`,
      );
      // un rollback devuelve el número (sin huecos)
      await expect(
        prisma.$transaction(async (tx) => {
          await nextImportOperationNumber(tx, year);
          throw new Error('rollback');
        }),
      ).rejects.toThrow('rollback');
      expect(
        await prisma.$transaction((tx) => nextImportOperationNumber(tx, year)),
      ).toBe(3);
      // índice único de referencia en base de datos
      await expect(
        prisma.importOperation.create({
          data: {
            reference: refs[0].toLowerCase(),
            originCountry: 'CN',
            destinationCountry: 'PE',
            purchaseInvoiceId: invoice.id,
            createdByUserId: purchasingUserId,
          },
        }),
      ).rejects.toThrow();
    });

    it('I5. anular la factura: bloqueada con importación activa; permitida tras anularla (orden de locks sin interbloqueo)', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirm((await createInvoice(supplierId)).id);
      const op = await newOperation(invoice.id);
      ok(
        await ship(op.id, {
          transportMode: 'LAND',
          lines: [
            {
              descriptionSnapshot: 'A',
              plannedQuantity: '2.000',
              purchaseInvoiceLineId: invoice.lines[0].id,
            },
          ],
        }),
        201,
        'embarque',
      );

      const blocked = await asP(
        'post',
        `/purchase-invoices/${invoice.id}/cancel`,
        { reason: 'x' },
      );
      expect(blocked.status).toBe(409);
      expect(err(blocked).code).toBe('PURCHASE_INVOICE_HAS_ACTIVE_IMPORT');
      expect(
        (
          await prisma.purchaseInvoice.findUniqueOrThrow({
            where: { id: invoice.id },
          })
        ).status,
      ).toBe('CONFIRMED');

      ok(
        await asP('post', `/import-operations/${op.id}/cancel`, {
          reason: 'Anulada e2e R4',
        }),
        200,
        'anular operación',
      );
      // un embarque ya anulado tampoco bloquea
      ok(
        await asP('post', `/purchase-invoices/${invoice.id}/cancel`, {
          reason: 'Ahora sí',
        }),
        200,
        'anular factura',
      );
      // factura anulada: no admite operaciones nuevas
      const onCancelled = await asP('post', '/import-operations', {
        purchaseInvoiceId: invoice.id,
        originCountry: 'CN',
        destinationCountry: 'PE',
      });
      expect(onCancelled.status).toBe(409);
    });

    it('I6. carreras anular-factura vs crear-embarque: nunca queda una factura anulada con embarque activo', async () => {
      for (let round = 0; round < 4; round += 1) {
        const supplierId = await newSupplier();
        const invoice = await confirm((await createInvoice(supplierId)).id);
        const op = await newOperation(invoice.id);
        const [cancel, shipment] = await Promise.all([
          asP('post', `/purchase-invoices/${invoice.id}/cancel`, {
            reason: 'carrera',
          }),
          ship(op.id, {
            transportMode: 'SEA',
            lines: [
              {
                descriptionSnapshot: 'A',
                plannedQuantity: '1.000',
                purchaseInvoiceLineId: invoice.lines[0].id,
              },
            ],
          }),
        ]);
        expect([cancel.status, shipment.status].some((s) => s >= 500)).toBe(
          false,
        );
        const inv = await prisma.purchaseInvoice.findUniqueOrThrow({
          where: { id: invoice.id },
        });
        const active = await prisma.importShipmentLine.count({
          where: {
            purchaseInvoiceLineId: invoice.lines[0].id,
            importShipment: { status: { not: 'CANCELLED' } },
          },
        });
        // Invariante: factura anulada => ningún embarque activo; embarque activo => factura confirmada.
        if (inv.status === 'CANCELLED') expect(active).toBe(0);
        if (active > 0) expect(inv.status).toBe('CONFIRMED');
        // y exactamente una de las dos operaciones prosperó (la otra respondió 409)
        expect(
          [cancel.status, shipment.status].filter(
            (s) => s === 409 || s === 200 || s === 201,
          ).length,
        ).toBe(2);
      }
    });

    it('I7. completar la importación no confirma compras, no recibe, no mueve stock y no genera asientos ni valorización', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirm(
        (await createInvoice(supplierId, {}, { productId: valuedProductId }))
          .id,
      );
      const op = await newOperation(invoice.id);
      const shipment = ok<ShipmentBody>(
        await ship(op.id, {
          transportMode: 'SEA',
          incoterm: 'FOB',
          incotermNamedPlace: 'Shanghai',
          lines: [
            {
              descriptionSnapshot: 'A',
              plannedQuantity: '10.000',
              purchaseInvoiceLineId: invoice.lines[0].id,
            },
          ],
        }),
        201,
        'embarque',
      );
      const before = {
        entries: await prisma.accountingEntry.count(),
        valuations: await prisma.inventoryValuation.count(),
        movements: await prisma.inventoryMovement.count({
          where: { productId: valuedProductId },
        }),
        receipts: await prisma.purchaseReceipt.count({
          where: { purchaseInvoiceId: invoice.id },
        }),
        stock: (
          await prisma.product.findUniqueOrThrow({
            where: { id: valuedProductId },
          })
        ).stockCurrent.toFixed(3),
      };
      ok(
        await asP('post', `/import-shipments/${shipment.id}/depart`, {}),
        200,
        'depart',
      );
      ok(
        await asP('post', `/import-shipments/${shipment.id}/arrive`, {}),
        200,
        'arrive',
      );
      const completed = ok<OperationBody>(
        await asP('post', `/import-operations/${op.id}/complete`, {}),
        200,
        'completar',
      );
      expect(completed.status).toBe(ImportOperationStatus.COMPLETED);
      const after = {
        entries: await prisma.accountingEntry.count(),
        valuations: await prisma.inventoryValuation.count(),
        movements: await prisma.inventoryMovement.count({
          where: { productId: valuedProductId },
        }),
        receipts: await prisma.purchaseReceipt.count({
          where: { purchaseInvoiceId: invoice.id },
        }),
        stock: (
          await prisma.product.findUniqueOrThrow({
            where: { id: valuedProductId },
          })
        ).stockCurrent.toFixed(3),
      };
      expect(after).toEqual(before);
      expect(
        (
          await prisma.purchaseInvoice.findUniqueOrThrow({
            where: { id: invoice.id },
          })
        ).status,
      ).toBe('CONFIRMED');
      // una operación COMPLETADA mantiene su factura: tampoco se anula esa factura
      expect(
        (
          await asP('post', `/purchase-invoices/${invoice.id}/cancel`, {
            reason: 'x',
          })
        ).status,
      ).toBe(409);
    });

    it('I8. operaciones históricas: siguen accesibles y operables, sin factura principal; reporte de candidatas (solo lectura)', async () => {
      const supplierId = await newSupplier();
      const invoiceA = await confirm((await createInvoice(supplierId)).id);
      const invoiceB = await confirm((await createInvoice(supplierId)).id);
      const legacy = await createLegacyImportOperation(prisma, {
        reference: `LEG-${nextSuffix()}`,
      });
      // modelo anterior: embarque con líneas de DOS facturas, vínculo opcional
      ok(
        await ship(legacy.id, {
          transportMode: 'SEA',
          lines: [
            {
              descriptionSnapshot: 'A',
              plannedQuantity: '2.000',
              purchaseInvoiceLineId: invoiceA.lines[0].id,
            },
            {
              descriptionSnapshot: 'B',
              plannedQuantity: '2.000',
              purchaseInvoiceLineId: invoiceB.lines[0].id,
            },
            { descriptionSnapshot: 'Libre', plannedQuantity: '1.000' },
          ],
        }),
        201,
        'embarque histórico',
      );
      const detail = ok<OperationBody>(
        await asP('get', `/import-operations/${legacy.id}`),
        200,
        'detalle histórico',
      );
      expect(detail).toMatchObject({
        isLegacyUnlinked: true,
        purchaseInvoiceId: null,
        purchaseInvoice: null,
        invoiceLines: null,
      });

      const report = ok<{
        data: {
          id: string;
          candidateKind: string;
          candidateInvoices: unknown[];
        }[];
      }>(
        await asP('get', '/import-reports/legacy-operations?limit=100'),
        200,
        'reporte histórico',
      );
      const row = report.data.find((r) => r.id === legacy.id);
      expect(row).toMatchObject({ candidateKind: 'MULTIPLE_INVOICES' });
      expect(row!.candidateInvoices).toHaveLength(2);
      // el reporte nunca modifica nada
      expect(
        (
          await prisma.importOperation.findUniqueOrThrow({
            where: { id: legacy.id },
          })
        ).purchaseInvoiceId,
      ).toBeNull();

      // anular una factura referenciada por embarques activos de una operación histórica: 409
      const blocked = await asP(
        'post',
        `/purchase-invoices/${invoiceA.id}/cancel`,
        { reason: 'x' },
      );
      expect(blocked.status).toBe(409);
      expect(err(blocked).code).toBe(
        'PURCHASE_INVOICE_HAS_ACTIVE_SHIPMENT_LINES',
      );
      // CHECK de base: una operación sin factura debe ser histórica
      await expect(
        prisma.importOperation.create({
          data: {
            reference: `BAD-${nextSuffix()}`,
            originCountry: 'CN',
            destinationCountry: 'PE',
            createdByUserId: purchasingUserId,
          },
        }),
      ).rejects.toThrow();
      // reporte de resumen incluye factura/proveedor
      const summary = ok<{
        data: {
          id: string;
          purchaseInvoiceId: string | null;
          supplierLegalName: string | null;
          isLegacyUnlinked: boolean;
        }[];
      }>(
        await asP('get', '/import-reports/operations?limit=100'),
        200,
        'resumen',
      );
      expect(summary.data.find((r) => r.id === legacy.id)).toMatchObject({
        isLegacyUnlinked: true,
        purchaseInvoiceId: null,
        supplierLegalName: null,
      });
      const linked = summary.data.find((r) => r.purchaseInvoiceId !== null);
      expect(linked?.supplierLegalName).toBeTruthy();
    });

    // ---------------- Incoterm
    it('N1. incoterm: crear, consultar, editar en PLANNED y rechazar fuera de estado', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirm((await createInvoice(supplierId)).id);
      const op = await newOperation(invoice.id);
      const line = {
        descriptionSnapshot: 'A',
        plannedQuantity: '1.000',
        purchaseInvoiceLineId: invoice.lines[0].id,
      };

      const none = ok<ShipmentBody>(
        await ship(op.id, { transportMode: 'AIR', lines: [line] }),
        201,
        'sin incoterm',
      );
      expect(none).toMatchObject({
        incoterm: null,
        incotermNamedPlace: null,
        incotermVersion: null,
      });

      const fob = ok<ShipmentBody>(
        await ship(op.id, {
          transportMode: 'SEA',
          incoterm: 'FOB',
          incotermNamedPlace: ' Shanghai ',
          lines: [{ ...line, plannedQuantity: '2.000' }],
        }),
        201,
        'FOB',
      );
      expect(fob).toMatchObject({
        incoterm: 'FOB',
        incotermNamedPlace: 'Shanghai',
        incotermVersion: '2020',
      });
      const got = ok<ShipmentBody>(
        await asP('get', `/import-shipments/${fob.id}`),
        200,
        'detalle',
      );
      expect(got.incoterm).toBe('FOB');
      const listed = ok<{ data: ShipmentBody[] }>(
        await asP('get', `/import-operations/${op.id}/shipments`),
        200,
        'listado',
      );
      expect(listed.data.find((s) => s.id === fob.id)?.incotermNamedPlace).toBe(
        'Shanghai',
      );

      const edited = ok<ShipmentBody>(
        await asP('patch', `/import-shipments/${fob.id}`, {
          incoterm: 'CIF',
          incotermNamedPlace: 'Callao',
        }),
        200,
        'editar',
      );
      expect(edited).toMatchObject({
        incoterm: 'CIF',
        incotermNamedPlace: 'Callao',
        incotermVersion: '2020',
      });
      const cleared = ok<ShipmentBody>(
        await asP('patch', `/import-shipments/${fob.id}`, { incoterm: null }),
        200,
        'limpiar',
      );
      expect(cleared).toMatchObject({
        incoterm: null,
        incotermNamedPlace: null,
        incotermVersion: null,
      });

      await expectActorAudit('IMPORT_SHIPMENT_CREATED', fob.id);
      await expectActorAudit('IMPORT_SHIPMENT_UPDATED', fob.id);

      // fuera de PLANNED no se edita
      ok(
        await asP('post', `/import-shipments/${fob.id}/depart`, {}),
        200,
        'depart',
      );
      expect(
        (
          await asP('patch', `/import-shipments/${fob.id}`, {
            incoterm: 'DAP',
            incotermNamedPlace: 'Lima',
          })
        ).status,
      ).toBe(409);
    });

    it('N2. matriz modo × código y errores por campo', async () => {
      const supplierId = await newSupplier();
      const invoice = await confirm(
        (await createInvoice(supplierId, {}, { quantity: '100.000' })).id,
      );
      const op = await newOperation(invoice.id);
      const line = {
        descriptionSnapshot: 'A',
        plannedQuantity: '1.000',
        purchaseInvoiceLineId: invoice.lines[0].id,
      };
      const maritime = ['FAS', 'FOB', 'CFR', 'CIF'];
      const universal = ['EXW', 'FCA', 'CPT', 'CIP', 'DAP', 'DPU', 'DDP'];
      for (const code of maritime) {
        for (const mode of ['AIR', 'LAND', 'OTHER']) {
          const res = await ship(op.id, {
            transportMode: mode,
            incoterm: code,
            incotermNamedPlace: 'X',
            lines: [line],
          });
          expect([code, mode, res.status]).toEqual([code, mode, 400]);
          expect(err(res).errors![0]).toMatchObject({
            field: 'incoterm',
            code: 'INCOTERM_REQUIRES_SEA_TRANSPORT',
            type: 'BUSINESS',
          });
        }
        expect(
          (
            await ship(op.id, {
              transportMode: 'SEA',
              incoterm: code,
              incotermNamedPlace: 'Puerto',
              lines: [line],
            })
          ).status,
        ).toBe(201);
      }
      for (const code of universal) {
        for (const mode of ['SEA', 'AIR', 'LAND', 'OTHER']) {
          expect([
            code,
            mode,
            (
              await ship(op.id, {
                transportMode: mode,
                incoterm: code,
                incotermNamedPlace: 'Lima',
                lines: [line],
              })
            ).status,
          ]).toEqual([code, mode, 201]);
        }
      }
      // sin lugar
      const noPlace = await ship(op.id, {
        transportMode: 'SEA',
        incoterm: 'EXW',
        lines: [line],
      });
      expect(noPlace.status).toBe(400);
      expect(err(noPlace).errors![0]).toMatchObject({
        field: 'incotermNamedPlace',
        type: 'REQUIRED',
      });
      // código inválido (enum) y versión no soportada
      const bad = await ship(op.id, {
        transportMode: 'SEA',
        incoterm: 'XYZ',
        incotermNamedPlace: 'A',
        lines: [line],
      });
      expect(bad.status).toBe(400);
      expect(err(bad).errors!.some((e) => e.field === 'incoterm')).toBe(true);
      expect(
        (
          await ship(op.id, {
            transportMode: 'SEA',
            incoterm: 'EXW',
            incotermNamedPlace: 'A',
            incotermVersion: '2010',
            lines: [line],
          })
        ).status,
      ).toBe(400);
      // lugar sin incoterm
      expect(
        (
          await ship(op.id, {
            transportMode: 'SEA',
            incotermNamedPlace: 'A',
            lines: [line],
          })
        ).status,
      ).toBe(400);

      // revalidación al cambiar el modo de transporte con un FOB vigente
      const fob = ok<ShipmentBody>(
        await ship(op.id, {
          transportMode: 'SEA',
          incoterm: 'FOB',
          incotermNamedPlace: 'Puerto',
          lines: [line],
        }),
        201,
        'FOB',
      );
      const change = await asP('patch', `/import-shipments/${fob.id}`, {
        transportMode: 'AIR',
      });
      expect(change.status).toBe(400);
      expect(err(change).errors![0]).toMatchObject({
        field: 'transportMode',
        code: 'INCOTERM_REQUIRES_SEA_TRANSPORT',
      });
      expect(
        (
          await prisma.importShipment.findUniqueOrThrow({
            where: { id: fob.id },
          })
        ).transportMode,
      ).toBe('SEA');
      expect(
        (
          await asP('patch', `/import-shipments/${fob.id}`, {
            transportMode: 'AIR',
            incoterm: 'FCA',
            incotermNamedPlace: 'Lima',
          })
        ).status,
      ).toBe(200);
    });

    it('N3. la base de datos rechaza combinaciones inválidas; históricos con NULL siguen válidos; sin efectos contables', async () => {
      const legacy = await createLegacyImportOperation(prisma, {
        reference: `INC-${nextSuffix()}`,
      });
      const insert = (
        mode: string,
        inc: string | null,
        place: string | null,
        version: string | null,
      ) =>
        prisma.$executeRaw(Prisma.sql`
          INSERT INTO import_shipments (id, import_operation_id, transport_mode, incoterm, incoterm_named_place, incoterm_version, status, created_by_user_id, updated_at)
          VALUES (gen_random_uuid(), ${legacy.id}::uuid, ${mode}::"ImportTransportMode", ${inc}::"ImportIncoterm", ${place}, ${version}, 'PLANNED', ${purchasingUserId}::uuid, now())
        `);
      await expect(insert('AIR', 'FOB', 'X', '2020')).rejects.toThrow(); // marítimo con AIR
      await expect(insert('SEA', 'FOB', null, '2020')).rejects.toThrow(); // sin lugar
      await expect(insert('SEA', 'FOB', 'X', null)).rejects.toThrow(); // sin versión
      await expect(insert('SEA', null, 'X', null)).rejects.toThrow(); // lugar sin incoterm
      await expect(insert('SEA', 'FOB', 'X', '2010')).rejects.toThrow(); // versión no soportada
      await expect(
        insert('SEA', 'FOB', 'Shanghai', '2020'),
      ).resolves.toBeDefined();
      await expect(insert('LAND', null, null, null)).resolves.toBeDefined(); // histórico
      // el incoterm nunca genera gastos ni asientos
      expect(
        await prisma.importExpense.count({
          where: { importOperationId: legacy.id },
        }),
      ).toBe(0);
    });
  });

  // ====================================================================
  // 2. Compras multimoneda
  // ====================================================================
  describe('compras multimoneda (req. 2)', () => {
    it('M1. factura en la moneda de la empresa: tasa 1 y contrato anterior intacto', async () => {
      const supplierId = await newSupplier();
      const draft = await createInvoice(
        supplierId,
        {},
        {
          taxCategory: 'TAXED',
          taxBasis: 'TAX_EXCLUDED',
          creditableTaxAmount: '180.00',
        },
      );
      expect(draft).toMatchObject({
        currencyCode: 'PEN',
        baseCurrencyCode: 'PEN',
        exchangeRate: '1',
        subtotal: '1000.00',
        taxAmount: '180.00',
        totalAmount: '1180.00',
        baseSubtotal: '1000.00',
        baseTotalAmount: '1180.00',
      });
      const confirmed = await confirm(draft.id);
      const [entry] = await lines(AccountingSourceType.PURCHASE, draft.id);
      assertBalanced(entry);
      expect(find(entry, acc.resale)[0]).toMatchObject({ debit: '1000.00' });
      expect(find(entry, acc.vat)[0]).toMatchObject({ debit: '180.00' });
      expect(find(entry, acc.ap)[0]).toMatchObject({ credit: '1180.00' });
      expect(confirmed.baseCurrencyCode).toBe('PEN');
      // misma moneda con otra tasa: 400; con 3 decimales de precio: 400 (contrato anterior)
      const supplier2 = await newSupplier();
      const badRate = await asP(
        'post',
        '/purchase-invoices',
        invoiceBody(supplier2, { currencyCode: 'PEN', exchangeRate: '3.70' }),
      );
      expect(badRate.status).toBe(400);
      expect(err(badRate).errors![0]).toMatchObject({
        field: 'exchangeRate',
        code: 'EXCHANGE_RATE_MUST_BE_ONE',
      });
      const threeDec = await asP(
        'post',
        '/purchase-invoices',
        invoiceBody(supplier2, {}, { unitCost: '10.123' }),
      );
      expect(threeDec.status).toBe(400);
    });

    it('M2. USD con empresa PEN: conversión exacta por componente, congelamiento y asiento en moneda de la empresa', async () => {
      const supplierId = await newSupplier();
      const draft = await createInvoice(
        supplierId,
        {
          currencyCode: 'usd',
          exchangeRate: '3.70',
          exchangeRateDate: businessToday(),
        },
        {
          taxCategory: 'TAXED',
          taxBasis: 'TAX_EXCLUDED',
          creditableTaxAmount: '180.00',
        },
      );
      // original (USD) y equivalente (PEN) bien diferenciados
      expect(draft).toMatchObject({
        currencyCode: 'USD',
        baseCurrencyCode: 'PEN',
        exchangeRate: '3.7',
        subtotal: '1000.00',
        taxAmount: '180.00',
        totalAmount: '1180.00',
        baseSubtotal: '3700.00',
        baseTaxAmount: '666.00',
        baseTotalAmount: '4366.00',
      });
      expect(draft.lines[0]).toMatchObject({
        unitCost: '100.000000',
        baseUnitCost: '370.00',
        baseTaxableBaseAmount: '3700.00',
        baseLineTotal: '4366.00',
      });

      // DRAFT: la tasa se corrige; el equivalente se recalcula desde los originales
      const edited = ok<InvoiceBody>(
        await asP('patch', `/purchase-invoices/${draft.id}`, {
          exchangeRate: '3.80',
        }),
        200,
        'editar tasa',
      );
      expect(edited).toMatchObject({
        exchangeRate: '3.8',
        baseSubtotal: '3800.00',
        baseTotalAmount: '4484.00',
        subtotal: '1000.00',
      });
      ok(
        await asP('patch', `/purchase-invoices/${draft.id}`, {
          exchangeRate: '3.70',
        }),
        200,
        'restaurar tasa',
      );
      expect(
        (
          await asP('patch', `/purchase-invoices/${draft.id}`, {
            exchangeRate: '0',
          })
        ).status,
      ).toBe(400);
      expect(
        (
          await asP('patch', `/purchase-invoices/${draft.id}`, {
            currencyCode: 'EUR',
          })
        ).status,
      ).toBe(400); // cambiar de moneda exige tasa

      const confirmed = await confirm(draft.id);
      const [entry] = await lines(AccountingSourceType.PURCHASE, draft.id);
      assertBalanced(entry);
      // ningún importe en USD mezclado con PEN: todo el asiento en la moneda de la empresa
      expect(find(entry, acc.resale)[0]).toMatchObject({ debit: '3700.00' });
      expect(find(entry, acc.vat)[0]).toMatchObject({ debit: '666.00' });
      expect(find(entry, acc.ap)[0]).toMatchObject({ credit: '4366.00' });

      // congelamiento: confirmada ya no se edita; la tasa histórica no cambia
      expect(
        (
          await asP('patch', `/purchase-invoices/${draft.id}`, {
            exchangeRate: '9.99',
          })
        ).status,
      ).toBe(409);
      const reread = ok<InvoiceBody>(
        await asP('get', `/purchase-invoices/${draft.id}`),
        200,
        'releer',
      );
      expect(reread).toMatchObject({
        exchangeRate: '3.7',
        baseTotalAmount: confirmed.baseTotalAmount,
        totalAmount: '1180.00',
      });
      // columnas contables en base de datos (moneda de la empresa) y originales
      const row = await prisma.purchaseInvoice.findUniqueOrThrow({
        where: { id: draft.id },
      });
      expect([
        row.totalAmount.toFixed(2),
        row.totalAmountOriginal.toFixed(2),
        row.exchangeRate.toFixed(),
      ]).toEqual(['4366.00', '1180.00', '3.7']);
      await expectActor('PURCHASE_INVOICE_CONFIRMED', draft.id);
    });

    async function expectActor(
      action: string,
      entityId: string,
    ): Promise<void> {
      const rows = await prisma.auditLog.findMany({
        where: { action, entityId },
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
      for (const r of rows) expect(r.userId).toBe(purchasingUserId);
    }

    it('M3. validaciones de moneda y tasa; precio unitario con hasta 6 decimales en moneda extranjera; redondeo de céntimos', async () => {
      const supplierId = await newSupplier();
      for (const bad of ['0', '-1', 'abc', '1.123456789']) {
        const res = await asP(
          'post',
          '/purchase-invoices',
          invoiceBody(supplierId, { currencyCode: 'USD', exchangeRate: bad }),
        );
        expect([bad, res.status]).toEqual([bad, 400]);
      }
      expect(
        (
          await asP(
            'post',
            '/purchase-invoices',
            invoiceBody(supplierId, { currencyCode: 'US' }),
          )
        ).status,
      ).toBe(400);
      // 3 × 0.333333 USD = 0.999999 -> 1.00; × 3.7777 = 3.78 (HALF_UP); cabecera = suma de líneas
      const inv = await createInvoice(
        supplierId,
        { currencyCode: 'USD', exchangeRate: '3.7777' },
        { quantity: '3.000', unitCost: '0.333333' },
      );
      expect(inv.lines[0]).toMatchObject({
        unitCost: '0.333333',
        taxableBaseAmount: '1.00',
        baseTaxableBaseAmount: '3.78',
      });
      expect(inv.baseTotalAmount).toBe('3.78');
      expect(inv.totalAmount).toBe('1.00');
    });

    it('M4. recepción conserva cantidades/ubicación y valoriza con importes convertidos; la diferencia cambiaria no toca el costo', async () => {
      const supplierId = await newSupplier();
      const draft = await createInvoice(
        supplierId,
        { currencyCode: 'USD', exchangeRate: '3.70' },
        { productId: valuedProductId, quantity: '10.000', unitCost: '100.00' },
      );
      const invoice = await confirm(draft.id);
      const rec = ok<IdBody>(
        await asP('post', `/purchase-invoices/${invoice.id}/receipts`, {
          lines: [
            { purchaseInvoiceLineId: invoice.lines[0].id, quantity: '10.000' },
          ],
        }),
        201,
        'recepción',
      );
      const stock = (
        await prisma.product.findUniqueOrThrow({
          where: { id: valuedProductId },
        })
      ).stockCurrent;
      expect(stock.gte(10)).toBe(true);
      const valuation = await prisma.inventoryValuation.findFirstOrThrow({
        where: { purchaseReceiptLine: { purchaseReceiptId: rec.id } },
      });
      // costo del inventario = importe convertido a la tasa histórica de la factura
      expect(valuation.totalCost.toFixed(2)).toBe('3700.00');
      expect(valuation.unitCost.toFixed(4)).toBe('370.0000');
      // pago a otra tasa: pérdida cambiaria, y el costo valorizado NO cambia
      ok(
        await api(
          'patch',
          `/chart-of-accounts/system-keys/${AccountingSystemKey.FX_LOSS_REALIZED}`,
          adminCookie,
          { accountId: acc.fxLoss },
        ),
        200,
        'map loss',
      );
      ok(
        await api(
          'patch',
          `/chart-of-accounts/system-keys/${AccountingSystemKey.FX_GAIN_REALIZED}`,
          adminCookie,
          { accountId: acc.fxGain },
        ),
        200,
        'map gain',
      );
      ok(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: invoice.id, amount: '1000.00' }],
          { currencyCode: 'USD', exchangeRate: '3.80' },
        ),
        201,
        'pago',
      );
      const after = await prisma.inventoryValuation.findUniqueOrThrow({
        where: { id: valuation.id },
      });
      expect(after.totalCost.toFixed(2)).toBe('3700.00');
      expect(
        await prisma.inventoryValuation.count({
          where: { purchaseReceiptLine: { purchaseReceiptId: rec.id } },
        }),
      ).toBe(1);
      // anular recepción: bloqueada por el pago? no; se anula la recepción -> reversa de valorización exacta
      ok(
        await asP('post', `/purchase-receipts/${rec.id}/cancel`, {
          reason: 'e2e',
        }),
        200,
        'anular recepción',
      );
    });

    it('M5. falta el mapeo de diferencia de cambio: 409 controlado, sin pago ni asiento ni asignaciones', async () => {
      // Mapeos aún sin asignar para ESTE caso: se desasignan temporalmente (fixture).
      await prisma.account.updateMany({
        where: {
          systemKey: {
            in: [
              AccountingSystemKey.FX_GAIN_REALIZED,
              AccountingSystemKey.FX_LOSS_REALIZED,
            ],
          },
        },
        data: { systemKey: null },
      });
      const supplierId = await newSupplier();
      const invoice = await usdInvoice(supplierId);
      const before = {
        payments: await prisma.supplierPayment.count({ where: { supplierId } }),
        allocations: await prisma.supplierPaymentAllocation.count({
          where: { purchaseInvoiceId: invoice.id },
        }),
        entries: await prisma.accountingEntry.count(),
      };
      const res = await pay(
        supplierId,
        [{ purchaseInvoiceId: invoice.id, amount: '1000.00' }],
        { currencyCode: 'USD', exchangeRate: '3.80' },
      );
      expect(res.status).toBe(409);
      expect(JSON.stringify(res.body)).toContain('FX_LOSS_REALIZED');
      expect({
        payments: await prisma.supplierPayment.count({ where: { supplierId } }),
        allocations: await prisma.supplierPaymentAllocation.count({
          where: { purchaseInvoiceId: invoice.id },
        }),
        entries: await prisma.accountingEntry.count(),
      }).toEqual(before);
      // sin diferencia (misma tasa) no exige el mapeo
      ok(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: invoice.id, amount: '400.00' }],
          { currencyCode: 'USD', exchangeRate: '3.70' },
        ),
        201,
        'pago sin diferencia',
      );
      await mapKey(AccountingSystemKey.FX_GAIN_REALIZED, acc.fxGain);
      await mapKey(AccountingSystemKey.FX_LOSS_REALIZED, acc.fxLoss);
    });

    it('M6. pago a tasa igual, con pérdida y con ganancia: asiento equilibrado en moneda de la empresa', async () => {
      const supplierId = await newSupplier();
      // igual
      const a = await usdInvoice(supplierId);
      const same = ok<PaymentBody>(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: a.id, amount: '1000.00' }],
          { currencyCode: 'USD', exchangeRate: '3.70' },
        ),
        201,
        'tasa igual',
      );
      expect(same).toMatchObject({
        currencyCode: 'USD',
        baseCurrencyCode: 'PEN',
        baseAmount: '3700.00',
        fxDifferenceAmount: '0.00',
      });
      let [pe] = await lines(AccountingSourceType.SUPPLIER_PAYMENT, same.id);
      assertBalanced(pe);
      expect(find(pe, acc.ap)[0]).toMatchObject({ debit: '3700.00' });
      expect(find(pe, acc.cash)[0]).toMatchObject({ credit: '3700.00' });
      expect(pe.lines).toHaveLength(2);

      // pérdida: 1000 × 3.80 = 3800 contra valor en libros 3700
      const b = await usdInvoice(supplierId);
      const loss = ok<PaymentBody>(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: b.id, amount: '1000.00' }],
          { currencyCode: 'USD', exchangeRate: '3.80' },
        ),
        201,
        'pérdida',
      );
      expect(loss).toMatchObject({
        baseAmount: '3800.00',
        fxDifferenceAmount: '100.00',
      });
      expect(loss.allocations[0]).toMatchObject({
        carryingBaseAmount: '3700.00',
        settledBaseAmount: '3800.00',
        fxDifferenceAmount: '100.00',
      });
      [pe] = await lines(AccountingSourceType.SUPPLIER_PAYMENT, loss.id);
      assertBalanced(pe);
      expect(find(pe, acc.ap)[0]).toMatchObject({ debit: '3700.00' });
      expect(find(pe, acc.fxLoss)[0]).toMatchObject({ debit: '100.00' });
      expect(find(pe, acc.cash)[0]).toMatchObject({ credit: '3800.00' });

      // ganancia: 1000 × 3.60 = 3600
      const c = await usdInvoice(supplierId);
      const gain = ok<PaymentBody>(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: c.id, amount: '1000.00' }],
          { currencyCode: 'USD', exchangeRate: '3.60' },
        ),
        201,
        'ganancia',
      );
      expect(gain).toMatchObject({
        baseAmount: '3600.00',
        fxDifferenceAmount: '-100.00',
      });
      [pe] = await lines(AccountingSourceType.SUPPLIER_PAYMENT, gain.id);
      assertBalanced(pe);
      expect(find(pe, acc.fxGain)[0]).toMatchObject({ credit: '100.00' });
      expect(find(pe, acc.cash)[0]).toMatchObject({ credit: '3600.00' });
      await expectActor('SUPPLIER_PAYMENT_REGISTERED', loss.id);
    });

    it('M7. pagos parciales con tasas distintas; saldo original y contable por separado; anulación con reversa exacta', async () => {
      const supplierId = await newSupplier();
      const inv = await usdInvoice(supplierId); // USD 1000 @3.70 = PEN 3700
      const p1 = ok<PaymentBody>(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: inv.id, amount: '400.00' }],
          { currencyCode: 'USD', exchangeRate: '3.80' },
        ),
        201,
        'parcial 1',
      );
      expect(p1.allocations[0]).toMatchObject({
        carryingBaseAmount: '1480.00',
        settledBaseAmount: '1520.00',
        fxDifferenceAmount: '40.00',
      });
      let detail = ok<{
        balanceDue: string;
        baseBalanceDue: string;
        paidAmount: string;
        basePaidAmount: string;
        status: string;
      }>(await asP('get', `/accounts-payable/${inv.id}`), 200, 'detalle CxP');
      expect(detail).toMatchObject({
        paidAmount: '400.00',
        balanceDue: '600.00',
        basePaidAmount: '1480.00',
        baseBalanceDue: '2220.00',
        status: 'PARTIALLY_PAID',
      });

      // sobrepago (en la moneda del documento)
      expect(
        (
          await pay(
            supplierId,
            [{ purchaseInvoiceId: inv.id, amount: '600.01' }],
            { currencyCode: 'USD', exchangeRate: '3.70' },
          )
        ).status,
      ).toBe(409);
      const p2 = ok<PaymentBody>(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: inv.id, amount: '600.00' }],
          { currencyCode: 'USD', exchangeRate: '3.60' },
        ),
        201,
        'parcial 2 (saldo)',
      );
      // el pago que salda toma EXACTAMENTE el residuo del valor en libros
      expect(p2.allocations[0]).toMatchObject({
        carryingBaseAmount: '2220.00',
        settledBaseAmount: '2160.00',
        fxDifferenceAmount: '-60.00',
      });
      detail = ok(
        await asP('get', `/accounts-payable/${inv.id}`),
        200,
        'detalle CxP 2',
      );
      expect(detail).toMatchObject({
        balanceDue: '0.00',
        baseBalanceDue: '0.00',
        status: 'PAID',
      });

      // anular el segundo pago: reversa exacta del asiento y saldos restaurados
      const [orig] = await lines(AccountingSourceType.SUPPLIER_PAYMENT, p2.id);
      ok(
        await asP('post', `/supplier-payments/${p2.id}/cancel`, {
          reason: 'e2e',
        }),
        200,
        'anular',
      );
      const all = await lines(AccountingSourceType.SUPPLIER_PAYMENT, p2.id);
      const rev = all.find((e) => e.eventType === 'REVERSAL')!;
      assertBalanced(rev);
      for (const l of orig.lines) {
        const r = rev.lines.find((x) => x.accountId === l.accountId)!;
        expect([r.debit, r.credit]).toEqual([l.credit, l.debit]);
      }
      detail = ok(
        await asP('get', `/accounts-payable/${inv.id}`),
        200,
        'detalle CxP 3',
      );
      expect(detail).toMatchObject({
        balanceDue: '600.00',
        baseBalanceDue: '2220.00',
      });
      expect(
        (
          await asP('post', `/supplier-payments/${p2.id}/cancel`, {
            reason: 'otra',
          })
        ).status,
      ).toBe(409);
      await expectActor('SUPPLIER_PAYMENT_CANCELLED', p2.id);

      // la factura no se anula con pagos activos; sí tras anularlos, con reversa del asiento histórico
      expect(
        (
          await asP('post', `/purchase-invoices/${inv.id}/cancel`, {
            reason: 'x',
          })
        ).status,
      ).toBe(409);
      ok(
        await asP('post', `/supplier-payments/${p1.id}/cancel`, {
          reason: 'e2e',
        }),
        200,
        'anular pago 1',
      );
      ok(
        await asP('post', `/purchase-invoices/${inv.id}/cancel`, {
          reason: 'e2e',
        }),
        200,
        'anular factura',
      );
      const [pEntry, pRev] = await lines(AccountingSourceType.PURCHASE, inv.id);
      expect(find(pRev, acc.ap)[0]).toMatchObject({
        debit: find(pEntry, acc.ap)[0].credit,
      });
      expect(find(pRev, acc.ap)[0].debit).toBe('3700.00');
    });

    it('M8. varias facturas del mismo proveedor y moneda en un pago: reparto exacto de valores en libros y residuos', async () => {
      const supplierId = await newSupplier();
      const a = await usdInvoice(supplierId, '3.7777', '1.000', '100.01');
      const b = await usdInvoice(supplierId, '3.7777', '2.000', '100.01');
      const c = await usdInvoice(supplierId, '3.6000', '1.000', '50.00');
      const res = ok<PaymentBody>(
        await pay(
          supplierId,
          [
            { purchaseInvoiceId: a.id, amount: '100.01' },
            { purchaseInvoiceId: b.id, amount: '200.02' },
            { purchaseInvoiceId: c.id, amount: '50.00' },
          ],
          { currencyCode: 'USD', exchangeRate: '3.9000' },
        ),
        201,
        'pago múltiple',
      );
      const sum = (
        key: 'carryingBaseAmount' | 'settledBaseAmount' | 'fxDifferenceAmount',
      ) =>
        res.allocations.reduce((s, x) => s.plus(x[key]), new Prisma.Decimal(0));
      expect(sum('settledBaseAmount').toFixed(2)).toBe(res.baseAmount);
      expect(sum('fxDifferenceAmount').toFixed(2)).toBe(
        sum('settledBaseAmount').minus(sum('carryingBaseAmount')).toFixed(2),
      );
      expect(res.baseAmount).toBe(
        new Prisma.Decimal('350.03').mul('3.9').toDecimalPlaces(2).toFixed(2),
      );
      // cada factura salda por completo: valor en libros cancelado = total contable de la factura
      for (const al of res.allocations) {
        const inv = await prisma.purchaseInvoice.findUniqueOrThrow({
          where: { id: al.purchaseInvoiceId },
        });
        expect(al.carryingBaseAmount).toBe(inv.totalAmount.toFixed(2));
      }
      const [pe] = await lines(AccountingSourceType.SUPPLIER_PAYMENT, res.id);
      assertBalanced(pe);
    });

    it('M9. política A: un pago, una moneda; pagos cruzados y mezclas de monedas se rechazan', async () => {
      const supplierId = await newSupplier();
      const usd = await usdInvoice(supplierId);
      const pen = await confirm((await createInvoice(supplierId)).id);
      // pago en PEN (por defecto) a una factura en USD
      const cross = await pay(supplierId, [
        { purchaseInvoiceId: usd.id, amount: '100.00' },
      ]);
      expect(cross.status).toBe(409);
      expect(err(cross)).toMatchObject({
        code: 'PAYMENT_CURRENCY_MISMATCH',
        kind: 'FORM',
      });
      // pago en USD a una factura en PEN
      expect(
        (
          await pay(
            supplierId,
            [{ purchaseInvoiceId: pen.id, amount: '100.00' }],
            { currencyCode: 'USD', exchangeRate: '3.7' },
          )
        ).status,
      ).toBe(409);
      // un solo pago con facturas de dos monedas
      const mixed = await asP('post', '/supplier-payments', {
        supplierId,
        amount: '200.00',
        method: 'CASH',
        currencyCode: 'USD',
        exchangeRate: '3.7',
        allocations: [
          { purchaseInvoiceId: usd.id, amount: '100.00' },
          { purchaseInvoiceId: pen.id, amount: '100.00' },
        ],
      });
      expect(mixed.status).toBe(409);
      // tasa obligatoria en pagos extranjeros; tasa 1 en la moneda de la empresa
      const noRate = await pay(
        supplierId,
        [{ purchaseInvoiceId: usd.id, amount: '100.00' }],
        { currencyCode: 'USD' },
      );
      expect(noRate.status).toBe(400);
      expect(err(noRate).errors![0]).toMatchObject({
        field: 'exchangeRate',
        type: 'REQUIRED',
      });
      expect(
        (
          await pay(
            supplierId,
            [{ purchaseInvoiceId: pen.id, amount: '100.00' }],
            { exchangeRate: '2' },
          )
        ).status,
      ).toBe(400);
      // pago en PEN a factura PEN: contrato anterior (sin campos nuevos)
      const plain = ok<PaymentBody>(
        await pay(supplierId, [
          { purchaseInvoiceId: pen.id, amount: '300.00' },
        ]),
        201,
        'PEN',
      );
      expect(plain).toMatchObject({
        currencyCode: 'PEN',
        exchangeRate: '1',
        baseAmount: '300.00',
        fxDifferenceAmount: '0.00',
      });
    });

    it('M10. idempotencia del pago y concurrencia de pagos/confirmaciones', async () => {
      const supplierId = await newSupplier();
      const inv = await usdInvoice(supplierId);
      const key = `r4-${nextSuffix()}`;
      const body = {
        currencyCode: 'USD',
        exchangeRate: '3.70',
        idempotencyKey: key,
      };
      const first = ok<PaymentBody>(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: inv.id, amount: '300.00' }],
          body,
        ),
        201,
        'pago 1',
      );
      const replay = await pay(
        supplierId,
        [{ purchaseInvoiceId: inv.id, amount: '300.00' }],
        body,
      );
      expect([200, 201]).toContain(replay.status);
      expect((replay.body as PaymentBody).id).toBe(first.id);
      expect(
        await prisma.supplierPayment.count({ where: { supplierId } }),
      ).toBe(1);
      expect(
        (await lines(AccountingSourceType.SUPPLIER_PAYMENT, first.id)).length,
      ).toBe(1);

      // dos pagos simultáneos que juntos superan el saldo (700): exactamente uno
      const [x, y] = await Promise.all([
        pay(supplierId, [{ purchaseInvoiceId: inv.id, amount: '500.00' }], {
          currencyCode: 'USD',
          exchangeRate: '3.80',
        }),
        pay(supplierId, [{ purchaseInvoiceId: inv.id, amount: '500.00' }], {
          currencyCode: 'USD',
          exchangeRate: '3.60',
        }),
      ]);
      expect([x.status, y.status].sort()).toEqual([201, 409]);
      const detail = ok<{ balanceDue: string }>(
        await asP('get', `/accounts-payable/${inv.id}`),
        200,
        'CxP',
      );
      expect(detail.balanceDue).toBe('200.00');

      // dos confirmaciones simultáneas: un solo asiento
      const draft = await createInvoice(supplierId, {
        currencyCode: 'USD',
        exchangeRate: '3.70',
      });
      const [c1, c2] = await Promise.all([
        asP('post', `/purchase-invoices/${draft.id}/confirm`, {}),
        asP('post', `/purchase-invoices/${draft.id}/confirm`, {}),
      ]);
      expect([c1.status, c2.status].sort()).toEqual([200, 409]);
      expect(
        (await lines(AccountingSourceType.PURCHASE, draft.id)).length,
      ).toBe(1);
    });

    it('M11. cuentas por pagar: saldos por moneda sin mezclar, equivalente contable, conciliación contra el libro y exportaciones', async () => {
      const supplierId = await newSupplier();
      const usd = await usdInvoice(supplierId); // USD 1000 -> PEN 3700
      const pen = await confirm((await createInvoice(supplierId)).id); // PEN 1000
      ok(
        await pay(
          supplierId,
          [{ purchaseInvoiceId: usd.id, amount: '250.00' }],
          { currencyCode: 'USD', exchangeRate: '3.80' },
        ),
        201,
        'pago USD',
      );
      const q = `?supplierId=${supplierId}`;

      const list = ok<{
        data: {
          currencyCode: string;
          balanceDue: string;
          baseBalanceDue: string;
          baseCurrencyCode: string;
        }[];
      }>(await asP('get', `/accounts-payable${q}`), 200, 'lista');
      const byCur = new Map(list.data.map((r) => [r.currencyCode, r]));
      expect(byCur.get('USD')).toMatchObject({
        balanceDue: '750.00',
        baseBalanceDue: '2775.00',
        baseCurrencyCode: 'PEN',
      });
      expect(byCur.get('PEN')).toMatchObject({
        balanceDue: '1000.00',
        baseBalanceDue: '1000.00',
      });

      const summary = ok<{
        baseCurrencyCode: string;
        grandTotal: { totalPending: string };
        byCurrency: {
          currencyCode: string;
          totalPending: string;
          baseTotalPending: string;
        }[];
      }>(await asP('get', `/accounts-payable/summary${q}`), 200, 'resumen');
      expect(summary.baseCurrencyCode).toBe('PEN');
      expect(
        summary.byCurrency.map((c) => [
          c.currencyCode,
          c.totalPending,
          c.baseTotalPending,
        ]),
      ).toEqual([
        ['PEN', '1000.00', '1000.00'],
        ['USD', '750.00', '2775.00'],
      ]);
      // el total general está en moneda de la empresa: NUNCA 1750 (USD + PEN directos)
      expect(summary.grandTotal.totalPending).toBe('3775.00');

      const aging = ok<{
        baseCurrencyCode: string;
        totals: { totalPending: string };
        byCurrency: {
          currencyCode: string;
          totalPending: string;
          baseTotalPending: string;
        }[];
      }>(await asP('get', `/accounts-payable/aging${q}`), 200, 'antigüedad');
      expect(aging.totals.totalPending).toBe('3775.00');
      expect(
        aging.byCurrency.find((c) => c.currencyCode === 'USD'),
      ).toMatchObject({ totalPending: '750.00', baseTotalPending: '2775.00' });

      const rec = ok<{
        baseCurrencyCode: string;
        overallConsistent: boolean;
        invoices: {
          purchaseInvoiceId: string;
          operationalPendingBalance: string;
          discrepancies: string[];
        }[];
        accounts: { discrepancies: string[] }[];
      }>(
        await asP('get', `/accounts-payable/reconciliation${q}`),
        200,
        'conciliación',
      );
      expect(rec.baseCurrencyCode).toBe('PEN');
      // Nivel factura: sin discrepancias (el crédito del libro coincide con el
      // total contable convertido).
      for (const r of rec.invoices) expect(r.discrepancies).toEqual([]);
      // Nivel cuenta (sin filtrar por proveedor, que es la forma de comparar la
      // cuenta completa): lo pagado en libros coincide con el neto del Mayor.
      const full = ok<{
        accounts: {
          accountId: string;
          difference: string;
          discrepancies: string[];
        }[];
      }>(
        await asP('get', '/accounts-payable/reconciliation'),
        200,
        'conciliación completa',
      );
      expect(full.accounts.find((x) => x.accountId === acc.ap)).toMatchObject({
        difference: '0.00',
        discrepancies: [],
      });
      expect(
        rec.invoices.find((r) => r.purchaseInvoiceId === usd.id),
      ).toMatchObject({
        operationalPendingBalance: '2775.00',
        discrepancies: [],
      });
      expect(
        rec.invoices.find((r) => r.purchaseInvoiceId === pen.id)
          ?.operationalPendingBalance,
      ).toBe('1000.00');

      for (const path of ['', '/summary', '/aging', '/reconciliation']) {
        const res = await asP(
          'get',
          `/accounts-payable${path}/export.xlsx${q}`,
        );
        expect([`/accounts-payable${path}/export.xlsx`, res.status]).toEqual([
          `/accounts-payable${path}/export.xlsx`,
          200,
        ]);
      }
    });

    it('M12. empresa con moneda distinta de PEN (EUR): documentos USD, pagos y diferencia de cambio en EUR', async () => {
      const supplierId = await newSupplier();
      // Fixture: la moneda de la empresa solo se cambia por escritura directa (A0.2 bloquea la vía API con historia).
      const settings = await prisma.companySettings.findFirstOrThrow();
      await prisma.companySettings.updateMany({
        data: { currencyCode: 'EUR', currencySymbol: '€' },
      });
      try {
        // un documento en la moneda de la empresa (EUR) tiene tasa 1; la PEN ahora es extranjera
        const eur = await createInvoice(supplierId, { currencyCode: 'EUR' });
        expect(eur).toMatchObject({
          currencyCode: 'EUR',
          baseCurrencyCode: 'EUR',
          exchangeRate: '1',
        });
        const pen = await asP(
          'post',
          '/purchase-invoices',
          invoiceBody(supplierId, { currencyCode: 'PEN' }),
        );
        expect(pen.status).toBe(400); // PEN ya es extranjera: exige tasa
        const usd = await createInvoice(
          supplierId,
          { currencyCode: 'USD', exchangeRate: '0.92' },
          { quantity: '10.000', unitCost: '100.00' },
        );
        expect(usd).toMatchObject({
          baseCurrencyCode: 'EUR',
          totalAmount: '1000.00',
          baseTotalAmount: '920.00',
        });
        await confirm(usd.id);
        const [entry] = await lines(AccountingSourceType.PURCHASE, usd.id);
        expect(find(entry, acc.ap)[0]).toMatchObject({ credit: '920.00' });
        // pago a 0.95: pérdida de 30.00 EUR
        const paid = ok<PaymentBody>(
          await pay(
            supplierId,
            [{ purchaseInvoiceId: usd.id, amount: '1000.00' }],
            { currencyCode: 'USD', exchangeRate: '0.95' },
          ),
          201,
          'pago',
        );
        expect(paid).toMatchObject({
          baseCurrencyCode: 'EUR',
          baseAmount: '950.00',
          fxDifferenceAmount: '30.00',
        });
        // un borrador creado en EUR no se confirma si la moneda de empresa cambia después
      } finally {
        await prisma.companySettings.updateMany({
          data: {
            currencyCode: settings.currencyCode,
            currencySymbol: settings.currencySymbol,
          },
        });
        await purgeFinancials([supplierId]);
      }
      // restaurada la moneda de la empresa: una factura en PEN vuelve a tener tasa 1
      expect((await createInvoice(await newSupplier())).baseCurrencyCode).toBe(
        settings.currencyCode,
      );
    });

    async function purgeFinancials(supplierIds: string[]): Promise<void> {
      const invoices = await prisma.purchaseInvoice.findMany({
        where: { supplierId: { in: supplierIds } },
        select: { id: true },
      });
      const payments = await prisma.supplierPayment.findMany({
        where: { supplierId: { in: supplierIds } },
        select: { id: true, postedEntryId: true },
      });
      const sourceIds = [
        ...invoices.map((i) => i.id),
        ...payments.map((p) => p.id),
      ];
      const base = await prisma.accountingEntry.findMany({
        where: { sourceId: { in: sourceIds } },
        select: { id: true },
      });
      const reversals = await prisma.accountingEntry.findMany({
        where: { reversesEntryId: { in: base.map((b) => b.id) } },
        select: { id: true },
      });
      const entryIds = [...base, ...reversals].map((e) => e.id);
      await prisma.supplierPaymentAllocation.deleteMany({
        where: { supplierPaymentId: { in: payments.map((p) => p.id) } },
      });
      await prisma.supplierPayment.deleteMany({
        where: { id: { in: payments.map((p) => p.id) } },
      });
      await prisma.purchaseInvoice.deleteMany({
        where: { id: { in: invoices.map((i) => i.id) } },
      });
      await prisma.accountingEntryLine.deleteMany({
        where: { entryId: { in: entryIds } },
      });
      await prisma.accountingEntry.deleteMany({
        where: { id: { in: entryIds } },
      });
    }
  });

  // ====================================================================
  // Permisos de otros roles y de PURCHASING (R3 intacto)
  // ====================================================================
  describe('autorización', () => {
    it('A1. PURCHASING completa los flujos sin 403 y no obtiene permisos ajenos; otros roles sin ampliaciones', async () => {
      expect((await asP('get', '/countries')).status).toBe(200);
      expect(
        (await asP('get', '/import-reports/legacy-operations')).status,
      ).toBe(200);
      expect((await asP('get', '/accounts-payable/summary')).status).toBe(200);
      for (const [method, path] of [
        ['get', '/users'],
        ['patch', '/configuration'],
        ['post', '/inventory/transfers'],
        ['post', '/countries/CN/deactivate'],
        ['patch', '/countries/CN'],
      ] as const) {
        expect([path, (await asP(method, path, {})).status]).toEqual([
          path,
          403,
        ]);
      }
      for (const cookie of [sellerCookie]) {
        expect(
          (await api('get', '/import-reports/legacy-operations', cookie))
            .status,
        ).toBe(403);
        expect(
          (await api('post', '/import-operations', cookie, {})).status,
        ).toBe(403);
      }
      for (const cookie of [managementCookie, accountantCookie]) {
        expect(
          (await api('get', '/import-reports/legacy-operations', cookie))
            .status,
        ).toBe(200);
        expect(
          (await api('post', '/supplier-payments', cookie, {})).status,
        ).toBe(403);
      }
    });
  });
});
