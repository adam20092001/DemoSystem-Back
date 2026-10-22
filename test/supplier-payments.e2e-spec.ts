import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  PrismaClient,
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
 * Fase A5.3 — Cuentas por pagar y pagos a proveedores. Suite dedicada y
 * aislada (mismo criterio que purchase-invoices.e2e-spec.ts/
 * purchase-receipts.e2e-spec.ts): limpia exclusivamente por los ids que
 * ella misma crea. Usa líneas de factura SERVICE (sin productId) para no
 * necesitar fixtures de Category/Unit/Product/Inventario — A5.3 nunca
 * toca inventario.
 */

interface SafeSupplierPaymentBody {
  id: string;
  supplierId: string;
  amount: string;
  status: 'ACTIVE' | 'CANCELLED';
  postedEntryId: string;
  allocations: { purchaseInvoiceId: string; amount: string }[];
}

interface SafePurchaseInvoiceBody {
  id: string;
  supplierId: string;
  status: string;
  totalAmount: string;
  postedEntryId: string | null;
  lines: { id: string }[];
}

interface AccountsPayableItemBody {
  purchaseInvoiceId: string;
  paidAmount: string;
  balanceDue: string;
  status: 'UNPAID' | 'PARTIALLY_PAID' | 'PAID';
}

interface AccountsPayableDetailBody extends AccountsPayableItemBody {
  payments: {
    supplierPaymentId: string;
    status: 'ACTIVE' | 'CANCELLED';
    amountApplied: string;
  }[];
}

interface SafeAccountBody {
  id: string;
}

