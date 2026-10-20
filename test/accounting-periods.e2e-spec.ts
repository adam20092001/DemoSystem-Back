import { INestApplication } from '@nestjs/common';
import {
  AccountingEventType,
  CategoryStatus,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AccountingEngine } from '../src/accounting/accounting.engine';
import { AuditAction } from '../src/audit/audit-action.enum';
import { businessToday } from '../src/common/date/business-date';
import { PrismaService } from '../src/database/prisma.service';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Fase A2.1/A2.2/A2.3/A2.4/A2.6/A2.7: periodos contables mensuales, fecha
 * contable y numeración secuencial de asientos. Suite dedicada (nunca
 * reutiliza accounting.e2e-spec.ts) por el mismo criterio de aislamiento de
 * riesgo que configuration-tax.e2e-spec.ts: estas pruebas tocan el estado
 * GLOBAL compartido "periodo contable del mes en curso" (OPEN/CLOSED), así
 * que cualquier prueba que lo cierre debe reabrirlo en su propio
 * `finally` antes de terminar, para no dejarlo CLOSED para el resto de la
 * ejecución (de esta suite o de cualquier otra que confirme una venta).
 */

interface SafePeriodBody {
  id: string;
  year: number;
  month: number;
  status: 'OPEN' | 'CLOSED';
  lastJournalNumber: number;
}

interface SafeEntryBody {
  id: string;
  accountingDate: string;
  periodId: string;
  journalNumber: number;
  sourceId: string;
}

interface SafeSaleBody {
  id: string;
  number: string;
}

const MANAGEMENT_USERNAME = 'e2e_a2_management';
const SELLER_USERNAME = 'e2e_a2_seller';
const WAREHOUSE_USERNAME = 'e2e_a2_warehouse';
const FIXTURE_PASSWORD = 'E2eA2Fixture2026Aa';

