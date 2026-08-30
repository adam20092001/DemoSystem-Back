import { INestApplication } from '@nestjs/common';
import {
  CustomerStage,
  CustomerStatus,
  CustomerType,
  Prisma,
  PrismaClient,
  RoleName,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { businessToday } from '../src/common/date/business-date';
import { deriveSalePaymentSummary } from '../src/sales/sale-calculator';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

const SELLER_USERNAME = 'e2e_seller_ar';
const SELLER_PASSWORD = 'SellerAr123456';
const OTHER_SELLER_USERNAME = 'e2e_otherseller_ar';
const OTHER_SELLER_PASSWORD = 'OtherSellerAr123456';
const MANAGEMENT_USERNAME = 'e2e_management_ar';
const MANAGEMENT_PASSWORD = 'ManagementAr123456';
const WAREHOUSE_USERNAME = 'e2e_warehouse_ar';
const WAREHOUSE_PASSWORD = 'WarehouseAr123456';

const TEST_GENERIC_CODE = 'PUBLIC_GENERAL';

const SAFE_RECEIVABLE_KEYS = [
  'saleId',
  'saleNumber',
  'customerId',
  'customerName',
  'customerDocumentNumber',
  'sellerId',
  'confirmedAt',
  'total',
  'paidAmount',
  'balanceDue',
  'paymentStatus',
  'daysOutstanding',
]
  .slice()
  .sort();

interface ReceivableItemBody {
  saleId: string;
  saleNumber: string;
  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;
  sellerId: string;
  confirmedAt: string;
  total: string;
  paidAmount: string;
  balanceDue: string;
  paymentStatus: SalePaymentStatus;
  daysOutstanding: number;
}

interface PaginatedBody<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

describe('Accounts Receivable (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let sellerCookie: string;
  let managementCookie: string;
  let warehouseCookie: string;
  let adminId: string;
  let sellerId: string;
  let otherSellerId: string;

  let personActive: { id: string; name: string };
  let genericCustomerId: string;

  const ownedSaleIds: string[] = [];
  const ownedCustomerIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_ar@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: OTHER_SELLER_USERNAME,
      email: 'e2e_otherseller_ar@demosystem.test',
      password: OTHER_SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_ar@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_ar@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });

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
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;

    adminId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      })
    ).id;
    sellerId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: SELLER_USERNAME },
      })
    ).id;
    otherSellerId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: OTHER_SELLER_USERNAME },
      })
    ).id;

    const customer = await prisma.customer.create({
      data: {
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        name: `Cliente Persona E2E AR ${nextSuffix()}`,
      },
    });
    ownedCustomerIds.push(customer.id);
    personActive = { id: customer.id, name: customer.name };

    const generic = await prisma.customer.upsert({
      where: { code: TEST_GENERIC_CODE },
      update: {
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
      create: {
        code: TEST_GENERIC_CODE,
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
    });
    genericCustomerId = generic.id;
  }, 120000);

  afterAll(async () => {
    try {
      if (ownedSaleIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: ownedSaleIds } },
        });
        await prisma.payment.deleteMany({
          where: { saleId: { in: ownedSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: ownedSaleIds } } });
      }
      if (ownedCustomerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Customer', entityId: { in: ownedCustomerIds } },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: ownedCustomerIds } },
        });
      }
      // Guarda explícita (nunca `deleteMany({ where: { id: variable } })`
      // desnudo): si `beforeAll` lanzó ANTES de asignar estas variables, un
      // `id: undefined` haría que Prisma omita la condición por completo —
      // deleteMany({}) borraría TODA la tabla, incluido el admin
      // sembrado compartido. Mismo criterio que los bloques
      // ownedSaleIds/ownedCustomerIds de arriba.
      if (genericCustomerId) {
        await prisma.customer.deleteMany({ where: { id: genericCustomerId } });
      }
      if (otherSellerId) {
        await prisma.user.deleteMany({ where: { id: otherSellerId } });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 60000);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  interface FixtureSaleOverrides {
    total?: string;
    paidAmount?: string;
    customerId?: string;
    customerIsGeneric?: boolean;
    customerType?: CustomerType | null;
    customerName?: string;
    customerDocumentNumber?: string | null;
    sellerId?: string;
    confirmedAt?: Date;
    status?: SaleStatus;
    cancelledAt?: Date | null;
    cancellationReason?: string | null;
    cancelledByUserId?: string | null;
  }

  async function createFixtureSale(overrides: FixtureSaleOverrides = {}) {
    const total = new Prisma.Decimal(overrides.total ?? '100.00');
    const paidAmount = new Prisma.Decimal(overrides.paidAmount ?? '0.00');
    const summary = deriveSalePaymentSummary(total, paidAmount);
    const number = `NV-ARE2E-${nextSuffix()}`;
    const isGeneric = overrides.customerIsGeneric ?? false;
    const status = overrides.status ?? SaleStatus.ACTIVE;
    const row = await prisma.sale.create({
      data: {
        number,
        status,
        paymentStatus: summary.paymentStatus,
        deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
        customerId: overrides.customerId ?? personActive.id,
        customerIsGeneric: isGeneric,
        customerType: isGeneric
          ? null
          : (overrides.customerType ?? CustomerType.PERSON),
        customerDocumentNumber: overrides.customerDocumentNumber ?? null,
        customerDocumentType: overrides.customerDocumentNumber
          ? 'DNI'
          : undefined,
        customerName: overrides.customerName ?? 'Cliente Fixture AR',
        sellerId: overrides.sellerId ?? adminId,
        subtotal: total,
        discountAmount: new Prisma.Decimal('0.00'),
        taxAmount: new Prisma.Decimal('0.00'),
        total,
        currencyCode: 'PEN',
        taxEnabled: false,
        taxRate: new Prisma.Decimal('18.00'),
        paidAmount: summary.paidAmount,
        balanceDue: summary.balanceDue,
        confirmedAt: overrides.confirmedAt ?? new Date(),
        cancelledAt:
          status === SaleStatus.CANCELLED
            ? (overrides.cancelledAt ?? new Date())
            : null,
        cancellationReason:
          status === SaleStatus.CANCELLED
            ? (overrides.cancellationReason ?? 'Anulación fixture AR')
            : null,
        cancelledByUserId:
          status === SaleStatus.CANCELLED
            ? (overrides.cancelledByUserId ?? adminId)
            : null,
      },
    });
    ownedSaleIds.push(row.id);
    return {
      id: row.id,
      number: row.number,
      total: total.toFixed(2),
      paidAmount: summary.paidAmount.toFixed(2),
      balanceDue: summary.balanceDue.toFixed(2),
      paymentStatus: summary.paymentStatus,
      confirmedAt: row.confirmedAt,
    };
  }

  async function listReceivables(
    cookie: string,
    query: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounts-receivable')
      .query(query)
      .set('Cookie', cookie);
  }

  // ==================================================================
  // Autenticación y roles
  // ==================================================================
  describe('autenticación y roles', () => {
    it('sin cookie → 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/accounts-receivable',
      );
      expect(response.status).toBe(401);
    });

    it('ADMIN/SELLER/MANAGEMENT → 200; WAREHOUSE → 403', async () => {
      const [admin, seller, management, warehouse] = await Promise.all([
        listReceivables(adminCookie),
        listReceivables(sellerCookie),
        listReceivables(managementCookie),
        listReceivables(warehouseCookie),
      ]);
      expect(admin.status).toBe(200);
      expect(seller.status).toBe(200);
      expect(management.status).toBe(200);
      expect(warehouse.status).toBe(403);
    });
  });

  // ==================================================================
  // Definición fija de cuenta por cobrar
  // ==================================================================
  describe('definición de cuenta por cobrar (status=ACTIVE AND balanceDue>0)', () => {
    it('incluye ACTIVE UNPAID y ACTIVE PARTIALLY_PAID; excluye ACTIVE PAID, CANCELLED con saldo histórico > 0, y venta de total 0', async () => {
      const unpaid = await createFixtureSale({
        total: '100.00',
        paidAmount: '0.00',
      });
      const partiallyPaid = await createFixtureSale({
        total: '100.00',
        paidAmount: '40.00',
      });
      const paid = await createFixtureSale({
        total: '100.00',
        paidAmount: '100.00',
      });
      const cancelledWithFrozenBalance = await createFixtureSale({
        total: '100.00',
        paidAmount: '40.00',
        status: SaleStatus.CANCELLED,
      });
      const zeroTotal = await createFixtureSale({
        total: '0.00',
        paidAmount: '0.00',
      });

      const response = await listReceivables(adminCookie, { limit: 100 });
      expect(response.status).toBe(200);
      const ids = (response.body as PaginatedBody<ReceivableItemBody>).data.map(
        (row) => row.saleId,
      );
      expect(ids).toContain(unpaid.id);
      expect(ids).toContain(partiallyPaid.id);
      expect(ids).not.toContain(paid.id);
      expect(ids).not.toContain(cancelledWithFrozenBalance.id);
      expect(ids).not.toContain(zeroTotal.id);
    });
  });

  // ==================================================================
  // Público general
  // ==================================================================
  describe('Público general nunca aparece', () => {
    it('venta genérica de total 0 y venta genérica totalmente pagada: ninguna aparece; sin filtro especial de cliente genérico en el servicio', async () => {
      const zero = await createFixtureSale({
        total: '0.00',
        paidAmount: '0.00',
        customerId: genericCustomerId,
        customerIsGeneric: true,
      });
      const fullyPaid = await createFixtureSale({
        total: '50.00',
        paidAmount: '50.00',
        customerId: genericCustomerId,
        customerIsGeneric: true,
      });

      const response = await listReceivables(adminCookie, { limit: 100 });
      const ids = (response.body as PaginatedBody<ReceivableItemBody>).data.map(
        (row) => row.saleId,
      );
      expect(ids).not.toContain(zero.id);
      expect(ids).not.toContain(fullyPaid.id);
    });
  });

  // ==================================================================
  // Cliente BLOCKED
  // ==================================================================
  describe('cliente BLOCKED', () => {
    it('una cuenta por cobrar real permanece visible aunque el cliente pase a BLOCKED después', async () => {
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente AR Mutable BLOCKED E2E ${nextSuffix()}`,
        },
      });
      ownedCustomerIds.push(customer.id);
      const sale = await createFixtureSale({
        total: '80.00',
        paidAmount: '20.00',
        customerId: customer.id,
      });
      await prisma.customer.update({
        where: { id: customer.id },
        data: { status: CustomerStatus.BLOCKED },
      });

      const response = await listReceivables(adminCookie, { limit: 100 });
      const ids = (response.body as PaginatedBody<ReceivableItemBody>).data.map(
        (row) => row.saleId,
      );
      expect(ids).toContain(sale.id);
    });
  });

  // ==================================================================
  // Filtros
  // ==================================================================
  describe('filtros', () => {
    it('customerId: solo devuelve la deuda de ese cliente', async () => {
      const other = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente AR Filtro E2E ${nextSuffix()}`,
        },
      });
      ownedCustomerIds.push(other.id);
      const target = await createFixtureSale({
        total: '30.00',
        paidAmount: '10.00',
        customerId: other.id,
      });
      const unrelated = await createFixtureSale({
        total: '30.00',
        paidAmount: '10.00',
      });

      const response = await listReceivables(adminCookie, {
        customerId: other.id,
        limit: 100,
      });
      const ids = (response.body as PaginatedBody<ReceivableItemBody>).data.map(
        (row) => row.saleId,
      );
      expect(ids).toContain(target.id);
      expect(ids).not.toContain(unrelated.id);
    });

    it('sellerId: sin restricción de propiedad para SELLER; filtrar por sellerId funciona para cualquier vendedor', async () => {
      const bySeller = await createFixtureSale({
        total: '30.00',
        paidAmount: '10.00',
        sellerId,
      });
      const byOtherSeller = await createFixtureSale({
        total: '30.00',
        paidAmount: '10.00',
        sellerId: otherSellerId,
      });

      // SELLER, sin filtro, ve ambas (sin restricción de propiedad).
      const unfiltered = await listReceivables(sellerCookie, { limit: 100 });
      const unfilteredIds = (
        unfiltered.body as PaginatedBody<ReceivableItemBody>
      ).data.map((row) => row.saleId);
      expect(unfilteredIds).toContain(bySeller.id);
      expect(unfilteredIds).toContain(byOtherSeller.id);

      const filtered = await listReceivables(sellerCookie, {
        sellerId: otherSellerId,
        limit: 100,
      });
      const filteredIds = (
        filtered.body as PaginatedBody<ReceivableItemBody>
      ).data.map((row) => row.saleId);
      expect(filteredIds).toContain(byOtherSeller.id);
      expect(filteredIds).not.toContain(bySeller.id);
    });

    it('confirmedFrom/confirmedTo: excluye fuera de rango; fecha inválida o invertida → 400', async () => {
      const inRange = await createFixtureSale({
        total: '20.00',
        confirmedAt: new Date('2026-04-15T12:00:00.000Z'),
      });
      const outOfRange = await createFixtureSale({
        total: '20.00',
        confirmedAt: new Date('2026-01-01T12:00:00.000Z'),
      });

      const response = await listReceivables(adminCookie, {
        confirmedFrom: '2026-04-01',
        confirmedTo: '2026-04-30',
        limit: 100,
      });
      const ids = (response.body as PaginatedBody<ReceivableItemBody>).data.map(
        (row) => row.saleId,
      );
      expect(ids).toContain(inRange.id);
      expect(ids).not.toContain(outOfRange.id);

      const invalidDate = await listReceivables(adminCookie, {
        confirmedFrom: 'no-es-fecha',
      });
      expect(invalidDate.status).toBe(400);

      const invertedRange = await listReceivables(adminCookie, {
        confirmedFrom: '2026-04-30',
        confirmedTo: '2026-04-01',
      });
      expect(invertedRange.status).toBe(400);
    });
  });

  // ==================================================================
  // Orden
  // ==================================================================
  describe('orden: confirmedAt ASC, id ASC (deuda más antigua primero)', () => {
    it('tres cuentas propias con confirmedAt controlado aparecen en orden ascendente', async () => {
      const oldest = await createFixtureSale({
        total: '10.00',
        confirmedAt: new Date('2026-02-01T12:00:00.000Z'),
      });
      const middle = await createFixtureSale({
        total: '10.00',
        confirmedAt: new Date('2026-02-10T12:00:00.000Z'),
      });
      const newest = await createFixtureSale({
        total: '10.00',
        confirmedAt: new Date('2026-02-20T12:00:00.000Z'),
      });

      const response = await listReceivables(adminCookie, {
        confirmedFrom: '2026-02-01',
        confirmedTo: '2026-02-20',
        limit: 100,
      });
      const ids = (response.body as PaginatedBody<ReceivableItemBody>).data.map(
        (row) => row.saleId,
      );
      const ownPositions = [oldest.id, middle.id, newest.id].map((id) =>
        ids.indexOf(id),
      );
      expect(ownPositions[0]).toBeLessThan(ownPositions[1]);
      expect(ownPositions[1]).toBeLessThan(ownPositions[2]);
    });
  });

  // ==================================================================
  // daysOutstanding
  // ==================================================================
  describe('daysOutstanding', () => {
    it('confirmada hoy → 0; ayer → 1; más antigua → diferencia exacta de calendario', async () => {
      const todayDate = new Date();
      const yesterday = new Date(todayDate.getTime() - 24 * 60 * 60 * 1000);
      const tenDaysAgo = new Date(
        todayDate.getTime() - 10 * 24 * 60 * 60 * 1000,
      );

      const today = await createFixtureSale({
        total: '10.00',
        confirmedAt: todayDate,
      });
      const oneDayAgo = await createFixtureSale({
        total: '10.00',
        confirmedAt: yesterday,
      });
      const tenDays = await createFixtureSale({
        total: '10.00',
        confirmedAt: tenDaysAgo,
      });

      const response = await listReceivables(adminCookie, { limit: 100 });
      const rows = (response.body as PaginatedBody<ReceivableItemBody>).data;
      const byId = new Map(rows.map((row) => [row.saleId, row]));
      // América/Lima es UTC-5 fijo (sin horario de verano), así que restar
      // exactamente N*24h en tiempo UTC real siempre desplaza la fecha de
      // calendario de Lima en exactamente N días, sin importar la hora de
      // reloj en que corra la prueba: no hace falta ninguna tolerancia.
      expect(byId.get(today.id)?.daysOutstanding).toBe(0);
      expect(byId.get(oneDayAgo.id)?.daysOutstanding).toBe(1);
      expect(byId.get(tenDays.id)?.daysOutstanding).toBe(10);
    });

    it('confirmedAt futura/corrupta nunca produce un valor negativo', async () => {
      const future = new Date(Date.now() + 5 * 24 * 60 * 60 * 1000);
      const sale = await createFixtureSale({
        total: '10.00',
        confirmedAt: future,
      });

      const response = await listReceivables(adminCookie, { limit: 100 });
      const rows = (response.body as PaginatedBody<ReceivableItemBody>).data;
      const row = rows.find((r) => r.saleId === sale.id);
      expect(row?.daysOutstanding).toBe(0);
    });
  });

  // ==================================================================
  // Paginación
  // ==================================================================
  describe('paginación', () => {
    it('page/limit por defecto, explícitos, total, totalPages, página vacía', async () => {
      const defaultResponse = await listReceivables(adminCookie);
      const defaultBody =
        defaultResponse.body as PaginatedBody<ReceivableItemBody>;
      expect(defaultBody.page).toBe(1);
      expect(defaultBody.limit).toBe(20);

      await createFixtureSale({ total: '10.00' });
      await createFixtureSale({ total: '10.00' });

      const explicit = await listReceivables(adminCookie, {
        page: 1,
        limit: 1,
      });
      const explicitBody = explicit.body as PaginatedBody<ReceivableItemBody>;
      expect(explicitBody.limit).toBe(1);
      expect(explicitBody.data).toHaveLength(1);
      expect(explicitBody.total).toBeGreaterThanOrEqual(2);
      expect(explicitBody.totalPages).toBeGreaterThanOrEqual(2);

      const empty = await listReceivables(adminCookie, {
        page: 999999,
        limit: 20,
      });
      const emptyBody = empty.body as PaginatedBody<ReceivableItemBody>;
      expect(emptyBody.data).toEqual([]);
    });
  });

  // ==================================================================
  // Contrato seguro
  // ==================================================================
  describe('contrato seguro (ReceivableItem)', () => {
    it('claves exactas; sin Customer.status/notas internas/payments/referencias/inventario/Quote/AuditLog', async () => {
      const sale = await createFixtureSale({
        total: '55.00',
        paidAmount: '20.00',
        customerDocumentNumber: `ARDOC${nextSuffix()}`,
      });
      const response = await listReceivables(adminCookie, { limit: 100 });
      const rows = (response.body as PaginatedBody<ReceivableItemBody>).data;
      const row = rows.find((r) => r.saleId === sale.id);
      expect(row).toBeDefined();
      expect(Object.keys(row as object).sort()).toEqual(SAFE_RECEIVABLE_KEYS);
      expect(row?.total).toBe('55.00');
      expect(row?.paidAmount).toBe('20.00');
      expect(row?.balanceDue).toBe('35.00');

      const serialized = JSON.stringify(row);
      expect(serialized).not.toMatch(
        /customerStatus|"status":"BLOCKED"|"status":"INACTIVE"/,
      );
      expect(serialized).not.toMatch(/internalNotes/i);
      expect(serialized).not.toMatch(/"payments"|paymentId|paymentMethod/i);
      expect(serialized).not.toMatch(/reference/i);
      expect(serialized).not.toMatch(/inventoryMovement/i);
      expect(serialized).not.toMatch(/quoteId|quoteNumber/i);
      expect(serialized).not.toMatch(/auditLog/i);
    });
  });

  // ==================================================================
  // Sin auditoría de lectura
  // ==================================================================
  describe('sin auditoría de lectura', () => {
    it('GET /accounts-receivable no crea ningún AuditLog', async () => {
      const before = await prisma.auditLog.count();
      await listReceivables(adminCookie, { limit: 100 });
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // businessToday sanity (mismo criterio de fecha de negocio que el servicio)
  // ==================================================================
  describe('coherencia con businessToday()', () => {
    it('businessToday() no lanza y produce YYYY-MM-DD', () => {
      expect(businessToday()).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    });
  });
});