const ACCOUNTANT_USERNAME = 'e2e_a53_accountant';
const MANAGEMENT_USERNAME = 'e2e_a53_management';
const SELLER_USERNAME = 'e2e_a53_seller';
const WAREHOUSE_USERNAME = 'e2e_a53_warehouse';
const FIXTURE_PASSWORD = 'E2eA53Fixture2026Aa';
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('Supplier Payments — Fase A5.3 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let supplierAId: string;
  let supplierBId: string;
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

  function registerPayment(
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/supplier-payments')
      .set('Cookie', cookie)
      .send(body);
  }

  function getPayment(
    id: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/supplier-payments/${id}`)
      .set('Cookie', cookie);
  }

  function listPayments(
    query: Record<string, string> = {},
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/supplier-payments')
      .query(query)
      .set('Cookie', cookie);
  }

  function cancelPayment(
    id: string,
    reason: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/supplier-payments/${id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  function listAccountsPayable(
    query: Record<string, string> = {},
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounts-payable')
      .query(query)
      .set('Cookie', cookie);
  }

  function getApDetail(
    invoiceId: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/accounts-payable/${invoiceId}`)
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
    const created = response.body as SafeAccountBody;
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

  function validSupplierBody(): Record<string, unknown> {
    const suffix = nextSuffix();
    return {
      documentType: SupplierDocumentType.RUC,
      documentNumber: suffix.slice(-11).padStart(11, '0'),
      legalName: `Proveedor E2E A5.3 ${suffix}`,
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

  /** Factura CONFIRMED con UNA línea SERVICE (sin productId, sin inventario), monto = unitCost. */
  async function createConfirmedInvoice(
    unitCost: string,
    supplierId: string = supplierAId,
  ): Promise<SafePurchaseInvoiceBody> {
    const suffix = nextSuffix();
    const draft = await createInvoice({
      supplierId,
      documentType: PurchaseInvoiceDocumentType.FACTURA,
      documentSeries: 'F900',
      documentNumber: suffix.slice(-8),
      issueDate: businessToday(),
      lines: [
        {
          description: 'Servicio de prueba E2E A5.3',
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

  async function createDefaultPayment(
    supplierId: string,
    allocations: { purchaseInvoiceId: string; amount: string }[],
    overrides: Record<string, unknown> = {},
  ): Promise<SafeSupplierPaymentBody> {
    const amount = allocations
      .reduce((sum, a) => sum + Number(a.amount), 0)
      .toFixed(2);
    const response = await registerPayment({
      supplierId,
      amount,
      method: 'CASH',
      allocations,
      ...overrides,
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
      email: 'e2e_a53_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_a53_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a53_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a53_warehouse@demosystem.test',
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
      `A53AP${shortSuffix}`,
      'Cuentas por pagar sintética E2E A5.3',
      AccountType.LIABILITY,
    );
    await activateSystemKey(
      AccountingSystemKey.ACCOUNTS_PAYABLE,
      liabilityAccountId,
    );
    const opexAccountId = await createTestAccount(
      `A53OPEX${shortSuffix}`,
      'Gasto operativo sintético E2E A5.3',
      AccountType.EXPENSE,
    );
    await activateSystemKey(
      AccountingSystemKey.PURCHASE_OPERATING_EXPENSE,
      opexAccountId,
    );

    supplierAId = await createSupplier();
    supplierBId = await createSupplier();
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
    it('SELLER/WAREHOUSE: 403 en todos los endpoints', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        expect((await listPayments({}, cookie)).status).toBe(403);
        expect((await getPayment(NON_EXISTENT_UUID, cookie)).status).toBe(403);
        expect(
          (
            await registerPayment(
              {
                supplierId: supplierAId,
                amount: '1.00',
                method: 'CASH',
                allocations: [
                  { purchaseInvoiceId: NON_EXISTENT_UUID, amount: '1.00' },
                ],
              },
              cookie,
            )
          ).status,
        ).toBe(403);
        expect(
          (await cancelPayment(NON_EXISTENT_UUID, 'motivo', cookie)).status,
        ).toBe(403);
        expect((await listAccountsPayable({}, cookie)).status).toBe(403);
        expect((await getApDetail(NON_EXISTENT_UUID, cookie)).status).toBe(403);
      }
    });

    it('MANAGEMENT/ACCOUNTANT: leen (200) pero nunca escriben (403)', async () => {
      for (const cookie of [managementCookie, accountantCookie]) {
        expect((await listPayments({}, cookie)).status).toBe(200);
        expect((await listAccountsPayable({}, cookie)).status).toBe(200);
        expect(
          (
            await registerPayment(
              {
                supplierId: supplierAId,
                amount: '1.00',
                method: 'CASH',
                allocations: [
                  { purchaseInvoiceId: NON_EXISTENT_UUID, amount: '1.00' },
                ],
              },
              cookie,
            )
          ).status,
        ).toBe(403);
        expect(
          (await cancelPayment(NON_EXISTENT_UUID, 'motivo', cookie)).status,
        ).toBe(403);
      }
    });
  });

  // ====================================================================
  // Pago completo / parcial y recálculo de saldo
  // ====================================================================
  describe('registro de pagos y saldo', () => {
    it('pago parcial: balanceDue/status recalculados; pago posterior completa el saldo', async () => {
      const invoice = await createConfirmedInvoice('100.00');

      const first = await createDefaultPayment(supplierAId, [
        { purchaseInvoiceId: invoice.id, amount: '40.00' },
      ]);
      expect(first.status).toBe('ACTIVE');

      let detail = (await getApDetail(invoice.id))
        .body as AccountsPayableDetailBody;
      expect(detail.paidAmount).toBe('40.00');
      expect(detail.balanceDue).toBe('60.00');
      expect(detail.status).toBe('PARTIALLY_PAID');

      await createDefaultPayment(supplierAId, [
        { purchaseInvoiceId: invoice.id, amount: '60.00' },
      ]);

      detail = (await getApDetail(invoice.id))
        .body as AccountsPayableDetailBody;
      expect(detail.paidAmount).toBe('100.00');
      expect(detail.balanceDue).toBe('0.00');
      expect(detail.status).toBe('PAID');
      expect(detail.payments).toHaveLength(2);
    });

    it('un pago distribuido entre DOS facturas del mismo proveedor: ambas quedan saldadas', async () => {
      const invoiceA = await createConfirmedInvoice('60.00');
      const invoiceB = await createConfirmedInvoice('40.00');

      await createDefaultPayment(supplierAId, [
        { purchaseInvoiceId: invoiceA.id, amount: '60.00' },
        { purchaseInvoiceId: invoiceB.id, amount: '40.00' },
      ]);

      const detailA = (await getApDetail(invoiceA.id))
        .body as AccountsPayableDetailBody;
      const detailB = (await getApDetail(invoiceB.id))
        .body as AccountsPayableDetailBody;
      expect(detailA.status).toBe('PAID');
      expect(detailB.status).toBe('PAID');
    });

    it('la suma de allocations debe ser exactamente igual a amount: 400 si no coincide', async () => {
      const invoice = await createConfirmedInvoice('100.00');
      const response = await registerPayment({
        supplierId: supplierAId,
        amount: '100.00',
        method: 'CASH',
        allocations: [{ purchaseInvoiceId: invoice.id, amount: '90.00' }],
      });
      expect(response.status).toBe(400);
    });

    it('factura de OTRO proveedor: 400, bloquea todo el pago', async () => {
      const invoiceOfB = await createConfirmedInvoice('50.00', supplierBId);
      const response = await registerPayment({
        supplierId: supplierAId,
        amount: '50.00',
        method: 'CASH',
        allocations: [{ purchaseInvoiceId: invoiceOfB.id, amount: '50.00' }],
      });
      expect(response.status).toBe(400);
    });

    it('factura DRAFT (no CONFIRMED): 409', async () => {
      const suffix = nextSuffix();
      const draft = await createInvoice({
        supplierId: supplierAId,
        documentType: PurchaseInvoiceDocumentType.FACTURA,
        documentSeries: 'F900',
        documentNumber: suffix.slice(-8),
        issueDate: businessToday(),
        lines: [
          {
            description: 'Servicio sin confirmar',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '20.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });
      createdPurchaseInvoiceIds.push((draft.body as { id: string }).id);
      const response = await registerPayment({
        supplierId: supplierAId,
        amount: '20.00',
        method: 'CASH',
        allocations: [
          {
            purchaseInvoiceId: (draft.body as { id: string }).id,
            amount: '20.00',
          },
        ],
      });
      expect(response.status).toBe(409);
    });

    it('overpayment: el monto supera el saldo pendiente: 409', async () => {
      const invoice = await createConfirmedInvoice('30.00');
      const response = await registerPayment({
        supplierId: supplierAId,
        amount: '31.00',
        method: 'CASH',
        allocations: [{ purchaseInvoiceId: invoice.id, amount: '31.00' }],
      });
      expect(response.status).toBe(409);
    });

    it('concurrencia real: dos pagos simultáneos que juntos excederían el saldo — exactamente uno gana', async () => {
      const invoice = await createConfirmedInvoice('100.00');
      const body = {
        supplierId: supplierAId,
        amount: '60.00',
        method: 'CASH',
        allocations: [{ purchaseInvoiceId: invoice.id, amount: '60.00' }],
      };
      const [first, second] = await Promise.all([
        registerPayment(body),
        registerPayment(body),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const winner = first.status === 201 ? first : second;
      createdSupplierPaymentIds.push(
        (winner.body as SafeSupplierPaymentBody).id,
      );

      const detail = (await getApDetail(invoice.id))
        .body as AccountsPayableDetailBody;
      expect(detail.paidAmount).toBe('60.00');
    });

    it('idempotencyKey ya usada: devuelve el MISMO pago, sin duplicar el asiento contable', async () => {
      const invoice = await createConfirmedInvoice('25.00');
      const idempotencyKey = `retry-${nextSuffix()}`;
      const body = {
        supplierId: supplierAId,
        amount: '25.00',
        method: 'CASH',
        allocations: [{ purchaseInvoiceId: invoice.id, amount: '25.00' }],
        idempotencyKey,
      };

      const firstResponse = await registerPayment(body);
      expect(firstResponse.status).toBe(201);
      const first = firstResponse.body as SafeSupplierPaymentBody;
      createdSupplierPaymentIds.push(first.id);

      const secondResponse = await registerPayment(body);
      expect(secondResponse.status).toBe(201);
      const second = secondResponse.body as SafeSupplierPaymentBody;
      expect(second.id).toBe(first.id);

      const entryCount = await prisma.accountingEntry.count({
        where: { sourceType: 'SUPPLIER_PAYMENT', sourceId: first.id },
      });
      expect(entryCount).toBe(1);
    });
  });

  // ====================================================================
  // Cancelación y reversión
  // ====================================================================
  describe('anulación', () => {
    it('camino feliz: revierte exactamente el asiento original, libera el saldo', async () => {
      const invoice = await createConfirmedInvoice('80.00');
      const payment = await createDefaultPayment(supplierAId, [
        { purchaseInvoiceId: invoice.id, amount: '80.00' },
      ]);

      let detail = (await getApDetail(invoice.id))
        .body as AccountsPayableDetailBody;
      expect(detail.status).toBe('PAID');

      const cancelResponse = await cancelPayment(
        payment.id,
        'Pago registrado por error',
      );
      expect(cancelResponse.status).toBe(200);
      expect((cancelResponse.body as SafeSupplierPaymentBody).status).toBe(
        'CANCELLED',
      );

      detail = (await getApDetail(invoice.id))
        .body as AccountsPayableDetailBody;
      expect(detail.paidAmount).toBe('0.00');
      expect(detail.balanceDue).toBe('80.00');
      expect(detail.status).toBe('UNPAID');
      expect(
        detail.payments.find((p) => p.supplierPaymentId === payment.id)?.status,
      ).toBe('CANCELLED');

      const original = await prisma.accountingEntry.findFirst({
        where: { sourceType: 'SUPPLIER_PAYMENT', sourceId: payment.id },
        include: { lines: true },
      });
      const reversal = await prisma.accountingEntry.findFirst({
        where: { reversesEntryId: original?.id },
        include: { lines: true },
      });
      expect(reversal).not.toBeNull();
    });

    it('doble anulación: 409', async () => {
      const invoice = await createConfirmedInvoice('15.00');
      const payment = await createDefaultPayment(supplierAId, [
        { purchaseInvoiceId: invoice.id, amount: '15.00' },
      ]);
      await cancelPayment(payment.id, 'primera anulación');
      const second = await cancelPayment(payment.id, 'segunda anulación');
      expect(second.status).toBe(409);
    });

    it('factura con un pago ACTIVE asignado: no se puede anular la factura (409)', async () => {
      const invoice = await createConfirmedInvoice('45.00');
      await createDefaultPayment(supplierAId, [
        { purchaseInvoiceId: invoice.id, amount: '45.00' },
      ]);

      const response = await cancelInvoice(invoice.id, 'motivo cualquiera');
      expect(response.status).toBe(409);
    });
  });

  // ====================================================================
  // Cuenta histórica
  // ====================================================================
  describe('cuenta de pasivo histórica', () => {
    it('ACCOUNTS_PAYABLE reasignado DESPUÉS de confirmar: el pago sigue debitando la cuenta ORIGINALMENTE acreditada', async () => {
      const invoice = await createConfirmedInvoice('70.00');

      const newAccountId = await createTestAccount(
        `A53APNEW${Date.now() % 1000000}`,
        'Cuentas por pagar reasignada E2E A5.3',
        AccountType.LIABILITY,
      );
      await activateSystemKey(
        AccountingSystemKey.ACCOUNTS_PAYABLE,
        newAccountId,
      );
      try {
        const payment = await createDefaultPayment(supplierAId, [
          { purchaseInvoiceId: invoice.id, amount: '70.00' },
        ]);

        const entry = await prisma.accountingEntry.findFirst({
          where: { sourceType: 'SUPPLIER_PAYMENT', sourceId: payment.id },
          include: { lines: true },
        });
        const debitLine = entry?.lines.find((l) =>
          l.debitAmount.greaterThan(0),
        );
        expect(debitLine?.accountId).toBe(liabilityAccountId);
        expect(debitLine?.accountId).not.toBe(newAccountId);
      } finally {
        await activateSystemKey(
          AccountingSystemKey.ACCOUNTS_PAYABLE,
          liabilityAccountId,
        );
      }
    });
  });

  // ====================================================================
  // Rollback contable
  // ====================================================================
  describe('rollback ante error contable', () => {
    it('falta la cuenta de sistema BANK: 500, no crea SupplierPayment ni asiento', async () => {
      const invoice = await createConfirmedInvoice('33.00');
      const bankAccount = await prisma.account.findUniqueOrThrow({
        where: { systemKey: AccountingSystemKey.BANK },
      });
      await prisma.account.delete({ where: { id: bankAccount.id } });

      try {
        const paymentsBefore = await prisma.supplierPayment.count();
        const entriesBefore = await prisma.accountingEntry.count();

        const response = await registerPayment({
          supplierId: supplierAId,
          amount: '33.00',
          method: 'TRANSFER',
          reference: 'OP-TEST-A53-ROLLBACK',
          allocations: [{ purchaseInvoiceId: invoice.id, amount: '33.00' }],
        });

        expect(response.status).toBe(500);
        expect(await prisma.supplierPayment.count()).toBe(paymentsBefore);
        expect(await prisma.accountingEntry.count()).toBe(entriesBefore);
      } finally {
        await prisma.account.create({
          data: {
            id: bankAccount.id,
            code: bankAccount.code,
            name: bankAccount.name,
            type: bankAccount.type,
            systemKey: bankAccount.systemKey,
            createdAt: bankAccount.createdAt,
          },
        });
      }
    });
  });
});