describe('Accounting Periods — Fase A2 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let customerId: string;
  let currentPeriod: SafePeriodBody;

  const createdProductIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdSaleIds: string[] = [];
  const createdPeriodIds: string[] = [];

  async function createDirectSale(
    overrides: { quantity?: string } = {},
  ): Promise<{ status: number; body: SafeSaleBody }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send({
        customerId,
        items: [{ productId, quantity: overrides.quantity ?? '1' }],
        payment: { method: 'CASH', amount: '100.00' },
      });
    if (response.status === 201) {
      createdSaleIds.push((response.body as SafeSaleBody).id);
    }
    return { status: response.status, body: response.body as SafeSaleBody };
  }

  async function findEntryForSource(
    sourceId: string,
    eventType: AccountingEventType = AccountingEventType.ORIGINAL,
  ): Promise<SafeEntryBody> {
    const response = await request(app.getHttpServer())
      .get('/api/v1/accounting/entries')
      .query({ sourceId })
      .set('Cookie', adminCookie);
    const body = response.body as { data: SafeEntryBody[] };
    const row = body.data.find(
      (entry) =>
        (entry as unknown as { eventType: string }).eventType === eventType,
    );
    if (row === undefined) {
      throw new Error(
        `No se encontró ningún asiento ${eventType} para sourceId=${sourceId}`,
      );
    }
    return row;
  }

  async function closeCurrentPeriod(): Promise<{ status: number }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/accounting/periods/${currentPeriod.id}/close`)
      .set('Cookie', adminCookie);
    return { status: response.status };
  }

  async function reopenCurrentPeriod(): Promise<{ status: number }> {
    const response = await request(app.getHttpServer())
      .post(`/api/v1/accounting/periods/${currentPeriod.id}/reopen`)
      .set('Cookie', adminCookie);
    return { status: response.status };
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
      email: 'e2e_a2_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a2_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a2_warehouse@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, FIXTURE_PASSWORD)
    ).cookie;

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

    const category = await prisma.category.upsert({
      where: { code: 'E2EA2CAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EA2CAT', name: 'Categoria E2E A2' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2EA2U' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2EA2U',
        name: 'Unidad E2E A2',
        abbreviation: 'ea2',
        allowDecimal: false,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: 'E2EA2-P1',
        name: 'Producto E2E A2',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('100.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('100000.000'),
        status: ProductStatus.ACTIVE,
      },
    });
    productId = product.id;
    createdProductIds.push(productId);

    const customer = await prisma.customer.create({
      data: {
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        creditEnabled: true,
        name: 'Cliente E2E A2',
      },
    });
    customerId = customer.id;
    createdCustomerIds.push(customerId);

    // Dispara la auto-creación del periodo del mes en curso (si todavía no
    // existe) confirmando una venta mínima, luego lo localiza por GET —
    // nunca asume que ya existe de una ejecución previa.
    const seedSale = await createDirectSale();
    if (seedSale.status !== 201) {
      throw new Error(
        `No se pudo crear la venta semilla: ${JSON.stringify(seedSale.body)}`,
      );
    }
    const seedEntry = await findEntryForSource(seedSale.body.id);
    const periodResponse = await request(app.getHttpServer())
      .get(`/api/v1/accounting/periods/${seedEntry.periodId}`)
      .set('Cookie', adminCookie);
    currentPeriod = periodResponse.body as SafePeriodBody;
  }, 60000);

  afterAll(async () => {
    try {
      // Garantiza que el periodo del mes en curso quede OPEN para
      // cualquier otra suite que corra después en el mismo proceso/run.
      if (currentPeriod?.status === 'CLOSED') {
        await reopenCurrentPeriod();
      }
      // Cada venta con pago inicial postea DOS asientos contables con
      // sourceId distinto: uno con sourceId=sale.id (reconocimiento de
      // venta) y otro con sourceId=payment.id (cobro) — y su eventual
      // REVERSAL conserva ese mismo sourceId. Hallazgo de la revisión A2:
      // filtrar solo por createdSaleIds dejaba húerfanos los asientos de
      // PAYMENT indefinidamente (nunca limpiados), residuo que disparaba
      // el guard de moneda de A0.2 en otros archivos E2E que corrieran
      // después en el mismo proceso. Se resuelven los ids de pago ANTES de
      // borrar los propios Payment.
      const relatedPayments = await prisma.payment.findMany({
        where: { saleId: { in: createdSaleIds } },
        select: { id: true },
      });
      const sourceIdsToClean = [
        ...createdSaleIds,
        ...relatedPayments.map((p) => p.id),
      ];
      await prisma.accountingEntryLine.deleteMany({
        where: { entry: { sourceId: { in: sourceIdsToClean } } },
      });
      await prisma.accountingEntry.deleteMany({
        where: { sourceId: { in: sourceIdsToClean } },
      });
      await prisma.payment.deleteMany({
        where: { saleId: { in: createdSaleIds } },
      });
      await prisma.inventoryMovement.deleteMany({
        where: { productId: { in: createdProductIds } },
      });
      await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
      // Secuencia NV compartida entre archivos e2e: upsert defensivo en el
      // beforeAll, eliminada aquí — mismo criterio exacto que
      // configuration-tax.e2e-spec.ts/sales.e2e-spec.ts ("nunca asumir
      // currentNumber == 0 al empezar" en NINGÚN archivo, incluido éste).
      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.SALE },
      });
      await prisma.customer.deleteMany({
        where: { id: { in: createdCustomerIds } },
      });
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
      await prisma.accountingPeriod.deleteMany({
        where: { id: { in: createdPeriodIds } },
      });
      await prisma.userRole.deleteMany({
        where: {
          user: {
            username: {
              in: [MANAGEMENT_USERNAME, SELLER_USERNAME, WAREHOUSE_USERNAME],
            },
          },
        },
      });
      await prisma.user.deleteMany({
        where: {
          username: {
            in: [MANAGEMENT_USERNAME, SELLER_USERNAME, WAREHOUSE_USERNAME],
          },
        },
      });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 60000);

  describe('RBAC', () => {
    it('SELLER/WAREHOUSE: 403 en todos los endpoints de periodos', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        const list = await request(app.getHttpServer())
          .get('/api/v1/accounting/periods')
          .set('Cookie', cookie);
        expect(list.status).toBe(403);

        const create = await request(app.getHttpServer())
          .post('/api/v1/accounting/periods')
          .set('Cookie', cookie)
          .send({ year: 2099, month: 1 });
        expect(create.status).toBe(403);
      }
    });

    it('MANAGEMENT: lee pero no escribe (403 en create/close/reopen)', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/accounting/periods')
        .set('Cookie', managementCookie);
      expect(list.status).toBe(200);

      const create = await request(app.getHttpServer())
        .post('/api/v1/accounting/periods')
        .set('Cookie', managementCookie)
        .send({ year: 2099, month: 1 });
      expect(create.status).toBe(403);

      const close = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${currentPeriod.id}/close`)
        .set('Cookie', managementCookie);
      expect(close.status).toBe(403);
    });

    it('ADMIN: acceso completo', async () => {
      const list = await request(app.getHttpServer())
        .get('/api/v1/accounting/periods')
        .set('Cookie', adminCookie);
      expect(list.status).toBe(200);
    });
  });

  describe('Ciclo de vida: crear/cerrar/reabrir', () => {
    it('crea un periodo OPEN nuevo (year/month futuro); duplicado -> 409; fuera de rango -> 400', async () => {
      const create = await request(app.getHttpServer())
        .post('/api/v1/accounting/periods')
        .set('Cookie', adminCookie)
        .send({ year: 2099, month: 1 });
      expect(create.status).toBe(201);
      const createBody = create.body as SafePeriodBody;
      expect(createBody.status).toBe('OPEN');
      createdPeriodIds.push(createBody.id);

      const duplicate = await request(app.getHttpServer())
        .post('/api/v1/accounting/periods')
        .set('Cookie', adminCookie)
        .send({ year: 2099, month: 1 });
      expect(duplicate.status).toBe(409);

      const invalid = await request(app.getHttpServer())
        .post('/api/v1/accounting/periods')
        .set('Cookie', adminCookie)
        .send({ year: 2099, month: 13 });
      expect(invalid.status).toBe(400);
    });

    it('cierra OPEN->CLOSED, audita, rechaza un segundo cierre (409), reabre CLOSED->OPEN y audita', async () => {
      const created = await request(app.getHttpServer())
        .post('/api/v1/accounting/periods')
        .set('Cookie', adminCookie)
        .send({ year: 2099, month: 2 });
      expect(created.status).toBe(201);
      const periodId = (created.body as SafePeriodBody).id;
      createdPeriodIds.push(periodId);

      const close = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${periodId}/close`)
        .set('Cookie', adminCookie);
      expect(close.status).toBe(200);
      expect((close.body as SafePeriodBody).status).toBe('CLOSED');

      const closedAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.ACCOUNTING_PERIOD_CLOSED,
          entityId: periodId,
        },
      });
      expect(closedAudit).not.toBeNull();

      const closeAgain = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${periodId}/close`)
        .set('Cookie', adminCookie);
      expect(closeAgain.status).toBe(409);

      const reopen = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${periodId}/reopen`)
        .set('Cookie', adminCookie);
      expect(reopen.status).toBe(200);
      expect((reopen.body as SafePeriodBody).status).toBe('OPEN');

      const reopenedAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.ACCOUNTING_PERIOD_REOPENED,
          entityId: periodId,
        },
      });
      expect(reopenedAudit).not.toBeNull();

      const reopenAgain = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${periodId}/reopen`)
        .set('Cookie', adminCookie);
      expect(reopenAgain.status).toBe(409);
    });

    it('404 sobre un id inexistente en close/reopen/detalle', async () => {
      const fakeId = '00000000-0000-4000-8000-000000000000';
      const close = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${fakeId}/close`)
        .set('Cookie', adminCookie);
      expect(close.status).toBe(404);

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/accounting/periods/${fakeId}`)
        .set('Cookie', adminCookie);
      expect(detail.status).toBe(404);
    });
  });

  describe('Integración con AccountingEngine', () => {
    it('una venta confirmada posta su asiento ORIGINAL en el periodo del mes en curso, con accountingDate = hoy en America/Lima', async () => {
      const sale = await createDirectSale();
      expect(sale.status).toBe(201);
      const entry = await findEntryForSource(sale.body.id);
      expect(entry.periodId).toBe(currentPeriod.id);
      expect(entry.accountingDate).toBe(businessToday());
      expect(entry.journalNumber).toBeGreaterThan(0);
    });

    it('cerrar el periodo del mes en curso bloquea (409) una venta nueva, SIN crear nada (rollback atómico: stock y conteo de ventas sin cambios)', async () => {
      const salesBefore = await prisma.sale.count();
      const stockBefore = await prisma.product.findUniqueOrThrow({
        where: { id: productId },
        select: { stockCurrent: true },
      });

      const close = await closeCurrentPeriod();
      expect(close.status).toBe(200);

      try {
        const blocked = await createDirectSale();
        expect(blocked.status).toBe(409);

        const salesAfter = await prisma.sale.count();
        expect(salesAfter).toBe(salesBefore);

        const stockAfter = await prisma.product.findUniqueOrThrow({
          where: { id: productId },
          select: { stockCurrent: true },
        });
        expect(stockAfter.stockCurrent.toString()).toBe(
          stockBefore.stockCurrent.toString(),
        );
      } finally {
        const reopen = await reopenCurrentPeriod();
        expect(reopen.status).toBe(200);
      }
    });

    it('reabierto el periodo, una venta nueva vuelve a postear con normalidad', async () => {
      const sale = await createDirectSale();
      expect(sale.status).toBe(201);
      const entry = await findEntryForSource(sale.body.id);
      expect(entry.periodId).toBe(currentPeriod.id);
    });

    it('anular una venta postea su REVERSAL en el periodo del mes en curso (mismo criterio que el ORIGINAL cuando ambos caen en el mismo mes)', async () => {
      const sale = await createDirectSale();
      expect(sale.status).toBe(201);

      const cancel = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.body.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Prueba E2E A2 — anulación' });
      expect(cancel.status).toBe(200);

      const reversal = await findEntryForSource(
        sale.body.id,
        AccountingEventType.REVERSAL,
      );
      expect(reversal.periodId).toBe(currentPeriod.id);
    });
  });

  describe('Concurrencia real (PostgreSQL)', () => {
    it('numeración: N confirmaciones de venta simultáneas en el mismo periodo reciben journalNumber distintos (sin duplicados)', async () => {
      const results = await Promise.all([
        createDirectSale(),
        createDirectSale(),
        createDirectSale(),
        createDirectSale(),
        createDirectSale(),
      ]);
      expect(results.every((r) => r.status === 201)).toBe(true);

      const entries = await Promise.all(
        results.map((r) => findEntryForSource(r.body.id)),
      );
      const numbers = entries.map((e) => e.journalNumber);
      expect(new Set(numbers).size).toBe(numbers.length);
    });

    it('posteo vs. cierre del mismo periodo: nunca termina en estado mixto (sale 201 pero entry en un periodo ya reportado CLOSED antes de que su propio posteo terminara) — un posteo que pierde la carrera rechaza con 409 sin dejar rastro', async () => {
      const salesBefore = await prisma.sale.count();

      const [saleResult, closeResult] = await Promise.all([
        createDirectSale(),
        closeCurrentPeriod(),
      ]);

      expect(closeResult.status).toBe(200);

      try {
        if (saleResult.status === 201) {
          const entry = await findEntryForSource(saleResult.body.id);
          expect(entry.periodId).toBe(currentPeriod.id);
        } else {
          expect(saleResult.status).toBe(409);
          const salesAfter = await prisma.sale.count();
          expect(salesAfter).toBe(salesBefore);
        }
      } finally {
        const reopen = await reopenCurrentPeriod();
        expect(reopen.status).toBe(200);
      }
    });

    it('reversión vs. cierre del mismo periodo: la anulación gana (postea su REVERSAL antes del cierre) o pierde (409, la venta queda ACTIVE) — nunca un estado mixto', async () => {
      const sale = await createDirectSale();
      expect(sale.status).toBe(201);

      const [cancelResult, closeResult] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/sales/${sale.body.id}/cancel`)
          .set('Cookie', adminCookie)
          .send({ reason: 'Prueba E2E A2 — concurrencia reversión/cierre' }),
        closeCurrentPeriod(),
      ]);

      expect(closeResult.status).toBe(200);

      try {
        if (cancelResult.status === 200) {
          const reversal = await findEntryForSource(
            sale.body.id,
            AccountingEventType.REVERSAL,
          );
          expect(reversal.periodId).toBe(currentPeriod.id);
        } else {
          const saleRow = await prisma.sale.findUniqueOrThrow({
            where: { id: sale.body.id },
            select: { status: true },
          });
          expect(saleRow.status).toBe('ACTIVE');
        }
      } finally {
        const reopen = await reopenCurrentPeriod();
        expect(reopen.status).toBe(200);
      }
    });
  });

  describe('Creación concurrente del MISMO periodo nuevo (A2.4, punto 4)', () => {
    it('dos transacciones en paralelo que necesitan por primera vez un periodo (year, month) inexistente nunca duplican la fila ni pierden un asiento', async () => {
      // Año/mes distintivo, garantizado sin usar en ningún otro lado de
      // esta suite ni del resto del dominio: integración directa contra
      // AccountingEngine con PrismaService real (no HTTP) porque la API
      // comercial siempre usa postedAt=now() (A2.2: nunca permite
      // retrofechar), así que no hay forma de forzar vía HTTP que dos
      // ventas caigan en el mismo mes FUTURO todavía inexistente.
      const engine = app.get(AccountingEngine);
      const prismaService = app.get(PrismaService);
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
        select: { id: true },
      });
      const postedAt = new Date('2099-07-15T12:00:00.000Z');
      const saleIdA = '99999999-0000-4000-8000-000000000001';
      const saleIdB = '99999999-0000-4000-8000-000000000002';

      try {
        const [resultA, resultB] = await Promise.all([
          prismaService.$transaction((tx) =>
            engine.postSaleRecognition(tx, {
              saleId: saleIdA,
              saleNumber: 'NV-A2-CONC-A',
              subtotal: new Prisma.Decimal('100.00'),
              discountAmount: new Prisma.Decimal('0.00'),
              taxAmount: new Prisma.Decimal('0.00'),
              total: new Prisma.Decimal('100.00'),
              postedAt,
              actorUserId: admin.id,
              ipAddress: null,
            }),
          ),
          prismaService.$transaction((tx) =>
            engine.postSaleRecognition(tx, {
              saleId: saleIdB,
              saleNumber: 'NV-A2-CONC-B',
              subtotal: new Prisma.Decimal('200.00'),
              discountAmount: new Prisma.Decimal('0.00'),
              taxAmount: new Prisma.Decimal('0.00'),
              total: new Prisma.Decimal('200.00'),
              postedAt,
              actorUserId: admin.id,
              ipAddress: null,
            }),
          ),
        ]);

        const periods = await prisma.accountingPeriod.findMany({
          where: { year: 2099, month: 7 },
        });
        expect(periods).toHaveLength(1);
        createdPeriodIds.push(periods[0].id);

        expect(resultA).not.toBeNull();
        expect(resultB).not.toBeNull();
        const entryA = await prisma.accountingEntry.findUniqueOrThrow({
          where: { id: (resultA as { id: string }).id },
        });
        const entryB = await prisma.accountingEntry.findUniqueOrThrow({
          where: { id: (resultB as { id: string }).id },
        });
        expect(entryA.periodId).toBe(periods[0].id);
        expect(entryB.periodId).toBe(periods[0].id);
        expect(entryA.journalNumber).not.toBe(entryB.journalNumber);
        expect(new Set([entryA.journalNumber, entryB.journalNumber]).size).toBe(
          2,
        );
      } finally {
        await prisma.accountingEntryLine.deleteMany({
          where: { entry: { sourceId: { in: [saleIdA, saleIdB] } } },
        });
        await prisma.accountingEntry.deleteMany({
          where: { sourceId: { in: [saleIdA, saleIdB] } },
        });
      }
    }, 30000);
  });
});
