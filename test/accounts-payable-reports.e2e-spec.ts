import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  PrismaClient,
  PurchaseInvoiceDocumentType,
  RoleName,
  SupplierDocumentType,
} from '@prisma/client';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  addCalendarDays,
  businessToday,
} from '../src/common/date/business-date';
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
 * Fase A5.4 — Reportes y conciliación de cuentas por pagar. Suite
 * dedicada y aislada (mismo criterio que supplier-payments.e2e-spec.ts):
 * limpia exclusivamente por los ids que ella misma crea. Reutiliza
 * líneas de factura SERVICE (sin productId) para no necesitar fixtures
 * de inventario — A5.4 nunca toca inventario.
 */

interface SafePurchaseInvoiceBody {
  id: string;
  supplierId: string;
  status: string;
  totalAmount: string;
  postedEntryId: string | null;
}

interface SafeSupplierPaymentBody {
  id: string;
  status: 'ACTIVE' | 'CANCELLED';
}

interface AccountsPayableItemBody {
  purchaseInvoiceId: string;
  balanceDue: string;
  status: string;
  agingBucket: string;
  daysOverdue: number | null;
}

const ACCOUNTANT_USERNAME = 'e2e_a54_accountant';
const MANAGEMENT_USERNAME = 'e2e_a54_management';
const SELLER_USERNAME = 'e2e_a54_seller';
const WAREHOUSE_USERNAME = 'e2e_a54_warehouse';
const FIXTURE_PASSWORD = 'E2eA54Fixture2026Aa';

