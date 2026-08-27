import { INestApplication } from '@nestjs/common';
import {
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  PaymentCancellationSource,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  PrismaClient,
  RoleName,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { deriveSalePaymentSummary } from '../src/sales/sale-calculator';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

// Usuarios propios del spec (no comparte fixtures de sales.e2e-spec.ts: cada
// archivo e2e es autosuficiente, mismo criterio que el resto del repo).
const SELLER_USERNAME = 'e2e_seller_payments';
const SELLER_PASSWORD = 'SellerPayments123';
const MANAGEMENT_USERNAME = 'e2e_management_payments';
const MANAGEMENT_PASSWORD = 'ManagementPayments123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_payments';
const WAREHOUSE_PASSWORD = 'WarehousePayments123';
// Actores efímeros exclusivos de las pruebas de FK RESTRICT (§71): nunca se
// reutilizan los actores compartidos admin/seller/management/warehouse.
const FK_CREATOR_USERNAME = 'e2e_fkcreator_payments';
const FK_CREATOR_PASSWORD = 'FkCreatorPayments123';
const FK_CANCELLER_USERNAME = 'e2e_fkcanceller_payments';
const FK_CANCELLER_PASSWORD = 'FkCancellerPayments123';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const INVALID_UUID = 'not-a-uuid';
const TEST_GENERIC_CODE = 'PUBLIC_GENERAL';

const SAFE_PAYMENT_USER_KEYS = ['id', 'username', 'firstName', 'lastName']
  .slice()
  .sort();

const SAFE_PAYMENT_KEYS = [
  'id',
  'saleId',
  'method',
  'amount',
  'reference',
  'status',
  'paidAt',
  'createdBy',
  'cancelledAt',
  'cancellationReason',
  'cancellationSource',
  'cancelledBy',
  'createdAt',
  'updatedAt',
]
  .slice()
  .sort();

interface SafePaymentUserBody {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

interface SafePaymentBody {
  id: string;
  saleId: string;
  method: PaymentMethod;
  amount: string;
  reference: string | null;
  status: PaymentStatus;
  paidAt: string;
  createdBy: SafePaymentUserBody;
  cancelledAt: string | null;
  cancellationReason: string | null;
  cancellationSource: PaymentCancellationSource | null;
  cancelledBy: SafePaymentUserBody | null;
  createdAt: string;
  updatedAt: string;
}

interface SalePaymentSummaryBody {
  id: string;
  number: string;
  status: SaleStatus;
  total: string;
  paidAmount: string;
  balanceDue: string;
  paymentStatus: SalePaymentStatus;
}

interface PaymentMutationBody {
  payment: SafePaymentBody;
  sale: SalePaymentSummaryBody;
}

interface PaginatedBody<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface FixtureSale {
  id: string;
  number: string;
  total: string;
  paidAmount: string;
  balanceDue: string;
  paymentStatus: SalePaymentStatus;
}

describe('Payments (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let sellerCookie: string;
  let managementCookie: string;
  let warehouseCookie: string;
  let fkCreatorCookie: string;
  let fkCancellerCookie: string;
  let adminId: string;
  let sellerId: string;
  let fkCreatorId: string;
  let fkCancellerId: string;

  let personActive: { id: string; name: string };
  let genericCustomerId: string;
  // Fase 8, Bloque B: SalesService.createDirect ahora postea un asiento de
  // reconocimiento contable ORIGINAL para toda venta con actividad
  // económica, dentro de la MISMA transacción. Este spec crea sus ventas
  // fixture directamente vía Prisma (bypass total de SalesService, por
  // diseño de la Fase 7 Bloque D: la creación de Sale ya se prueba en
  // sales.e2e-spec.ts) — así que createFixtureSale() debe replicar ese
  // mismo asiento a mano, o la anulación real de la venta (que si pasa por
  // SalesService.cancel -> AccountingEngine.reverseOriginalForSource)
  // fallaría con un invariante roto: "no existe un ORIGINAL que revertir",
  // un estado que nunca podría ocurrir en operación real (ver AR_ACCOUNT_ID/
  // SALES_ACCOUNT_ID más abajo).
  let arAccountId: string;
  let salesAccountId: string;

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
      email: 'e2e_seller_payments@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_payments@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_payments@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: FK_CREATOR_USERNAME,
      email: 'e2e_fkcreator_payments@demosystem.test',
      password: FK_CREATOR_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: FK_CANCELLER_USERNAME,
      email: 'e2e_fkcanceller_payments@demosystem.test',
      password: FK_CANCELLER_PASSWORD,
      roleName: RoleName.ADMIN,
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
    fkCreatorCookie = (
      await login(app.getHttpServer(), FK_CREATOR_USERNAME, FK_CREATOR_PASSWORD)
    ).cookie;
    fkCancellerCookie = (
      await login(
        app.getHttpServer(),
        FK_CANCELLER_USERNAME,
        FK_CANCELLER_PASSWORD,
      )
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
    fkCreatorId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: FK_CREATOR_USERNAME },
      })
    ).id;
    fkCancellerId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: FK_CANCELLER_USERNAME },
      })
    ).id;

    // ---------------------------------------------------------------
    // Clientes fixture. Sale no requiere SaleItem/Product/Category/Unit:
    // este spec ejercita exclusivamente el dominio de Pagos sobre ventas ya
    // confirmadas, así que las ventas fixture se insertan directamente vía
    // Prisma (mismo criterio que directValidSale/rawInsertSale en
    // sales.e2e-spec.ts) en vez de recorrer todo el flujo POST /sales.
    // ---------------------------------------------------------------
    async function createCustomer(data: {
      customerType: CustomerType;
      status?: CustomerStatus;
      name: string;
    }) {
      const row = await prisma.customer.create({
        data: {
          customerType: data.customerType,
          customerStage: CustomerStage.CUSTOMER,
          status: data.status ?? CustomerStatus.ACTIVE,
          name: data.name,
        },
      });
      ownedCustomerIds.push(row.id);
      return { id: row.id, name: row.name };
    }

    personActive = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `Cliente Persona E2E Pagos ${nextSuffix()}`,
    });

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

    const arAccount = await prisma.account.findUniqueOrThrow({
      where: { systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE },
    });
    arAccountId = arAccount.id;
    const salesAccount = await prisma.account.findUniqueOrThrow({
      where: { systemKey: AccountingSystemKey.SALES_REVENUE },
    });
    salesAccountId = salesAccount.id;
  }, 120000);

  afterAll(async () => {
    try {
      // Limpieza dirigida por los IDs de Sale propios: primero AuditLog de
      // Payment (por los IDs de pago encontrados vía saleId), luego los
      // propios Payment (FK RESTRICT hacia Sale), luego AuditLog de Sale,
      // luego Sale. Nunca deleteMany({}) global.
      if (ownedSaleIds.length > 0) {
        const ownedPayments = await prisma.payment.findMany({
          where: { saleId: { in: ownedSaleIds } },
          select: { id: true },
        });
        const ownedPaymentIds = ownedPayments.map((p) => p.id);
        if (ownedPaymentIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: { entityType: 'Payment', entityId: { in: ownedPaymentIds } },
          });
        }
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: ownedSaleIds } },
        });

        // Fase 8, Bloque B: cada Sale/Payment propio puede tener asientos
        // contables (ORIGINAL de createFixtureSale / PaymentEngine.register,
        // REVERSAL de una anulación real durante la prueba). Se retiran
        // ANTES de borrar Sale/Payment (sin FK entre ambos, así que el
        // orden relativo a esos dos no importa) y ANTES de los actores
        // efímeros de FK más abajo (accounting_entries.created_by_user_id
        // es RESTRICT). REVERSAL primero (self-FK reversesEntryId hacia su
        // ORIGINAL), luego ORIGINAL; las líneas se van solas por CASCADE.
        const accountingWhere = {
          OR: [
            { sourceType: 'SALE' as const, sourceId: { in: ownedSaleIds } },
            ...(ownedPaymentIds.length > 0
              ? [
                  {
                    sourceType: 'PAYMENT' as const,
                    sourceId: { in: ownedPaymentIds },
                  },
                ]
              : []),
          ],
        };
        await prisma.accountingEntry.deleteMany({
          where: { ...accountingWhere, eventType: 'REVERSAL' },
        });
        await prisma.accountingEntry.deleteMany({
          where: { ...accountingWhere, eventType: 'ORIGINAL' },
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
      await prisma.customer.deleteMany({ where: { id: genericCustomerId } });

      // Los actores efímeros de FK (§71) solo se eliminan tras retirar toda
      // Payment que los referencia (ya ocurrió arriba); nunca se tocan
      // admin/seller/management/warehouse compartidos.
      await prisma.user.deleteMany({ where: { id: fkCreatorId } });
      await prisma.user.deleteMany({ where: { id: fkCancellerId } });
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
    sellerId?: string;
    status?: SaleStatus;
  }

  /** Venta fixture mínima pero válida frente a las 18 CHECK de cabecera de `sales` (Fase 6). */
  async function createFixtureSale(
    overrides: FixtureSaleOverrides = {},
  ): Promise<FixtureSale> {
    const total = new Prisma.Decimal(overrides.total ?? '100.00');
    const paidAmount = new Prisma.Decimal(overrides.paidAmount ?? '0.00');
    const summary = deriveSalePaymentSummary(total, paidAmount);
    const number = `NV-PAYE2E-${nextSuffix()}`;
    const isGeneric = overrides.customerIsGeneric ?? false;
    const row = await prisma.sale.create({
      data: {
        number,
        status: overrides.status ?? SaleStatus.ACTIVE,
        paymentStatus: summary.paymentStatus,
        deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
        customerId: overrides.customerId ?? personActive.id,
        customerIsGeneric: isGeneric,
        customerType: isGeneric
          ? null
          : (overrides.customerType ?? CustomerType.PERSON),
        customerName: overrides.customerName ?? 'Cliente Fixture Pagos',
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
        confirmedAt: new Date(),
      },
    });
    ownedSaleIds.push(row.id);

    // Fase 8, Bloque B: replica a mano el asiento de reconocimiento que
    // SalesService.createDirect habría posteado en un flujo real (esta
    // fixture nunca pasa por SalesService — ver comentario en la
    // declaración de arAccountId/salesAccountId más arriba). Como
    // discountAmount/taxAmount son siempre 0.00 en este helper, el asiento
    // siempre es el caso A de buildSaleRecognitionLines: DEBIT AR=total,
    // CREDIT SALES=total. Solo cuando total>0 (siempre cierto hoy en este
    // archivo, pero se guarda la condición por fidelidad al invariante
    // real de AccountingEngine: sin actividad económica, sin ORIGINAL).
    if (total.greaterThan(0)) {
      const entry = await prisma.accountingEntry.create({
        data: {
          sourceType: AccountingSourceType.SALE,
          sourceId: row.id,
          eventType: AccountingEventType.ORIGINAL,
          description: `Venta ${row.number}`,
          postedAt: row.confirmedAt,
          createdByUserId: adminId,
        },
      });
      await prisma.accountingEntryLine.createMany({
        data: [
          {
            entryId: entry.id,
            accountId: arAccountId,
            debitAmount: total,
            creditAmount: new Prisma.Decimal(0),
          },
          {
            entryId: entry.id,
            accountId: salesAccountId,
            debitAmount: new Prisma.Decimal(0),
            creditAmount: total,
          },
        ],
      });
    }

    return {
      id: row.id,
      number: row.number,
      total: total.toFixed(2),
      paidAmount: summary.paidAmount.toFixed(2),
      balanceDue: summary.balanceDue.toFixed(2),
      paymentStatus: summary.paymentStatus,
    };
  }

  interface InsertPaymentOverrides {
    saleId: string;
    method?: PaymentMethod;
    amount: string;
    reference?: string | null;
    status?: PaymentStatus;
    paidAt?: Date;
    createdByUserId?: string;
    cancelledAt?: Date | null;
    cancellationReason?: string | null;
    cancelledByUserId?: string | null;
    cancellationSource?: PaymentCancellationSource | null;
  }

  /** Inserción directa de un Payment ya en el estado deseado, para fixtures que el flujo HTTP no puede producir por sí solo (p. ej. un pago perteneciente a OTRA venta). */
  async function insertPayment(overrides: InsertPaymentOverrides) {
    return prisma.payment.create({
      data: {
        saleId: overrides.saleId,
        method: overrides.method ?? PaymentMethod.CASH,
        amount: new Prisma.Decimal(overrides.amount),
        reference: overrides.reference ?? null,
        status: overrides.status ?? PaymentStatus.ACTIVE,
        paidAt: overrides.paidAt ?? new Date(),
        createdByUserId: overrides.createdByUserId ?? adminId,
        cancelledAt: overrides.cancelledAt ?? null,
        cancellationReason: overrides.cancellationReason ?? null,
        cancelledByUserId: overrides.cancelledByUserId ?? null,
        cancellationSource: overrides.cancellationSource ?? null,
      },
    });
  }

  async function registerPayment(
    cookie: string,
    saleId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function registerPaymentOrThrow(
    cookie: string,
    saleId: string,
    body: Record<string, unknown>,
  ): Promise<PaymentMutationBody> {
    const response = await registerPayment(cookie, saleId, body);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo registrar el pago fixture: ${JSON.stringify(response.body)}`,
      );
    }
    return response.body as PaymentMutationBody;
  }

  async function cancelPayment(
    cookie: string,
    saleId: string,
    paymentId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/${paymentId}/cancel`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function cancelSaleHttp(
    cookie: string,
    saleId: string,
    reason = 'Anulación fixture E2E de Pagos',
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  async function fetchAuditRows(
    action: AuditAction,
    entityId: string,
  ): Promise<
    { metadata: unknown; description: string; userId: string | null }[]
  > {
    return prisma.auditLog.findMany({
      where: { action, entityType: 'Payment', entityId },
    });
  }

  function assertNoLeakage(response: { body: unknown }): void {
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/prisma/i);
    expect(serialized).not.toMatch(/P2002/);
    expect(serialized).not.toMatch(/P2010/);
    expect(serialized).not.toMatch(/23505/);
    expect(serialized).not.toMatch(/23514/);
    expect(serialized).not.toMatch(/constraint/i);
    expect(serialized).not.toMatch(/payments_/);
    expect(serialized).not.toMatch(/at Object/);
  }

  interface RawPaymentOverrides {
    saleId: string;
    method?: PaymentMethod;
    amount?: string;
    reference?: string | null;
    status?: PaymentStatus;
    cancelledAt?: Date | null;
    cancellationReason?: string | null;
    cancelledByUserId?: string | null;
    cancellationSource?: PaymentCancellationSource | null;
  }

  /** INSERT crudo (bypass total de PaymentEngine) para verificar que PostgreSQL rechaza la fila mediante el CHECK indicado. */
  async function rawInsertPayment(
    overrides: RawPaymentOverrides,
  ): Promise<string> {
    const o = {
      method: PaymentMethod.CASH,
      amount: '10.00',
      reference: null as string | null,
      status: PaymentStatus.ACTIVE,
      cancelledAt: null as Date | null,
      cancellationReason: null as string | null,
      cancelledByUserId: null as string | null,
      cancellationSource: null as PaymentCancellationSource | null,
      ...overrides,
    };
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO payments
        (id, sale_id, method, amount, reference, status, paid_at,
         created_by_user_id, cancelled_at, cancellation_reason,
         cancelled_by_user_id, cancellation_source, created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${o.saleId}::uuid, ${o.method}::"PaymentMethod",
         ${o.amount}::numeric, ${o.reference}, ${o.status}::"PaymentStatus",
         now(), ${adminId}::uuid, ${o.cancelledAt}::timestamp,
         ${o.cancellationReason}, ${o.cancelledByUserId}::uuid,
         ${o.cancellationSource}::"PaymentCancellationSource", now(), now())
      RETURNING id
    `;
    return rows[0].id;
  }

  async function expectPgRejection(
    insert: () => Promise<unknown>,
    sqlstate: '23514' | '23505' | '23503',
  ): Promise<void> {
    let caught = false;
    try {
      await insert();
    } catch (error) {
      caught = true;
      const pgError = error as { code?: string; meta?: { code?: string } };
      expect(pgError.code).toBe('P2010');
      expect(pgError.meta?.code).toBe(sqlstate);
    }
    expect(caught).toBe(true);
  }

  async function expectClientFkRejection(
    op: () => Promise<unknown>,
  ): Promise<void> {
    let caught = false;
    try {
      await op();
    } catch (error) {
      caught = true;
      const prismaError = error as { code?: string };
      expect(prismaError.code).toBe('P2003');
    }
    expect(caught).toBe(true);
  }

  // ==================================================================
  // Autenticación
  // ==================================================================
  describe('autenticación', () => {
    it('sin cookie: los 3 endpoints de Pagos responden 401', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server)
          .post(`/api/v1/sales/${id}/payments`)
          .send({ method: 'CASH', amount: '10.00' }),
        request(server)
          .post(`/api/v1/sales/${id}/payments/${id}/cancel`)
          .send({ reason: 'x' }),
        request(server).get('/api/v1/payments'),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(401);
      }
    });

    it('sin cookie: GET /accounts-receivable responde 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/accounts-receivable',
      );
      expect(response.status).toBe(401);
    });
  });

  // ==================================================================
  // Validación de UUID
  // ==================================================================
  describe('validación de UUID', () => {
    it('saleId inválido en /payments → 400 sin ejecutar el servicio', async () => {
      const response = await registerPayment(adminCookie, INVALID_UUID, {
        method: 'CASH',
        amount: '10.00',
      });
      expect(response.status).toBe(400);
    });

    it('saleId inválido en /payments/:paymentId/cancel → 400', async () => {
      const response = await cancelPayment(
        adminCookie,
        INVALID_UUID,
        NON_EXISTENT_UUID,
        { reason: 'x' },
      );
      expect(response.status).toBe(400);
    });

    it('paymentId inválido en /payments/:paymentId/cancel → 400', async () => {
      const response = await cancelPayment(
        adminCookie,
        NON_EXISTENT_UUID,
        INVALID_UUID,
        { reason: 'x' },
      );
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // Rutas no soportadas
  // ==================================================================
  describe('rutas no soportadas', () => {
    it('GET/PATCH/PUT/DELETE de detalle de pago, y GET /sales/:id/payments, y POST /payments/:id/print → 404', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server)
          .get(`/api/v1/payments/${id}`)
          .set('Cookie', adminCookie),
        request(server)
          .patch(`/api/v1/payments/${id}`)
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .put(`/api/v1/payments/${id}`)
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .delete(`/api/v1/payments/${id}`)
          .set('Cookie', adminCookie),
        request(server)
          .get(`/api/v1/sales/${id}/payments`)
          .set('Cookie', adminCookie),
        request(server)
          .post(`/api/v1/payments/${id}/print`)
          .set('Cookie', adminCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
      }
    });
  });

  // ==================================================================
  // Matriz de roles HTTP
  // ==================================================================
  describe('matriz de roles HTTP', () => {
    it('registrar pago: ADMIN y SELLER permitidos; MANAGEMENT y WAREHOUSE 403', async () => {
      const saleAdmin = await createFixtureSale({ total: '10.00' });
      const saleSeller = await createFixtureSale({ total: '10.00' });
      const saleManagement = await createFixtureSale({ total: '10.00' });
      const saleWarehouse = await createFixtureSale({ total: '10.00' });

      const admin = await registerPayment(adminCookie, saleAdmin.id, {
        method: 'CASH',
        amount: '5.00',
      });
      expect(admin.status).toBe(201);

      const seller = await registerPayment(sellerCookie, saleSeller.id, {
        method: 'CASH',
        amount: '5.00',
      });
      expect(seller.status).toBe(201);

      const management = await registerPayment(
        managementCookie,
        saleManagement.id,
        { method: 'CASH', amount: '5.00' },
      );
      expect(management.status).toBe(403);

      const warehouse = await registerPayment(
        warehouseCookie,
        saleWarehouse.id,
        {
          method: 'CASH',
          amount: '5.00',
        },
      );
      expect(warehouse.status).toBe(403);
    });

    it('anular pago: solo ADMIN; SELLER/MANAGEMENT/WAREHOUSE 403', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const paymentId = created.payment.id;

      const seller = await cancelPayment(sellerCookie, sale.id, paymentId, {
        reason: 'x',
      });
      expect(seller.status).toBe(403);
      const management = await cancelPayment(
        managementCookie,
        sale.id,
        paymentId,
        { reason: 'x' },
      );
      expect(management.status).toBe(403);
      const warehouse = await cancelPayment(
        warehouseCookie,
        sale.id,
        paymentId,
        {
          reason: 'x',
        },
      );
      expect(warehouse.status).toBe(403);

      const admin = await cancelPayment(adminCookie, sale.id, paymentId, {
        reason: 'Anulación de prueba de rol',
      });
      expect(admin.status).toBe(200);
    });

    it('GET /payments: ADMIN/SELLER/MANAGEMENT 200; WAREHOUSE 403', async () => {
      const server = app.getHttpServer();
      const [admin, seller, management, warehouse] = await Promise.all([
        request(server).get('/api/v1/payments').set('Cookie', adminCookie),
        request(server).get('/api/v1/payments').set('Cookie', sellerCookie),
        request(server).get('/api/v1/payments').set('Cookie', managementCookie),
        request(server).get('/api/v1/payments').set('Cookie', warehouseCookie),
      ]);
      expect(admin.status).toBe(200);
      expect(seller.status).toBe(200);
      expect(management.status).toBe(200);
      expect(warehouse.status).toBe(403);
    });

    it('GET /accounts-receivable: ADMIN/SELLER/MANAGEMENT 200; WAREHOUSE 403', async () => {
      const server = app.getHttpServer();
      const [admin, seller, management, warehouse] = await Promise.all([
        request(server)
          .get('/api/v1/accounts-receivable')
          .set('Cookie', adminCookie),
        request(server)
          .get('/api/v1/accounts-receivable')
          .set('Cookie', sellerCookie),
        request(server)
          .get('/api/v1/accounts-receivable')
          .set('Cookie', managementCookie),
        request(server)
          .get('/api/v1/accounts-receivable')
          .set('Cookie', warehouseCookie),
      ]);
      expect(admin.status).toBe(200);
      expect(seller.status).toBe(200);
      expect(management.status).toBe(200);
      expect(warehouse.status).toBe(403);
    });
  });

  // ==================================================================
  // Validación HTTP del monto
  // ==================================================================
  describe('validación de monto (HTTP)', () => {
    it.each(['1', '1.5', '1.50', '999.99'])(
      'monto válido %s: 201, persiste con 2 decimales fijos',
      async (amount) => {
        const sale = await createFixtureSale({ total: '100000.00' });
        const response = await registerPayment(adminCookie, sale.id, {
          method: 'CASH',
          amount,
        });
        expect(response.status).toBe(201);
        const body = response.body as PaymentMutationBody;
        expect(body.payment.amount).toBe(new Prisma.Decimal(amount).toFixed(2));
      },
    );

    it.each([
      ['0', 'no positivo'],
      ['0.00', 'no positivo'],
      ['-1', 'signo negativo no permitido'],
      ['1e3', 'notación científica no permitida'],
      ['1E3', 'notación científica no permitida'],
      ['1,50', 'coma decimal no permitida'],
      ['+1', 'signo explícito no permitido'],
      ['', 'blanco'],
      ['   ', 'solo espacios'],
      ['1.500', 'más de 2 decimales'],
      ['9999999999999.99', 'desborda Decimal(14,2) (13 enteros)'],
    ])('monto inválido "%s" (%s) → 400, sin crear Payment', async (amount) => {
      const sale = await createFixtureSale({ total: '100.00' });
      const before = await prisma.payment.count({ where: { saleId: sale.id } });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount,
      });
      expect(response.status).toBe(400);
      const after = await prisma.payment.count({ where: { saleId: sale.id } });
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // Método de pago y referencia
  // ==================================================================
  describe('método de pago y referencia', () => {
    it.each([
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.BANK_DEPOSIT,
      PaymentMethod.CARD,
    ])('%s sin referencia (ausente) → 400', async (method) => {
      const sale = await createFixtureSale({ total: '100.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method,
        amount: '10.00',
      });
      expect(response.status).toBe(400);
    });

    it.each([
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.BANK_DEPOSIT,
      PaymentMethod.CARD,
    ])('%s con referencia solo espacios → 400', async (method) => {
      const sale = await createFixtureSale({ total: '100.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method,
        amount: '10.00',
        reference: '    ',
      });
      expect(response.status).toBe(400);
    });

    it.each([
      PaymentMethod.BANK_TRANSFER,
      PaymentMethod.BANK_DEPOSIT,
      PaymentMethod.CARD,
    ])('%s con referencia real → 201', async (method) => {
      const sale = await createFixtureSale({ total: '100.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method,
        amount: '10.00',
        reference: 'OP-000123',
      });
      expect(response.status).toBe(201);
      expect((response.body as PaymentMutationBody).payment.reference).toBe(
        'OP-000123',
      );
    });

    it.each([
      PaymentMethod.CASH,
      PaymentMethod.DIGITAL_WALLET,
      PaymentMethod.OTHER,
    ])('%s sin referencia → 201, reference persiste null', async (method) => {
      const sale = await createFixtureSale({ total: '100.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method,
        amount: '10.00',
      });
      expect(response.status).toBe(201);
      expect(
        (response.body as PaymentMutationBody).payment.reference,
      ).toBeNull();
    });

    it('CASH con referencia solo espacios → 201, se normaliza a null (trim)', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
        reference: '    ',
      });
      expect(response.status).toBe(201);
      expect(
        (response.body as PaymentMutationBody).payment.reference,
      ).toBeNull();
    });

    it('CASH con referencia "  OP-1  " → se persiste recortada "OP-1"', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
        reference: '  OP-1  ',
      });
      expect(response.status).toBe(201);
      expect((response.body as PaymentMutationBody).payment.reference).toBe(
        'OP-1',
      );
    });

    it('referencia de 100 caracteres: aceptada; 101: rechazada', async () => {
      const ref100 = 'R'.repeat(100);
      const ref101 = 'R'.repeat(101);
      const saleOk = await createFixtureSale({ total: '100.00' });
      const ok = await registerPayment(adminCookie, saleOk.id, {
        method: 'CASH',
        amount: '10.00',
        reference: ref100,
      });
      expect(ok.status).toBe(201);
      expect((ok.body as PaymentMutationBody).payment.reference).toBe(ref100);

      const saleBad = await createFixtureSale({ total: '100.00' });
      const bad = await registerPayment(adminCookie, saleBad.id, {
        method: 'CASH',
        amount: '10.00',
        reference: ref101,
      });
      expect(bad.status).toBe(400);
    });
  });

  // ==================================================================
  // Pago posterior — parcial y completo (fuente de verdad)
  // ==================================================================
  describe('pago posterior — parcial y completo', () => {
    it('venta 100/0/100 UNPAID: pago 40 → PARTIALLY_PAID, paid 40.00, balance 60.00; exactamente 1 pago ACTIVE y 1 auditoría', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const result = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(result.payment.status).toBe(PaymentStatus.ACTIVE);
      expect(result.payment.amount).toBe('40.00');
      expect(result.sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(result.sale.paidAmount).toBe('40.00');
      expect(result.sale.balanceDue).toBe('60.00');

      const activeCount = await prisma.payment.count({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activeCount).toBe(1);
      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_REGISTERED,
        result.payment.id,
      );
      expect(audits).toHaveLength(1);
    });

    it('desde saldo 60: pago 60 → PAID, paid 100.00, balance 0.00; dos Payment ACTIVE (40+60), sin drift', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '40.00',
      });
      const second = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '60.00',
      });
      expect(second.sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(second.sale.paidAmount).toBe('100.00');
      expect(second.sale.balanceDue).toBe('0.00');

      const activePayments = await prisma.payment.findMany({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activePayments).toHaveLength(2);
      const sum = activePayments.reduce(
        (acc, p) => acc.plus(p.amount),
        new Prisma.Decimal(0),
      );
      expect(sum.toFixed(2)).toBe('100.00');
    });
  });

  // ==================================================================
  // Pago sobre saldo cero / sobrepago
  // ==================================================================
  describe('pago sobre saldo cero / sobrepago', () => {
    it('venta ya PAID (balance 0): cualquier pago positivo → 409, sin nuevo Payment ni auditoría', async () => {
      const sale = await createFixtureSale({
        total: '50.00',
        paidAmount: '50.00',
      });
      // PaymentsService.register() calcula el saldo vigente desde
      // SUM(Payment ACTIVE) real, no desde Sale.paidAmount: el fixture debe
      // llevar un Payment real que respalde ese monto, igual que el resto
      // del dominio (nunca se "inventa" dinero recibido sin trazabilidad).
      await insertPayment({ saleId: sale.id, amount: '50.00' });
      const beforeCount = await prisma.payment.count({
        where: { saleId: sale.id },
      });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: '1.00',
      });
      expect(response.status).toBe(409);
      const afterCount = await prisma.payment.count({
        where: { saleId: sale.id },
      });
      expect(afterCount).toBe(beforeCount);
      const sale2 = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(sale2.paidAmount.toFixed(2)).toBe('50.00');
      expect(sale2.balanceDue.toFixed(2)).toBe('0.00');
    });

    it('saldo 30: intento de 30.01 → 409, sin Payment ni mutación de resumen', async () => {
      const sale = await createFixtureSale({ total: '30.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: '30.01',
      });
      expect(response.status).toBe(409);
      const count = await prisma.payment.count({ where: { saleId: sale.id } });
      expect(count).toBe(0);
      const row = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(row.paidAmount.toFixed(2)).toBe('0.00');
      expect(row.balanceDue.toFixed(2)).toBe('30.00');
    });
  });

  // ==================================================================
  // Independencia del ciclo de vida del cliente en el registro
  // ==================================================================
  describe('independencia del ciclo de vida del cliente — registro', () => {
    it('venta creada con cliente elegible, luego cliente pasa a INACTIVE: el registro sigue funcionando', async () => {
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente Mutable INACTIVE E2E ${nextSuffix()}`,
        },
      });
      ownedCustomerIds.push(customer.id);
      const sale = await createFixtureSale({
        total: '50.00',
        customerId: customer.id,
      });
      await prisma.customer.update({
        where: { id: customer.id },
        data: { status: CustomerStatus.INACTIVE },
      });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: '50.00',
      });
      expect(response.status).toBe(201);
    });

    it('venta creada con cliente elegible, luego cliente pasa a BLOCKED: el registro sigue funcionando', async () => {
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente Mutable BLOCKED E2E ${nextSuffix()}`,
        },
      });
      ownedCustomerIds.push(customer.id);
      const sale = await createFixtureSale({
        total: '50.00',
        customerId: customer.id,
      });
      await prisma.customer.update({
        where: { id: customer.id },
        data: { status: CustomerStatus.BLOCKED },
      });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: '50.00',
      });
      expect(response.status).toBe(201);
    });
  });

  // ==================================================================
  // Auditoría — registro
  // ==================================================================
  describe('auditoría — PAYMENT_REGISTERED', () => {
    it('exactamente 1 auditoría, module PAYMENTS, entityType Payment; whitelist exacta {saleId, saleNumber, method}', async () => {
      const sale = await createFixtureSale({ total: '25.00' });
      const result = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'BANK_TRANSFER',
        amount: '25.00',
        reference: 'OP-AUD-1',
      });
      const rows = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PAYMENT_REGISTERED,
          entityType: 'Payment',
          entityId: result.payment.id,
        },
      });
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.module).toBe('PAYMENTS');
      const metadata = row.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        ['saleId', 'saleNumber', 'method'].sort(),
      );
      expect(metadata.saleId).toBe(sale.id);
      expect(metadata.saleNumber).toBe(sale.number);
      expect(metadata.method).toBe('BANK_TRANSFER');
      expect(metadata).not.toHaveProperty('amount');
      expect(metadata).not.toHaveProperty('reference');
      expect(metadata).not.toHaveProperty('customerName');
      expect(metadata).not.toHaveProperty('customerDocumentNumber');
      expect(metadata).not.toHaveProperty('cancellationReason');
      expect(metadata).not.toHaveProperty('total');
      expect(metadata).not.toHaveProperty('paidAmount');
      expect(metadata).not.toHaveProperty('balanceDue');
      expect(metadata).not.toHaveProperty('items');
      assertAuditRowHasNoSecrets(row);
    });
  });

  // ==================================================================
  // Anulación manual de pago
  // ==================================================================
  describe('anulación manual de pago', () => {
    it('venta 100 con pago 100 ACTIVE: ADMIN anula con motivo → CANCELLED/MANUAL/motivo recortado/cancelledAt no nulo/cancelledBy ADMIN; venta vuelve a UNPAID 0/100; 1 auditoría', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '100.00',
      });
      const response = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: '  Pago registrado por error  ',
        },
      );
      expect(response.status).toBe(200);
      const body = response.body as PaymentMutationBody;
      expect(body.payment.status).toBe(PaymentStatus.CANCELLED);
      expect(body.payment.cancellationSource).toBe(
        PaymentCancellationSource.MANUAL,
      );
      expect(body.payment.cancellationReason).toBe('Pago registrado por error');
      expect(body.payment.cancelledAt).not.toBeNull();
      expect(body.payment.cancelledBy?.id).toBe(adminId);
      expect(body.sale.paymentStatus).toBe(SalePaymentStatus.UNPAID);
      expect(body.sale.paidAmount).toBe('0.00');
      expect(body.sale.balanceDue).toBe('100.00');

      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: created.payment.id },
      });
      expect(row.status).toBe(PaymentStatus.CANCELLED);

      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        created.payment.id,
      );
      expect(audits).toHaveLength(1);
    });

    it('venta PAID con pagos 60+40: anular el de 40 → PARTIALLY_PAID 60/40; luego anular el de 60 → UNPAID 0/100; filas históricas permanecen', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const p60 = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '60.00',
      });
      const p40 = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(p40.sale.paymentStatus).toBe(SalePaymentStatus.PAID);

      const afterFirstCancel = await cancelPayment(
        adminCookie,
        sale.id,
        p40.payment.id,
        { reason: 'Anular el de 40' },
      );
      expect(afterFirstCancel.status).toBe(200);
      const firstBody = afterFirstCancel.body as PaymentMutationBody;
      expect(firstBody.sale.paymentStatus).toBe(
        SalePaymentStatus.PARTIALLY_PAID,
      );
      expect(firstBody.sale.paidAmount).toBe('60.00');
      expect(firstBody.sale.balanceDue).toBe('40.00');

      const afterSecondCancel = await cancelPayment(
        adminCookie,
        sale.id,
        p60.payment.id,
        { reason: 'Anular el de 60' },
      );
      expect(afterSecondCancel.status).toBe(200);
      const secondBody = afterSecondCancel.body as PaymentMutationBody;
      expect(secondBody.sale.paymentStatus).toBe(SalePaymentStatus.UNPAID);
      expect(secondBody.sale.paidAmount).toBe('0.00');
      expect(secondBody.sale.balanceDue).toBe('100.00');

      const historicalRows = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(historicalRows).toHaveLength(2);
      expect(
        historicalRows.every((r) => r.status === PaymentStatus.CANCELLED),
      ).toBe(true);
    });

    it.each([
      ['', '400 motivo vacío'],
      ['   ', '400 motivo solo espacios'],
      ['R'.repeat(201), '400 motivo > 200'],
    ])('motivo inválido (%s) → 400, sin mutar el pago', async (reason) => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const response = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason,
        },
      );
      expect(response.status).toBe(400);
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: created.payment.id },
      });
      expect(row.status).toBe(PaymentStatus.ACTIVE);
    });

    it('motivo válido recortado se persigue tal cual (trim)', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const response = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: '  Motivo válido  ',
        },
      );
      expect(response.status).toBe(200);
      expect(
        (response.body as PaymentMutationBody).payment.cancellationReason,
      ).toBe('Motivo válido');
    });

    it('campo desconocido en el cuerpo de anulación → 400 (ValidationPipe whitelist)', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const response = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: 'motivo',
          cancellationSource: 'MANUAL',
        },
      );
      expect(response.status).toBe(400);
    });

    it('venta ya anulada: endpoint manual de pago → 409, sin mutación', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const cancelSale = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelSale.status).toBe(200);

      const response = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: 'Intento sobre venta anulada',
        },
      );
      expect(response.status).toBe(409);
    });

    it('pago ya anulado: segunda anulación → 409, sin segunda auditoría', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const first = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: 'Primera anulación',
        },
      );
      expect(first.status).toBe(200);
      const second = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: 'Segunda anulación',
        },
      );
      expect(second.status).toBe(409);
      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        created.payment.id,
      );
      expect(audits).toHaveLength(1);
    });

    it('pago que pertenece a OTRA venta (path Sale A + Payment de Sale B) → 404, sin mutación, sin revelar la existencia cruzada', async () => {
      const saleA = await createFixtureSale({ total: '10.00' });
      const saleB = await createFixtureSale({ total: '10.00' });
      const createdOnB = await registerPaymentOrThrow(adminCookie, saleB.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const response = await cancelPayment(
        adminCookie,
        saleA.id,
        createdOnB.payment.id,
        { reason: 'Cruce de venta' },
      );
      expect(response.status).toBe(404);
      assertNoLeakage(response);
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: createdOnB.payment.id },
      });
      expect(row.status).toBe(PaymentStatus.ACTIVE);
    });

    it('venta genérica (Público general) totalmente pagada: anulación manual de su pago → 409; pago sigue ACTIVE; venta sigue PAID', async () => {
      const sale = await createFixtureSale({
        total: '100.00',
        paidAmount: '100.00',
        customerId: genericCustomerId,
        customerIsGeneric: true,
      });
      const payment = await insertPayment({
        saleId: sale.id,
        amount: '100.00',
      });
      const response = await cancelPayment(adminCookie, sale.id, payment.id, {
        reason: 'Intento sobre Público general',
      });
      expect(response.status).toBe(409);
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(row.status).toBe(PaymentStatus.ACTIVE);
      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(saleRow.balanceDue.toFixed(2)).toBe('0.00');
      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        payment.id,
      );
      expect(audits).toHaveLength(0);
    });
  });

  // ==================================================================
  // Anulación — independencia del ciclo de vida del cliente
  // ==================================================================
  describe('anulación manual — independencia del ciclo de vida del cliente', () => {
    it('cliente pasa a BLOCKED después de crear el pago: la anulación sigue permitida; la venta puede quedar con saldo pendiente', async () => {
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente Cancel BLOCKED E2E ${nextSuffix()}`,
        },
      });
      ownedCustomerIds.push(customer.id);
      const sale = await createFixtureSale({
        total: '50.00',
        customerId: customer.id,
      });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '50.00',
      });
      await prisma.customer.update({
        where: { id: customer.id },
        data: { status: CustomerStatus.BLOCKED },
      });
      const response = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: 'Anulación con cliente ya bloqueado',
        },
      );
      expect(response.status).toBe(200);
      expect((response.body as PaymentMutationBody).sale.balanceDue).toBe(
        '50.00',
      );
    });

    it('cliente pasa a INACTIVE después de crear el pago: la anulación sigue permitida', async () => {
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente Cancel INACTIVE E2E ${nextSuffix()}`,
        },
      });
      ownedCustomerIds.push(customer.id);
      const sale = await createFixtureSale({
        total: '50.00',
        customerId: customer.id,
      });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '50.00',
      });
      await prisma.customer.update({
        where: { id: customer.id },
        data: { status: CustomerStatus.INACTIVE },
      });
      const response = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        {
          reason: 'Anulación con cliente ya inactivo',
        },
      );
      expect(response.status).toBe(200);
    });
  });

  // ==================================================================
  // Concurrencia
  // ==================================================================
  describe('concurrencia', () => {
    it('70+70 sobre saldo 100: exactamente una 201, la otra 409; final: 1 pago ACTIVE=70, PARTIALLY_PAID 70/30; 1 auditoría', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const [first, second] = await Promise.all([
        registerPayment(adminCookie, sale.id, {
          method: 'CASH',
          amount: '70.00',
        }),
        registerPayment(sellerCookie, sale.id, {
          method: 'CASH',
          amount: '70.00',
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);

      const activePayments = await prisma.payment.findMany({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activePayments).toHaveLength(1);
      expect(activePayments[0].amount.toFixed(2)).toBe('70.00');

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(saleRow.paidAmount.toFixed(2)).toBe('70.00');
      expect(saleRow.balanceDue.toFixed(2)).toBe('30.00');

      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_REGISTERED,
        activePayments[0].id,
      );
      expect(audits).toHaveLength(1);
    }, 30000);

    it('40+60 sobre saldo 100: ambas 201; final: 2 pagos ACTIVE sumando 100.00; PAID', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const [first, second] = await Promise.all([
        registerPayment(adminCookie, sale.id, {
          method: 'CASH',
          amount: '40.00',
        }),
        registerPayment(sellerCookie, sale.id, {
          method: 'CASH',
          amount: '60.00',
        }),
      ]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const activePayments = await prisma.payment.findMany({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activePayments).toHaveLength(2);
      const sum = activePayments.reduce(
        (acc, p) => acc.plus(p.amount),
        new Prisma.Decimal(0),
      );
      expect(sum.toFixed(2)).toBe('100.00');

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(saleRow.paidAmount.toFixed(2)).toBe('100.00');
      expect(saleRow.balanceDue.toFixed(2)).toBe('0.00');
    }, 30000);

    it('50+50 duplicados concurrentes sobre saldo 100: ambos permitidos (sin idempotencia); 2 pagos ACTIVE; PAID', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const [first, second] = await Promise.all([
        registerPayment(adminCookie, sale.id, {
          method: 'CASH',
          amount: '50.00',
        }),
        registerPayment(sellerCookie, sale.id, {
          method: 'CASH',
          amount: '50.00',
        }),
      ]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);

      const activePayments = await prisma.payment.findMany({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activePayments).toHaveLength(2);
      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.paymentStatus).toBe(SalePaymentStatus.PAID);
    }, 30000);

    it('doble anulación concurrente del mismo pago: exactamente una 200, la otra 409; anulado una sola vez; 1 auditoría', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const [first, second] = await Promise.all([
        cancelPayment(adminCookie, sale.id, created.payment.id, {
          reason: 'Concurrente A',
        }),
        cancelPayment(adminCookie, sale.id, created.payment.id, {
          reason: 'Concurrente B',
        }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: created.payment.id },
      });
      expect(row.status).toBe(PaymentStatus.CANCELLED);
      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        created.payment.id,
      );
      expect(audits).toHaveLength(1);
    }, 30000);

    it('registro de pago vs. anulación de venta en carrera: al final la venta queda CANCELLED y cero pagos ACTIVE, sin importar quién gane el lock', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const [payRes, cancelRes] = await Promise.all([
        registerPayment(sellerCookie, sale.id, {
          method: 'CASH',
          amount: '40.00',
        }),
        cancelSaleHttp(adminCookie, sale.id),
      ]);
      expect(cancelRes.status).toBe(200);
      expect([201, 409]).toContain(payRes.status);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.status).toBe(SaleStatus.CANCELLED);
      const activeCount = await prisma.payment.count({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activeCount).toBe(0);

      // Coherencia cruzada: si el pago ganó la carrera (201), debe existir
      // exactamente 1 fila de Payment para esta venta, ya cancelada en
      // cascada; si perdió (409), no debe existir ninguna.
      const totalPayments = await prisma.payment.count({
        where: { saleId: sale.id },
      });
      expect(totalPayments).toBe(payRes.status === 201 ? 1 : 0);
    }, 30000);

    it('anulación manual de pago vs. anulación de venta en carrera: al final la venta queda CANCELLED, el pago queda CANCELLED una sola vez, cero ACTIVE, una sola auditoría PAYMENT_CANCELLED', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '100.00',
      });
      const [manualCancel, saleCancel] = await Promise.all([
        cancelPayment(adminCookie, sale.id, created.payment.id, {
          reason: 'Anulación manual en carrera',
        }),
        cancelSaleHttp(adminCookie, sale.id),
      ]);
      // Exactamente uno de los dos triunfa con éxito sobre el pago (la
      // anulación de venta siempre triunfa: 200); la manual puede ganar
      // (200) o perder porque la venta ya quedó anulada primero (409).
      expect(saleCancel.status).toBe(200);
      expect([200, 409]).toContain(manualCancel.status);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.status).toBe(SaleStatus.CANCELLED);
      const paymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: created.payment.id },
      });
      expect(paymentRow.status).toBe(PaymentStatus.CANCELLED);
      const activeCount = await prisma.payment.count({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activeCount).toBe(0);

      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        created.payment.id,
      );
      expect(audits).toHaveLength(1);
    }, 30000);
  });

  // ==================================================================
  // Listado global de pagos
  // ==================================================================
  describe('listado global de pagos', () => {
    it('paginación básica y orden paidAt DESC, id DESC; incluye ACTIVE y CANCELLED', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const p1 = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const p2 = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      await cancelPayment(adminCookie, sale.id, p1.payment.id, { reason: 'x' });

      const response = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .query({ limit: 100 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafePaymentBody>;
      const ids = body.data.map((row) => row.id);
      expect(ids).toContain(p1.payment.id);
      expect(ids).toContain(p2.payment.id);
      const statuses = body.data
        .filter((row) => row.id === p1.payment.id || row.id === p2.payment.id)
        .map((row) => row.status);
      expect(statuses).toContain(PaymentStatus.ACTIVE);
      expect(statuses).toContain(PaymentStatus.CANCELLED);

      // Orden: para cada par consecutivo, paidAt no debe ser creciente
      // (desc); en empate, id string desc.
      for (let i = 0; i + 1 < body.data.length; i += 1) {
        const a = body.data[i];
        const b = body.data[i + 1];
        expect(a.paidAt >= b.paidAt).toBe(true);
      }
    });

    it('filtro por method: devuelve solo filas propias que coinciden', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const cash = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const card = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CARD',
        amount: '10.00',
        reference: 'OP-CARD-1',
      });
      const transfer = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'BANK_TRANSFER',
        amount: '10.00',
        reference: 'OP-BT-1',
      });

      for (const [method, expectedId, unexpectedIds] of [
        ['CASH', cash.payment.id, [card.payment.id, transfer.payment.id]],
        ['CARD', card.payment.id, [cash.payment.id, transfer.payment.id]],
        [
          'BANK_TRANSFER',
          transfer.payment.id,
          [cash.payment.id, card.payment.id],
        ],
      ] as const) {
        const response = await request(app.getHttpServer())
          .get('/api/v1/payments')
          .query({ method, limit: 100 })
          .set('Cookie', adminCookie);
        const ids = (response.body as PaginatedBody<SafePaymentBody>).data.map(
          (row) => row.id,
        );
        expect(ids).toContain(expectedId);
        for (const unexpected of unexpectedIds) {
          expect(ids).not.toContain(unexpected);
        }
      }
    });

    it('filtro por status: ACTIVE y CANCELLED devuelven cada uno lo esperado', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const active = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const toCancel = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      await cancelPayment(adminCookie, sale.id, toCancel.payment.id, {
        reason: 'x',
      });

      const activeResponse = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .query({ status: 'ACTIVE', limit: 100 })
        .set('Cookie', adminCookie);
      const activeIds = (
        activeResponse.body as PaginatedBody<SafePaymentBody>
      ).data.map((row) => row.id);
      expect(activeIds).toContain(active.payment.id);
      expect(activeIds).not.toContain(toCancel.payment.id);

      const cancelledResponse = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .query({ status: 'CANCELLED', limit: 100 })
        .set('Cookie', adminCookie);
      const cancelledIds = (
        cancelledResponse.body as PaginatedBody<SafePaymentBody>
      ).data.map((row) => row.id);
      expect(cancelledIds).toContain(toCancel.payment.id);
      expect(cancelledIds).not.toContain(active.payment.id);
    });

    it('filtro por createdByUserId: ADMIN y SELLER cada uno ve solo lo suyo con el filtro (sin restricción de propiedad al listar sin filtro)', async () => {
      const saleAdmin = await createFixtureSale({ total: '10.00' });
      const saleSeller = await createFixtureSale({ total: '10.00' });
      const byAdmin = await registerPaymentOrThrow(adminCookie, saleAdmin.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const bySeller = await registerPaymentOrThrow(
        sellerCookie,
        saleSeller.id,
        {
          method: 'CASH',
          amount: '10.00',
        },
      );

      const adminFiltered = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .query({ createdByUserId: adminId, limit: 100 })
        .set('Cookie', adminCookie);
      const adminIds = (
        adminFiltered.body as PaginatedBody<SafePaymentBody>
      ).data.map((row) => row.id);
      expect(adminIds).toContain(byAdmin.payment.id);
      expect(adminIds).not.toContain(bySeller.payment.id);

      const sellerFiltered = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .query({ createdByUserId: sellerId, limit: 100 })
        .set('Cookie', adminCookie);
      const sellerIds = (
        sellerFiltered.body as PaginatedBody<SafePaymentBody>
      ).data.map((row) => row.id);
      expect(sellerIds).toContain(bySeller.payment.id);
      expect(sellerIds).not.toContain(byAdmin.payment.id);
    });

    it('filtros de fecha paidFrom/paidTo (America/Lima): frontera inclusiva/exclusiva exacta', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      // Inicio del día de negocio D en Lima corresponde a 05:00:00.000 UTC
      // del mismo día calendario (America/Lima es UTC-5 fijo).
      const businessDate = '2026-03-10';
      const dayStartUtc = new Date('2026-03-10T05:00:00.000Z');
      const justBeforeStart = new Date(dayStartUtc.getTime() - 1);
      const justBeforeNextStart = new Date('2026-03-11T04:59:59.999Z');
      const nextDayStartUtc = new Date('2026-03-11T05:00:00.000Z');

      const before = await insertPayment({
        saleId: sale.id,
        amount: '1.00',
        paidAt: justBeforeStart,
      });
      const atStart = await insertPayment({
        saleId: sale.id,
        amount: '2.00',
        paidAt: dayStartUtc,
      });
      const justBeforeNext = await insertPayment({
        saleId: sale.id,
        amount: '3.00',
        paidAt: justBeforeNextStart,
      });
      const atNextStart = await insertPayment({
        saleId: sale.id,
        amount: '4.00',
        paidAt: nextDayStartUtc,
      });

      const fromResponse = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .query({ paidFrom: businessDate, limit: 100 })
        .set('Cookie', adminCookie);
      const fromIds = (
        fromResponse.body as PaginatedBody<SafePaymentBody>
      ).data.map((row) => row.id);
      expect(fromIds).not.toContain(before.id);
      expect(fromIds).toContain(atStart.id);

      const toResponse = await request(app.getHttpServer())
        .get('/api/v1/payments')
        .query({ paidTo: businessDate, limit: 100 })
        .set('Cookie', adminCookie);
      const toIds = (
        toResponse.body as PaginatedBody<SafePaymentBody>
      ).data.map((row) => row.id);
      expect(toIds).toContain(justBeforeNext.id);
      expect(toIds).not.toContain(atNextStart.id);
    });

    it('lectura de /payments nunca crea auditoría PAYMENT_*', async () => {
      const before = await prisma.auditLog.count({
        where: {
          action: {
            in: [AuditAction.PAYMENT_REGISTERED, AuditAction.PAYMENT_CANCELLED],
          },
        },
      });
      await request(app.getHttpServer())
        .get('/api/v1/payments')
        .set('Cookie', adminCookie);
      const after = await prisma.auditLog.count({
        where: {
          action: {
            in: [AuditAction.PAYMENT_REGISTERED, AuditAction.PAYMENT_CANCELLED],
          },
        },
      });
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // Contrato seguro del Payment
  // ==================================================================
  describe('contrato seguro del Payment (SafePayment)', () => {
    it('claves exactas; sin passwordHash/roleId/relación Sale cruda/AuditLog; montos con 2 decimales fijos', async () => {
      const sale = await createFixtureSale({ total: '15.50' });
      const result = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '15.50',
      });
      expect(Object.keys(result.payment).sort()).toEqual(SAFE_PAYMENT_KEYS);
      expect(Object.keys(result.payment.createdBy).sort()).toEqual(
        SAFE_PAYMENT_USER_KEYS,
      );
      expect(result.payment.amount).toBe('15.50');

      const serialized = JSON.stringify(result);
      expect(serialized).not.toMatch(/passwordHash/i);
      expect(serialized).not.toMatch(/"roleId"/);
      expect(serialized).not.toMatch(/failedLoginAttempts/i);
      expect(serialized).not.toMatch(/"sale":\s*\{[^}]*"items"/);
      expect(serialized).not.toMatch(/auditLog/i);
    });
  });

  // ==================================================================
  // Los 4 CHECK de Payment — inserción directa en pos_db_test
  // ==================================================================
  describe('CHECK constraints de payments (inserción directa)', () => {
    let checkSale: FixtureSale;
    beforeAll(async () => {
      checkSale = await createFixtureSale({ total: '1000.00' });
    });

    it('payments_amount_positive: monto 0 y monto negativo → 23514', async () => {
      await expectPgRejection(
        () => rawInsertPayment({ saleId: checkSale.id, amount: '0' }),
        '23514',
      );
      await expectPgRejection(
        () => rawInsertPayment({ saleId: checkSale.id, amount: '-1' }),
        '23514',
      );
    });

    it('payments_reference_not_blank: referencia solo espacios (presente) → 23514', async () => {
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            method: PaymentMethod.CASH,
            reference: '   ',
          }),
        '23514',
      );
    });

    it('payments_reference_required_by_method: BANK_TRANSFER/BANK_DEPOSIT/CARD sin referencia → 23514', async () => {
      for (const method of [
        PaymentMethod.BANK_TRANSFER,
        PaymentMethod.BANK_DEPOSIT,
        PaymentMethod.CARD,
      ]) {
        await expectPgRejection(
          () =>
            rawInsertPayment({ saleId: checkSale.id, method, reference: null }),
          '23514',
        );
      }
    });

    it('payments_reference_required_by_method: CASH/DIGITAL_WALLET/OTHER sin referencia → válido', async () => {
      for (const method of [
        PaymentMethod.CASH,
        PaymentMethod.DIGITAL_WALLET,
        PaymentMethod.OTHER,
      ]) {
        const id = await rawInsertPayment({
          saleId: checkSale.id,
          method,
          reference: null,
        });
        await prisma.payment.delete({ where: { id } });
      }
    });

    it('payments_cancellation_consistency: ACTIVE con campos de anulación poblados → 23514', async () => {
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            status: PaymentStatus.ACTIVE,
            cancelledAt: new Date(),
          }),
        '23514',
      );
    });

    it('payments_cancellation_consistency: CANCELLED sin cancellation_source → 23514', async () => {
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            status: PaymentStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledByUserId: adminId,
            cancellationReason: 'motivo',
            cancellationSource: null,
          }),
        '23514',
      );
    });

    it('payments_cancellation_consistency: CANCELLED sin cancelled_at → 23514', async () => {
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            status: PaymentStatus.CANCELLED,
            cancelledAt: null,
            cancelledByUserId: adminId,
            cancellationReason: 'motivo',
            cancellationSource: PaymentCancellationSource.MANUAL,
          }),
        '23514',
      );
    });

    it('payments_cancellation_consistency: CANCELLED sin cancelled_by_user_id → 23514', async () => {
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            status: PaymentStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledByUserId: null,
            cancellationReason: 'motivo',
            cancellationSource: PaymentCancellationSource.MANUAL,
          }),
        '23514',
      );
    });

    it('payments_cancellation_consistency: MANUAL sin cancellation_reason (o en blanco) → 23514', async () => {
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            status: PaymentStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledByUserId: adminId,
            cancellationReason: null,
            cancellationSource: PaymentCancellationSource.MANUAL,
          }),
        '23514',
      );
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            status: PaymentStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledByUserId: adminId,
            cancellationReason: '   ',
            cancellationSource: PaymentCancellationSource.MANUAL,
          }),
        '23514',
      );
    });

    it('payments_cancellation_consistency: SALE_CANCELLATION con cancellation_reason no nulo → 23514', async () => {
      await expectPgRejection(
        () =>
          rawInsertPayment({
            saleId: checkSale.id,
            status: PaymentStatus.CANCELLED,
            cancelledAt: new Date(),
            cancelledByUserId: adminId,
            cancellationReason: 'no debería llevar motivo',
            cancellationSource: PaymentCancellationSource.SALE_CANCELLATION,
          }),
        '23514',
      );
    });
  });

  // ==================================================================
  // FK de Payment
  // ==================================================================
  describe('comportamiento de FK de Payment', () => {
    it('Payment → Sale: eliminar la venta mientras existe un Payment → bloqueado (RESTRICT)', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      await expectClientFkRejection(() =>
        prisma.sale.delete({ where: { id: sale.id } }),
      );
    });

    it('Payment → createdBy User: eliminar al usuario creador mientras existe el Payment → bloqueado (RESTRICT), usando un actor efímero propio', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const response = await registerPayment(fkCreatorCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      expect(response.status).toBe(201);
      await expectClientFkRejection(() =>
        prisma.user.delete({ where: { id: fkCreatorId } }),
      );
    });

    it('Payment → cancelledBy User: eliminar al usuario que anuló mientras existe el Payment → bloqueado (RESTRICT), usando un actor efímero propio', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const cancelResponse = await cancelPayment(
        fkCancellerCookie,
        sale.id,
        created.payment.id,
        { reason: 'Anulado por actor efímero de FK' },
      );
      expect(cancelResponse.status).toBe(200);
      await expectClientFkRejection(() =>
        prisma.user.delete({ where: { id: fkCancellerId } }),
      );
    });
  });

  // ==================================================================
  // Sin unicidad de Payment
  // ==================================================================
  describe('sin restricción de unicidad de Payment', () => {
    it('dos pagos válidos con misma venta/método/monto/referencia persisten ambos', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const first = await registerPayment(adminCookie, sale.id, {
        method: 'CARD',
        amount: '40.00',
        reference: 'OP-DUP-1',
      });
      const second = await registerPayment(adminCookie, sale.id, {
        method: 'CARD',
        amount: '40.00',
        reference: 'OP-DUP-1',
      });
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      const count = await prisma.payment.count({ where: { saleId: sale.id } });
      expect(count).toBe(2);
    });
  });

  // ==================================================================
  // Limitación documentada de sobrepago en crudo (sin CHECK cruzado)
  // ==================================================================
  describe('limitación documentada: sin CHECK cruzado contra sumas de Payment', () => {
    it('un INSERT directo puede producir SUM(payments) > Sale.total sin que la BD lo rechace (documentado, no un defecto): se revierte a propósito', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      await prisma
        .$transaction(async (tx) => {
          // No existe ningún CHECK/trigger que sume Payment.amount contra
          // Sale.total: esa invariante es responsabilidad exclusiva de la
          // capa de aplicación (PaymentsService/PaymentEngine), nunca de
          // PostgreSQL. Se demuestra dentro de una transacción que se
          // revierte a propósito (rollback explícito): no se deja ningún dato
          // inconsistente en pos_db_test.
          await tx.payment.create({
            data: {
              saleId: sale.id,
              method: PaymentMethod.CASH,
              amount: new Prisma.Decimal('999.00'),
              status: PaymentStatus.ACTIVE,
              paidAt: new Date(),
              createdByUserId: adminId,
            },
          });
          const sum = await tx.payment.aggregate({
            where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
            _sum: { amount: true },
          });
          expect(sum._sum.amount?.toFixed(2)).toBe('999.00');
          throw new RollbackSignal();
        })
        .catch((error) => {
          if (!(error instanceof RollbackSignal)) {
            throw error;
          }
        });
      const countAfterRollback = await prisma.payment.count({
        where: { saleId: sale.id },
      });
      expect(countAfterRollback).toBe(0);
    });
  });

  // ==================================================================
  // Reconciliación del resumen de venta tras cada mutación
  // ==================================================================
  describe('reconciliación SUM(ACTIVE)=paidAmount tras cada mutación', () => {
    async function assertReconciled(saleId: string): Promise<void> {
      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: saleId },
      });
      const sum = await prisma.payment.aggregate({
        where: { saleId, status: PaymentStatus.ACTIVE },
        _sum: { amount: true },
      });
      const active = sum._sum.amount ?? new Prisma.Decimal(0);
      expect(saleRow.paidAmount.toFixed(2)).toBe(active.toFixed(2));
      expect(saleRow.balanceDue.toFixed(2)).toBe(
        saleRow.total.minus(active).toFixed(2),
      );
    }

    it('primer pago, segundo pago y anulación manual: la reconciliación se cumple después de cada paso', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      const first = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '40.00',
      });
      await assertReconciled(sale.id);
      await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '60.00',
      });
      await assertReconciled(sale.id);
      await cancelPayment(adminCookie, sale.id, first.payment.id, {
        reason: 'Reconciliación tras anulación',
      });
      await assertReconciled(sale.id);
    });
  });

  // ==================================================================
  // Excepción histórica de venta anulada
  // ==================================================================
  describe('excepción histórica: venta CANCELLED', () => {
    it('tras anular la venta, SUM(ACTIVE)=0 aunque Sale.paidAmount siga > 0 (congelado a propósito, no es drift)', async () => {
      const sale = await createFixtureSale({ total: '100.00' });
      await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '40.00',
      });
      const cancelResponse = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelResponse.status).toBe(200);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.status).toBe(SaleStatus.CANCELLED);
      expect(saleRow.paidAmount.toFixed(2)).toBe('40.00');

      const activeSum = await prisma.payment.aggregate({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
        _sum: { amount: true },
      });
      expect((activeSum._sum.amount ?? new Prisma.Decimal(0)).toFixed(2)).toBe(
        '0.00',
      );
    });
  });

  // ==================================================================
  // Sin efecto lateral de inventario / cliente desde operaciones de Payment
  // ==================================================================
  describe('sin efecto lateral de inventario ni de cliente desde operaciones de Payment', () => {
    it('registrar y anular un pago no crea InventoryMovement', async () => {
      const before = await prisma.inventoryMovement.count();
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      await cancelPayment(adminCookie, sale.id, created.payment.id, {
        reason: 'x',
      });
      const after = await prisma.inventoryMovement.count();
      expect(after).toBe(before);
    });

    it('listar pagos y cuentas por cobrar no crea InventoryMovement', async () => {
      const before = await prisma.inventoryMovement.count();
      await request(app.getHttpServer())
        .get('/api/v1/payments')
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get('/api/v1/accounts-receivable')
        .set('Cookie', adminCookie);
      const after = await prisma.inventoryMovement.count();
      expect(after).toBe(before);
    });

    it('registrar y anular un pago no muta Customer.status/customerStage', async () => {
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          status: CustomerStatus.ACTIVE,
          name: `Cliente Sin Mutación E2E ${nextSuffix()}`,
        },
      });
      ownedCustomerIds.push(customer.id);
      const sale = await createFixtureSale({
        total: '10.00',
        customerId: customer.id,
      });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      await cancelPayment(adminCookie, sale.id, created.payment.id, {
        reason: 'x',
      });
      const row = await prisma.customer.findUniqueOrThrow({
        where: { id: customer.id },
      });
      expect(row.status).toBe(CustomerStatus.ACTIVE);
      expect(row.customerStage).toBe(CustomerStage.PROSPECT);
    });
  });

  // ==================================================================
  // Seguridad de errores HTTP
  // ==================================================================
  describe('seguridad de errores HTTP (sin fuga de detalles internos)', () => {
    it('400/403/404/409 representativos no exponen códigos Prisma/SQLSTATE/nombres de constraint/stack', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const badAmount = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: 'no-es-un-monto',
      });
      assertNoLeakage(badAmount);
      expect(badAmount.status).toBe(400);

      const forbidden = await registerPayment(warehouseCookie, sale.id, {
        method: 'CASH',
        amount: '1.00',
      });
      assertNoLeakage(forbidden);
      expect(forbidden.status).toBe(403);

      const notFound = await cancelPayment(
        adminCookie,
        sale.id,
        NON_EXISTENT_UUID,
        { reason: 'x' },
      );
      assertNoLeakage(notFound);
      expect(notFound.status).toBe(404);

      const fullSale = await createFixtureSale({
        total: '10.00',
        paidAmount: '10.00',
      });
      await insertPayment({ saleId: fullSale.id, amount: '10.00' });
      const conflict = await registerPayment(adminCookie, fullSale.id, {
        method: 'CASH',
        amount: '1.00',
      });
      assertNoLeakage(conflict);
      expect(conflict.status).toBe(409);
    });
  });

  // ==================================================================
  // Historial de referencia
  // ==================================================================
  describe('historial de referencia', () => {
    it('la referencia persiste sin cambios (salvo el trim aprobado) tras anular el pago', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CARD',
        amount: '10.00',
        reference: '  OP-HIST-1  ',
      });
      expect(created.payment.reference).toBe('OP-HIST-1');
      const cancelled = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        { reason: 'x' },
      );
      expect((cancelled.body as PaymentMutationBody).payment.reference).toBe(
        'OP-HIST-1',
      );
      const audits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        created.payment.id,
      );
      const metadata = audits[0].metadata as Record<string, unknown>;
      expect(metadata).not.toHaveProperty('reference');
    });
  });

  // ==================================================================
  // paidAt
  // ==================================================================
  describe('comportamiento de paidAt', () => {
    it('paidAt no es un campo aceptado por el DTO: intentar enviarlo → 400 (ValidationPipe whitelist)', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const response = await registerPayment(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
        paidAt: '2000-01-01T00:00:00.000Z',
      });
      expect(response.status).toBe(400);
    });

    it('paidAt lo genera el backend (instante real reciente); la anulación no lo altera', async () => {
      const sale = await createFixtureSale({ total: '10.00' });
      const before = new Date();
      const created = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const paidAt = new Date(created.payment.paidAt);
      expect(paidAt.getTime()).toBeGreaterThanOrEqual(before.getTime() - 5000);
      expect(paidAt.getFullYear()).not.toBe(2000);

      const cancelled = await cancelPayment(
        adminCookie,
        sale.id,
        created.payment.id,
        { reason: 'x' },
      );
      expect((cancelled.body as PaymentMutationBody).payment.paidAt).toBe(
        created.payment.paidAt,
      );
    });
  });

  // ==================================================================
  // Sin edición/eliminación de Payment
  // ==================================================================
  describe('sin edición ni eliminación de Payment', () => {
    it('no existe ruta de mutación de amount/method/reference/paidAt; la corrección es anular + nuevo pago', async () => {
      const sale = await createFixtureSale({ total: '20.00' });
      const wrong = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '20.00',
      });
      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/payments/${wrong.payment.id}`)
        .set('Cookie', adminCookie)
        .send({ amount: '5.00' });
      expect(patch.status).toBe(404);

      await cancelPayment(adminCookie, sale.id, wrong.payment.id, {
        reason: 'Monto incorrecto, se corrige con un nuevo pago',
      });
      const corrected = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '20.00',
      });
      expect(corrected.sale.paymentStatus).toBe(SalePaymentStatus.PAID);
    });
  });
});

/** Señal interna para forzar un rollback intencional de `$transaction` en la prueba de §73, sin dejar datos inconsistentes. */
class RollbackSignal extends Error {}