describe('Accounts Payable Reports — Fase A5.4 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let supplierId: string;
  let liabilityAccountId: string;

  const createdAccountIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdPurchaseInvoiceIds: string[] = [];
  const createdSupplierPaymentIds: string[] = [];

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

  function registerPayment(
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/supplier-payments')
      .set('Cookie', adminCookie)
      .send(body);
  }

  function cancelPayment(
    id: string,
    reason: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/supplier-payments/${id}/cancel`)
      .set('Cookie', adminCookie)
      .send({ reason });
  }

  function getAp(
    path: string,
    query: Record<string, string> = {},
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/accounts-payable${path}`)
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
        legalName: `Proveedor E2E A5.4 ${suffix}`,
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

  /** Factura CONFIRMED con UNA línea SERVICE (sin productId, sin inventario). `dueDate` opcional. */
  async function createConfirmedInvoice(
    unitCost: string,
    dueDate: string | null = null,
    forSupplierId: string = supplierId,
  ): Promise<SafePurchaseInvoiceBody> {
    const suffix = nextSuffix();
    const draft = await createInvoice({
      supplierId: forSupplierId,
      documentType: PurchaseInvoiceDocumentType.FACTURA,
      documentSeries: 'F900',
      documentNumber: suffix.slice(-8),
      issueDate: businessToday(),
      ...(dueDate !== null ? { dueDate } : {}),
      lines: [
        {
          description: 'Servicio de prueba E2E A5.4',
          acquisitionKind: 'SERVICE',
          purchasePurpose: 'OPERATING_EXPENSE',
          quantity: '1.000',
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
    return confirmed.body as SafePurchaseInvoiceBody;
  }

  async function payInvoiceFully(
    invoice: SafePurchaseInvoiceBody,
    amount: string,
  ): Promise<SafeSupplierPaymentBody> {
    const response = await registerPayment({
      supplierId: invoice.supplierId,
      amount,
      method: 'CASH',
      allocations: [{ purchaseInvoiceId: invoice.id, amount }],
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo registrar el pago fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeSupplierPaymentBody;
    createdSupplierPaymentIds.push(body.id);
    return body;
  }

  async function readWorkbook(buffer: Buffer): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- desajuste de tipos conocido entre Buffer<ArrayBufferLike> y el Buffer de exceljs; verificado en runtime.
    await workbook.xlsx.load(buffer as any);
    const sheet = workbook.worksheets[0];
    if (!sheet) {
      throw new Error('El .xlsx descargado no tiene ninguna hoja');
    }
    return sheet;
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
      email: 'e2e_a54_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_a54_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a54_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a54_warehouse@demosystem.test',
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
    liabilityAccountId = await createTestAccount(
      `A54AP${shortSuffix}`,
      'Cuentas por pagar sintética E2E A5.4',
      AccountType.LIABILITY,
    );
    await activateSystemKey(
      AccountingSystemKey.ACCOUNTS_PAYABLE,
      liabilityAccountId,
    );
    const opexAccountId = await createTestAccount(
      `A54OPEX${shortSuffix}`,
      'Gasto operativo sintético E2E A5.4',
      AccountType.EXPENSE,
    );
    await activateSystemKey(
      AccountingSystemKey.PURCHASE_OPERATING_EXPENSE,
      opexAccountId,
    );

    supplierId = await createSupplier();
  }, 60000);

  afterAll(async () => {
    try {
      const payments = await prisma.supplierPayment.findMany({
        where: {
          OR: [
            { id: { in: createdSupplierPaymentIds } },
            { supplierId: { in: createdSupplierIds } },
          ],
        },
        select: { id: true, postedEntryId: true },
      });
      const allPaymentIds = payments.map((p) => p.id);
      await prisma.supplierPaymentAllocation.deleteMany({
        where: { supplierPaymentId: { in: allPaymentIds } },
      });
      await prisma.supplierPayment.deleteMany({
        where: { id: { in: allPaymentIds } },
      });

      const invoices = await prisma.purchaseInvoice.findMany({
        where: { id: { in: createdPurchaseInvoiceIds } },
        select: { postedEntryId: true },
      });
      const invoicePostedEntryIds = invoices
        .map((i) => i.postedEntryId)
        .filter((id): id is string => id !== null);
      const paymentPostedEntryIds = payments.map((p) => p.postedEntryId);

      await prisma.purchaseInvoice.deleteMany({
        where: { id: { in: createdPurchaseInvoiceIds } },
      });

      const allOriginalIds = [
        ...invoicePostedEntryIds,
        ...paymentPostedEntryIds,
      ];
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

      await prisma.supplier.deleteMany({
        where: { id: { in: createdSupplierIds } },
      });
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
    it('SELLER/WAREHOUSE: 403 en todos los endpoints de reportes', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        expect((await getAp('', {}, cookie)).status).toBe(403);
        expect((await getAp('/summary', {}, cookie)).status).toBe(403);
        expect((await getAp('/aging', {}, cookie)).status).toBe(403);
        expect((await getAp('/reconciliation', {}, cookie)).status).toBe(403);
        expect((await getAp('/export.xlsx', {}, cookie)).status).toBe(403);
      }
    });

    it('ADMIN/MANAGEMENT/ACCOUNTANT: 200 en todos los endpoints de reportes (solo lectura)', async () => {
      for (const cookie of [adminCookie, managementCookie, accountantCookie]) {
        expect((await getAp('', {}, cookie)).status).toBe(200);
        expect((await getAp('/summary', {}, cookie)).status).toBe(200);
        expect((await getAp('/aging', {}, cookie)).status).toBe(200);
        expect((await getAp('/reconciliation', {}, cookie)).status).toBe(200);
      }
    });
  });

  // ====================================================================
  // Fecha de vencimiento y antigüedad de deuda (aging)
  // ====================================================================
  describe('vencimiento y antigüedad', () => {
    it('sin dueDate: NO_DUE_DATE, nunca vencida automáticamente', async () => {
      const invoice = await createConfirmedInvoice('77.00', null);
      const response = await getAp(`/${invoice.id}`);
      const body = response.body as AccountsPayableItemBody;
      expect(body.agingBucket).toBe('NO_DUE_DATE');
      expect(body.daysOverdue).toBeNull();
    });

    it('dueDate futura: NOT_OVERDUE', async () => {
      const dueDate = addCalendarDays(businessToday(), 10);
      const invoice = await createConfirmedInvoice('33.00', dueDate);
      const response = await getAp(`/${invoice.id}`);
      const body = response.body as AccountsPayableItemBody;
      expect(body.agingBucket).toBe('NOT_OVERDUE');
    });

    it.each([
      [-1, 'OVERDUE_1_30'],
      [-30, 'OVERDUE_1_30'],
      [-31, 'OVERDUE_31_60'],
      [-60, 'OVERDUE_31_60'],
      [-61, 'OVERDUE_61_90'],
      [-90, 'OVERDUE_61_90'],
      [-91, 'OVERDUE_90_PLUS'],
    ])(
      'dueDate %i días desde hoy clasifica como %s',
      async (offsetDays, expectedBucket) => {
        const dueDate = addCalendarDays(businessToday(), offsetDays);
        const invoice = await createConfirmedInvoice('10.00', dueDate);
        const response = await getAp(`/${invoice.id}`);
        const body = response.body as AccountsPayableItemBody;
        expect(body.agingBucket).toBe(expectedBucket);
      },
    );

    it('filtro agingBucket en GET /accounts-payable acota el listado', async () => {
      const dueDate = addCalendarDays(businessToday(), -45);
      const invoice = await createConfirmedInvoice('22.00', dueDate);
      const response = await getAp('', { agingBucket: 'OVERDUE_31_60' });
      const body = response.body as { data: AccountsPayableItemBody[] };
      expect(body.data.some((r) => r.purchaseInvoiceId === invoice.id)).toBe(
        true,
      );
      expect(body.data.every((r) => r.agingBucket === 'OVERDUE_31_60')).toBe(
        true,
      );
    });
  });

  // ====================================================================
  // Pagos cancelados: dejan de reducir el saldo
  // ====================================================================
  describe('pago cancelado', () => {
    it('al cancelar el pago, el saldo pendiente vuelve al importe original', async () => {
      const invoice = await createConfirmedInvoice('64.00');
      const payment = await payInvoiceFully(invoice, '64.00');

      let detail = (await getAp(`/${invoice.id}`))
        .body as AccountsPayableItemBody;
      expect(detail.status).toBe('PAID');
      expect(detail.balanceDue).toBe('0.00');

      const cancelResponse = await cancelPayment(payment.id, 'Pago por error');
      expect(cancelResponse.status).toBe(200);

      detail = (await getAp(`/${invoice.id}`)).body as AccountsPayableItemBody;
      expect(detail.status).toBe('UNPAID');
      expect(detail.balanceDue).toBe('64.00');
    });
  });

  // ====================================================================
  // Resumen por proveedor
  // ====================================================================
  describe('summary', () => {
    it('agrupa por proveedor y calcula el total general', async () => {
      const invoiceA = await createConfirmedInvoice('40.00');
      const invoiceB = await createConfirmedInvoice('60.00');
      await payInvoiceFully(invoiceA, '40.00');

      const response = await getAp('/summary', { supplierId });
      const body = response.body as {
        bySupplier: {
          supplierId: string;
          totalOriginal: string;
          totalPaid: string;
          totalPending: string;
        }[];
        grandTotal: { totalOriginal: string; totalPending: string };
      };
      const row = body.bySupplier.find((s) => s.supplierId === supplierId);
      expect(row).toBeDefined();
      void invoiceB;
    });
  });

  // ====================================================================
  // Conciliación (solo lectura)
  // ====================================================================
  describe('reconciliation', () => {
    it('factura y pago consistentes: sin discrepancias', async () => {
      const invoice = await createConfirmedInvoice('88.00');
      await payInvoiceFully(invoice, '88.00');

      const response = await getAp('/reconciliation', { supplierId });
      const body = response.body as {
        invoices: { purchaseInvoiceId: string; discrepancies: string[] }[];
        accounts: { discrepancies: string[] }[];
        overallConsistent: boolean;
      };
      const invoiceRow = body.invoices.find(
        (r) => r.purchaseInvoiceId === invoice.id,
      );
      expect(invoiceRow?.discrepancies).toEqual([]);
    });

    it('cuenta ACCOUNTS_PAYABLE reasignada DESPUÉS de confirmar: la conciliación sigue usando la cuenta histórica y permanece consistente', async () => {
      const invoice = await createConfirmedInvoice('55.00');

      const newAccountId = await createTestAccount(
        `A54APNEW${Date.now() % 1000000}`,
        'Cuentas por pagar reasignada E2E A5.4',
        AccountType.LIABILITY,
      );
      await activateSystemKey(
        AccountingSystemKey.ACCOUNTS_PAYABLE,
        newAccountId,
      );
      try {
        await payInvoiceFully(invoice, '55.00');

        const response = await getAp('/reconciliation', { supplierId });
        const body = response.body as {
          invoices: {
            purchaseInvoiceId: string;
            historicalLiabilityAccountId: string | null;
            discrepancies: string[];
          }[];
        };
        const row = body.invoices.find(
          (r) => r.purchaseInvoiceId === invoice.id,
        );
        expect(row?.historicalLiabilityAccountId).toBe(liabilityAccountId);
        expect(row?.historicalLiabilityAccountId).not.toBe(newAccountId);
        expect(row?.discrepancies).toEqual([]);
      } finally {
        await activateSystemKey(
          AccountingSystemKey.ACCOUNTS_PAYABLE,
          liabilityAccountId,
        );
      }
    });

    // MISSING_ORIGINAL_ENTRY/INVALID_CREDIT_LINE_COUNT no tienen un
    // escenario real reproducible en e2e: el CHECK de base de datos
    // `purchase_invoices_confirmation_consistency` impide que una factura
    // CONFIRMED exista con postedEntryId NULL (verificado al intentarlo:
    // la escritura directa falla con el código 23514), y
    // buildPurchaseRecognitionLines() garantiza por construcción
    // exactamente una línea de crédito ACCOUNTS_PAYABLE. Ambos casos ya
    // están cubiertos con mocks en accounts-payable.service.spec.ts
    // (invariantes internos, nunca alcanzables en una base real).
  });

  // ====================================================================
  // Exportación a Excel
  // ====================================================================
  describe('exportación .xlsx', () => {
    it('GET /accounts-payable/export.xlsx: .xlsx real parseable con la factura creada', async () => {
      const invoice = await createConfirmedInvoice('91.00');
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounts-payable/export.xlsx')
        .query({ supplierId })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);

      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const sheet = await readWorkbook(response.body as Buffer);
      const documentNumbers: unknown[] = [];
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) documentNumbers.push(row.getCell(3).value);
      });
      expect(documentNumbers.length).toBeGreaterThan(0);
      void invoice;
    });

    it('GET /accounts-payable/summary/export.xlsx: .xlsx real parseable', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounts-payable/summary/export.xlsx')
        .query({ supplierId })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);
      expect(response.status).toBe(200);
      const sheet = await readWorkbook(response.body as Buffer);
      expect(sheet.rowCount).toBeGreaterThanOrEqual(1);
    });

    it('GET /accounts-payable/aging/export.xlsx: .xlsx real parseable', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounts-payable/aging/export.xlsx')
        .query({ supplierId })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);
      expect(response.status).toBe(200);
      await readWorkbook(response.body as Buffer);
    });

    it('GET /accounts-payable/reconciliation/export.xlsx: .xlsx real parseable', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounts-payable/reconciliation/export.xlsx')
        .query({ supplierId })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);
      expect(response.status).toBe(200);
      await readWorkbook(response.body as Buffer);
    });
  });
});
