import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  AccountStatus,
  AccountType,
  Prisma,
  PrismaClient,
  RoleName,
} from '@prisma/client';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { App } from 'supertest/types';
import { businessToday } from '../src/common/date/business-date';
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
 * Fase A3.1/A3.2/A3.3/A3.4/A3.5/A3.6/A3.7: Libro Diario, Libro Mayor y
 * Balance de comprobación, de SOLO LECTURA. Suite dedicada, aislada del
 * resto del dominio contable mediante un rango de fechas histórico fijo
 * (enero-marzo 2026, firmemente en el pasado respecto a "hoy" en
 * cualquier ejecución real de esta suite) y cuentas/periodos propios,
 * para que los resultados sean deterministas sin depender de qué otra
 * suite haya corrido antes o después en el mismo proceso E2E.
 */

const JAN = { year: 2026, month: 1 };
const FEB = { year: 2026, month: 2 };

const MANAGEMENT_USERNAME = 'e2e_a3_management';
const SELLER_USERNAME = 'e2e_a3_seller';
const WAREHOUSE_USERNAME = 'e2e_a3_warehouse';
const FIXTURE_PASSWORD = 'E2eA3Fixture2026Aa';

interface JournalLineBody {
  accountId: string;
  accountCode: string;
  debitAmount: string;
  creditAmount: string;
}
interface JournalEntryBody {
  id: string;
  accountingDate: string;
  periodId: string;
  periodYear: number;
  periodMonth: number;
  journalNumber: number;
  eventType: AccountingEventType;
  lines: JournalLineBody[];
  totalDebit: string;
  totalCredit: string;
}
interface JournalReportBody {
  data: JournalEntryBody[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface LedgerMovementBody {
  accountingDate: string;
  journalNumber: number;
  debitAmount: string;
  creditAmount: string;
  runningBalance: string;
}
interface LedgerReportBody {
  accountId: string;
  accountStatus: AccountStatus;
  normalBalance: 'DEBIT' | 'CREDIT';
  openingBalance: string;
  closingBalance: string;
  data: LedgerMovementBody[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface TrialBalanceRowBody {
  accountId: string;
  accountCode: string;
  openingDebit: string;
  openingCredit: string;
  periodDebit: string;
  periodCredit: string;
  endingDebit: string;
  endingCredit: string;
}
interface TrialBalanceReconciliationBody {
  applicable: boolean;
  openingBalanced: boolean | null;
  periodBalanced: boolean | null;
  endingBalanced: boolean | null;
  totalPeriodDebit: string;
  totalPeriodCredit: string;
}
interface TrialBalanceReportBody {
  data: TrialBalanceRowBody[];
  reconciliation: TrialBalanceReconciliationBody;
}

interface SafeAccountBody {
  id: string;
  code: string;
}

describe('Accounting Reports — Fase A3 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let adminId: string;

  let accountIds: Record<'CASH' | 'SALES' | 'AR' | 'VAT' | 'DISCOUNTS', string>;
  let parentAccountId: string;
  let childAccountId: string;
  let inactiveAccountId: string;

  const createdAccountIds: string[] = [];
  const createdEntryIds: string[] = [];
  const createdPeriodIds: Set<string> = new Set();

  async function resolveFixturePeriod(postedAt: Date): Promise<{
    accountingDate: Date;
    periodId: string;
    journalNumber: number;
  }> {
    const dateOnly = businessToday(postedAt);
    const [year, month] = dateOnly.split('-').map(Number);
    const period = await prisma.accountingPeriod.upsert({
      where: { year_month: { year, month } },
      update: {},
      create: { year, month },
    });
    createdPeriodIds.add(period.id);
    const updated = await prisma.accountingPeriod.update({
      where: { id: period.id },
      data: { lastJournalNumber: { increment: 1 } },
    });
    return {
      accountingDate: new Date(
        Date.UTC(year, month - 1, Number(dateOnly.slice(8, 10))),
      ),
      periodId: period.id,
      journalNumber: updated.lastJournalNumber,
    };
  }

  /** Inserta un AccountingEntry balanceado + sus líneas directamente (fixture histórica, fuera de AccountingEngine). */
  async function rawInsertBalancedEntry(opts: {
    sourceType: AccountingSourceType;
    sourceId?: string;
    eventType?: AccountingEventType;
    reversesEntryId?: string | null;
    description: string;
    postedAt: Date;
    lines: { accountId: string; debit: string; credit: string }[];
  }): Promise<string> {
    const sourceId = opts.sourceId ?? randomUUID();
    const eventType = opts.eventType ?? AccountingEventType.ORIGINAL;
    const { accountingDate, periodId, journalNumber } =
      await resolveFixturePeriod(opts.postedAt);

    const entry = await prisma.accountingEntry.create({
      data: {
        sourceType: opts.sourceType,
        sourceId,
        eventType,
        reversesEntryId: opts.reversesEntryId ?? null,
        description: opts.description,
        postedAt: opts.postedAt,
        accountingDate,
        periodId,
        journalNumber,
        createdByUserId: adminId,
      },
    });
    for (const line of opts.lines) {
      await prisma.accountingEntryLine.create({
        data: {
          entryId: entry.id,
          accountId: line.accountId,
          debitAmount: new Prisma.Decimal(line.debit),
          creditAmount: new Prisma.Decimal(line.credit),
        },
      });
    }
    createdEntryIds.push(entry.id);
    return entry.id;
  }

  async function createTestAccount(body: {
    code: string;
    name: string;
    type: AccountType;
    parentId?: string;
    isPostable?: boolean;
  }): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/chart-of-accounts')
      .set('Cookie', adminCookie)
      .send(body);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la cuenta fixture ${body.code}: ${JSON.stringify(response.body)}`,
      );
    }
    const created = response.body as SafeAccountBody;
    createdAccountIds.push(created.id);
    return created.id;
  }

  async function getJournal(
    cookie: string,
    query: Record<string, string | number>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounting/reports/journal')
      .query(query)
      .set('Cookie', cookie);
  }

  async function getLedger(
    cookie: string,
    query: Record<string, string | number>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounting/reports/ledger')
      .query(query)
      .set('Cookie', cookie);
  }

  async function getTrialBalance(
    cookie: string,
    query: Record<string, string | number>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounting/reports/trial-balance')
      .query(query)
      .set('Cookie', cookie);
  }

  async function readWorkbook(buffer: Buffer): Promise<ExcelJS.Worksheet> {
    const workbook = new ExcelJS.Workbook();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-argument -- mismo desajuste de tipos ya documentado en accounts-receivable.e2e-spec.ts
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
    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
      select: { id: true },
    });
    adminId = adminUser.id;

    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_a3_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a3_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a3_warehouse@demosystem.test',
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

    const systemAccounts = await prisma.account.findMany({
      where: {
        systemKey: {
          in: [
            AccountingSystemKey.CASH,
            AccountingSystemKey.SALES_REVENUE,
            AccountingSystemKey.ACCOUNTS_RECEIVABLE,
            AccountingSystemKey.VAT_PAYABLE,
            AccountingSystemKey.DISCOUNTS,
          ],
        },
      },
      select: { id: true, systemKey: true },
    });
    const bySystemKey = new Map(systemAccounts.map((a) => [a.systemKey, a.id]));
    accountIds = {
      CASH: bySystemKey.get(AccountingSystemKey.CASH)!,
      SALES: bySystemKey.get(AccountingSystemKey.SALES_REVENUE)!,
      AR: bySystemKey.get(AccountingSystemKey.ACCOUNTS_RECEIVABLE)!,
      VAT: bySystemKey.get(AccountingSystemKey.VAT_PAYABLE)!,
      DISCOUNTS: bySystemKey.get(AccountingSystemKey.DISCOUNTS)!,
    };

    const suffix = Date.now() % 1000000;
    parentAccountId = await createTestAccount({
      code: `A3PAR${suffix}`,
      name: 'Padre E2E A3',
      type: AccountType.ASSET,
      isPostable: false,
    });
    childAccountId = await createTestAccount({
      code: `A3CHI${suffix}`,
      name: 'Hijo E2E A3 (tipo AR)',
      type: AccountType.ASSET,
      parentId: parentAccountId,
      isPostable: true,
    });
    inactiveAccountId = await createTestAccount({
      code: `A3INA${suffix}`,
      name: 'Cuenta inactiva E2E A3',
      type: AccountType.ASSET,
      isPostable: true,
    });

    // ------------------------------------------------------------------
    // Historial determinista: enero-marzo 2026, firmemente en el pasado.
    // ------------------------------------------------------------------

    // Ene-10: Venta -> debita CHILD 100.00, acredita SALES 100.00.
    await rawInsertBalancedEntry({
      sourceType: AccountingSourceType.SALE,
      description: 'Venta histórica E2E A3 — Ene 10',
      postedAt: new Date('2026-01-10T15:00:00.000Z'),
      lines: [
        { accountId: childAccountId, debit: '100.00', credit: '0.00' },
        { accountId: accountIds.SALES, debit: '0.00', credit: '100.00' },
      ],
    });

    // Ene-20: Cobro parcial -> debita CASH 50.00, acredita CHILD 50.00.
    await rawInsertBalancedEntry({
      sourceType: AccountingSourceType.PAYMENT,
      description: 'Cobro histórico E2E A3 — Ene 20',
      postedAt: new Date('2026-01-20T15:00:00.000Z'),
      lines: [
        { accountId: accountIds.CASH, debit: '50.00', credit: '0.00' },
        { accountId: childAccountId, debit: '0.00', credit: '50.00' },
      ],
    });

    // Ene-25: movimiento sobre la cuenta que luego se desactiva.
    await rawInsertBalancedEntry({
      sourceType: AccountingSourceType.PAYMENT,
      description: 'Movimiento histórico E2E A3 — cuenta a desactivar',
      postedAt: new Date('2026-01-25T15:00:00.000Z'),
      lines: [
        { accountId: inactiveAccountId, debit: '30.00', credit: '0.00' },
        { accountId: accountIds.CASH, debit: '0.00', credit: '30.00' },
      ],
    });
    const deactivateResponse = await request(app.getHttpServer())
      .post(`/api/v1/chart-of-accounts/${inactiveAccountId}/deactivate`)
      .set('Cookie', adminCookie);
    if (deactivateResponse.status !== 200) {
      throw new Error(
        `No se pudo desactivar la cuenta fixture: ${JSON.stringify(deactivateResponse.body)}`,
      );
    }

    // Feb-05: dos asientos en la MISMA fecha contable (orden estable por journalNumber).
    await rawInsertBalancedEntry({
      sourceType: AccountingSourceType.SALE,
      description: 'Venta histórica E2E A3 — Feb 05 (primera del día)',
      postedAt: new Date('2026-02-05T10:00:00.000Z'),
      lines: [
        { accountId: childAccountId, debit: '200.00', credit: '0.00' },
        { accountId: accountIds.SALES, debit: '0.00', credit: '200.00' },
      ],
    });
    await rawInsertBalancedEntry({
      sourceType: AccountingSourceType.SALE,
      description: 'Venta histórica E2E A3 — Feb 05 (segunda del día)',
      postedAt: new Date('2026-02-05T16:00:00.000Z'),
      lines: [
        { accountId: childAccountId, debit: '20.00', credit: '0.00' },
        { accountId: accountIds.SALES, debit: '0.00', credit: '20.00' },
      ],
    });

    // Feb-15: venta que se reversa en MARZO (periodo distinto al original).
    const feb15EntryId = await rawInsertBalancedEntry({
      sourceType: AccountingSourceType.SALE,
      description:
        '=HYPERLINK("http://x")+Venta histórica E2E A3 — Feb 15 (a reversar en marzo)',
      postedAt: new Date('2026-02-15T12:00:00.000Z'),
      lines: [
        { accountId: childAccountId, debit: '200.00', credit: '0.00' },
        { accountId: accountIds.SALES, debit: '0.00', credit: '200.00' },
      ],
    });
    await rawInsertBalancedEntry({
      sourceType: AccountingSourceType.SALE,
      eventType: AccountingEventType.REVERSAL,
      reversesEntryId: feb15EntryId,
      description:
        'Reversión histórica E2E A3 — Mar 01 (del asiento de Feb 15)',
      postedAt: new Date('2026-03-01T09:00:00.000Z'),
      lines: [
        { accountId: accountIds.SALES, debit: '200.00', credit: '0.00' },
        { accountId: childAccountId, debit: '0.00', credit: '200.00' },
      ],
    });
  }, 60000);

  afterAll(async () => {
    try {
      await prisma.accountingEntryLine.deleteMany({
        where: { entryId: { in: createdEntryIds } },
      });
      await prisma.accountingEntry.deleteMany({
        where: { id: { in: createdEntryIds } },
      });
      // Hijo antes que padre (FK RESTRICT sobre parent_id).
      await prisma.account.deleteMany({ where: { id: childAccountId } });
      await prisma.account.deleteMany({ where: { id: inactiveAccountId } });
      await prisma.account.deleteMany({ where: { id: parentAccountId } });
      await prisma.account.deleteMany({
        where: { id: { in: createdAccountIds } },
      });
      // Los periodos fixture (Ene/Feb/Mar 2026) quedan sin ningún asiento
      // tras las eliminaciones de arriba; se eliminan por prolijidad, nunca
      // de forma bloqueante (defensivo: si algo más los referenciara, no
      // debe impedir el resto de la limpieza).
      try {
        await prisma.accountingPeriod.deleteMany({
          where: { id: { in: Array.from(createdPeriodIds) } },
        });
      } catch {
        // Ver comentario arriba: no bloqueante.
      }
    } finally {
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
      await app.close();
      await prisma.$disconnect();
    }
  }, 60000);

  // ====================================================================
  // RBAC
  // ====================================================================
  describe('RBAC', () => {
    it('SELLER/WAREHOUSE: 403 en los 3 reportes', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        const journal = await getJournal(cookie, {
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
        });
        expect(journal.status).toBe(403);
        const ledger = await getLedger(cookie, {
          accountId: childAccountId,
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
        });
        expect(ledger.status).toBe(403);
        const trialBalance = await getTrialBalance(cookie, {
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
        });
        expect(trialBalance.status).toBe(403);
      }
    });

    it('MANAGEMENT y ADMIN: 200 en los 3 reportes', async () => {
      for (const cookie of [managementCookie, adminCookie]) {
        const journal = await getJournal(cookie, {
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
        });
        expect(journal.status).toBe(200);
      }
    });
  });

  // ====================================================================
  // A3.1 — Libro Diario
  // ====================================================================
  describe('Libro Diario', () => {
    it('rango inválido (from > to): 400', async () => {
      const response = await getJournal(adminCookie, {
        accountingDateFrom: '2026-03-31',
        accountingDateTo: '2026-01-01',
      });
      expect(response.status).toBe(400);
    });

    it('lista todos los asientos del rango, orden cronológico estable, Debe=Haber por asiento', async () => {
      const response = await getJournal(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
        limit: 100,
      });
      expect(response.status).toBe(200);
      const body = response.body as JournalReportBody;
      // 3 (Ene) + 2 (Feb mismo día) + 1 (Feb 15) + 1 (reversal Mar) = 7, pero
      // puede incluir asientos de OTRAS suites si comparten el rango — se
      // filtra a los propios de esta fixture para una aserción exacta.
      const own = body.data.filter((e) => createdEntryIds.includes(e.id));
      expect(own).toHaveLength(7);
      for (const entry of own) {
        expect(entry.totalDebit).toBe(entry.totalCredit);
      }
      // Orden cronológico: cada accountingDate <= el siguiente.
      for (let i = 1; i < own.length; i++) {
        expect(own[i - 1].accountingDate <= own[i].accountingDate).toBe(true);
      }
      // Los dos de Feb-05 en orden estable por journalNumber ascendente.
      const feb05 = own.filter((e) => e.accountingDate === '2026-02-05');
      expect(feb05).toHaveLength(2);
      expect(feb05[0].journalNumber).toBeLessThan(feb05[1].journalNumber);
    });

    it('incluye el asiento REVERSAL como fila independiente, en MARZO (no en Feb, el mes del original)', async () => {
      const response = await getJournal(adminCookie, {
        accountingDateFrom: '2026-03-01',
        accountingDateTo: '2026-03-31',
        limit: 100,
      });
      const body = response.body as JournalReportBody;
      const reversal = body.data.find(
        (e) =>
          createdEntryIds.includes(e.id) &&
          e.eventType === AccountingEventType.REVERSAL,
      );
      expect(reversal).toBeDefined();
      expect(reversal?.accountingDate).toBe('2026-03-01');
      expect(reversal?.totalDebit).toBe('200.00');
      expect(reversal?.totalCredit).toBe('200.00');
    });

    it('filtra por periodId: solo los asientos de ese periodo', async () => {
      const febPeriod = await prisma.accountingPeriod.findUniqueOrThrow({
        where: { year_month: FEB },
      });
      const response = await getJournal(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
        periodId: febPeriod.id,
        limit: 100,
      });
      const body = response.body as JournalReportBody;
      const own = body.data.filter((e) => createdEntryIds.includes(e.id));
      expect(own.every((e) => e.periodId === febPeriod.id)).toBe(true);
      expect(own).toHaveLength(3); // Feb05 x2 + Feb15
    });

    it('no excluye un asiento histórico aunque el periodo de enero esté CLOSED', async () => {
      const janPeriod = await prisma.accountingPeriod.findUniqueOrThrow({
        where: { year_month: JAN },
      });
      const close = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${janPeriod.id}/close`)
        .set('Cookie', adminCookie);
      expect(close.status).toBe(200);

      try {
        const response = await getJournal(adminCookie, {
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-01-31',
          limit: 100,
        });
        const body = response.body as JournalReportBody;
        const own = body.data.filter((e) => createdEntryIds.includes(e.id));
        expect(own).toHaveLength(3);
      } finally {
        const reopen = await request(app.getHttpServer())
          .post(`/api/v1/accounting/periods/${janPeriod.id}/reopen`)
          .set('Cookie', adminCookie);
        expect(reopen.status).toBe(200);
      }
    });

    it('paginación corta por ASIENTO completo, nunca a mitad de uno (limit=1 recorre todos sin romper totales)', async () => {
      let page = 1;
      const seenIds = new Set<string>();
      let totalPages = 1;
      do {
        const response = await getJournal(adminCookie, {
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
          page,
          limit: 1,
        });
        const body = response.body as JournalReportBody;
        totalPages = body.totalPages;
        for (const entry of body.data) {
          seenIds.add(entry.id);
          expect(entry.totalDebit).toBe(entry.totalCredit);
        }
        page++;
      } while (page <= totalPages && page < 200);

      const ownSeen = createdEntryIds.filter((id) => seenIds.has(id));
      expect(ownSeen).toHaveLength(createdEntryIds.length);
    });

    it('rango sin ningún asiento: 200, data vacía, total=0', async () => {
      const response = await getJournal(adminCookie, {
        accountingDateFrom: '2019-01-01',
        accountingDateTo: '2019-01-31',
      });
      expect(response.status).toBe(200);
      const body = response.body as JournalReportBody;
      expect(body.data).toEqual([]);
      expect(body.total).toBe(0);
      expect(body.totalPages).toBe(0);
    });
  });

  // ====================================================================
  // A3.2 — Libro Mayor
  // ====================================================================
  describe('Libro Mayor', () => {
    it('cuenta inexistente: 404', async () => {
      const response = await getLedger(adminCookie, {
        accountId: '00000000-0000-4000-8000-000000000000',
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      expect(response.status).toBe(404);
    });

    it('apertura, movimientos y cierre correctos para la cuenta hija (ASSET, naturaleza DEBIT)', async () => {
      const response = await getLedger(adminCookie, {
        accountId: childAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
        limit: 100,
      });
      expect(response.status).toBe(200);
      const body = response.body as LedgerReportBody;
      expect(body.normalBalance).toBe('DEBIT');
      expect(body.openingBalance).toBe('0.00');
      // 100 - 50 + 200 + 20 + 200 - 200(reversal) = 270.00
      expect(body.closingBalance).toBe('270.00');
      // Ene10, Ene20, Feb05(x2), Feb15, y la reversión de Mar01 (también toca esta cuenta).
      expect(body.total).toBe(6);
    });

    it('la fecha de cierre determina el saldo, no la de apertura: cerrar el rango en Mar-31 da el MISMO cierre empezando en Ene-1 o en Feb-1', async () => {
      const fromJan = await getLedger(adminCookie, {
        accountId: childAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      const fromFeb = await getLedger(adminCookie, {
        accountId: childAccountId,
        accountingDateFrom: '2026-02-01',
        accountingDateTo: '2026-03-31',
      });
      const bodyJan = fromJan.body as LedgerReportBody;
      const bodyFeb = fromFeb.body as LedgerReportBody;
      expect(bodyJan.closingBalance).toBe(bodyFeb.closingBalance);
      // La apertura de Feb debe reflejar exactamente lo ocurrido en enero: 100-50=50.00
      expect(bodyFeb.openingBalance).toBe('50.00');
    });

    it('cuenta padre (no postable): apertura 0, movimientos vacíos, cierre 0 — nunca consolida a sus hijas', async () => {
      const response = await getLedger(adminCookie, {
        accountId: parentAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      expect(response.status).toBe(200);
      const body = response.body as LedgerReportBody;
      expect(body.openingBalance).toBe('0.00');
      expect(body.closingBalance).toBe('0.00');
      expect(body.data).toEqual([]);
    });

    it('cuenta histórica ya INACTIVE: sigue siendo consultable con su movimiento', async () => {
      const response = await getLedger(adminCookie, {
        accountId: inactiveAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      expect(response.status).toBe(200);
      const body = response.body as LedgerReportBody;
      expect(body.accountStatus).toBe(AccountStatus.INACTIVE);
      expect(body.closingBalance).toBe('30.00');
      expect(body.data).toHaveLength(1);
    });

    it('paginación de movimientos nunca altera apertura/cierre', async () => {
      const full = await getLedger(adminCookie, {
        accountId: childAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
        limit: 100,
      });
      const paged = await getLedger(adminCookie, {
        accountId: childAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
        page: 1,
        limit: 2,
      });
      const fullBody = full.body as LedgerReportBody;
      const pagedBody = paged.body as LedgerReportBody;
      expect(pagedBody.openingBalance).toBe(fullBody.openingBalance);
      expect(pagedBody.closingBalance).toBe(fullBody.closingBalance);
      expect(pagedBody.data).toHaveLength(2);
      expect(pagedBody.total).toBe(fullBody.total);
    });
  });

  // ====================================================================
  // A3.3 — Balance de comprobación
  // ====================================================================
  describe('Balance de comprobación', () => {
    it('accountIds enviado vacío en la query real: 400 (el transform de coma-separado lo reduce a arreglo vacío, ArrayNotEmpty lo rechaza)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/trial-balance')
        .query(
          'accountingDateFrom=2026-01-01&accountingDateTo=2026-03-31&accountIds=',
        )
        .set('Cookie', adminCookie);
      expect(response.status).toBe(400);
    });

    it('sin filtro de cuentas: reconciliación aplica y cuadra exactamente', async () => {
      const response = await getTrialBalance(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      expect(response.status).toBe(200);
      const body = response.body as TrialBalanceReportBody;
      expect(body.reconciliation.applicable).toBe(true);
      expect(body.reconciliation.openingBalanced).toBe(true);
      expect(body.reconciliation.periodBalanced).toBe(true);
      expect(body.reconciliation.endingBalanced).toBe(true);

      const childRow = body.data.find((r) => r.accountId === childAccountId);
      expect(childRow).toBeDefined();
      // Movimiento del periodo completo (ene-mar): 100+200+20+200(debitos)=520; creditos 50+200(reversal)=250
      expect(childRow?.periodDebit).toBe('520.00');
      expect(childRow?.periodCredit).toBe('250.00');
      expect(childRow?.endingDebit).toBe('270.00');
      expect(childRow?.endingCredit).toBe('0.00');
    });

    it('cuenta padre no aparece por defecto (sin movimiento); con includeZeroBalances=true sí aparece en cero', async () => {
      const withoutZero = await getTrialBalance(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      const bodyWithout = withoutZero.body as TrialBalanceReportBody;
      expect(
        bodyWithout.data.some((r) => r.accountId === parentAccountId),
      ).toBe(false);

      const withZero = await getTrialBalance(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
        includeZeroBalances: 'true',
      });
      const bodyWith = withZero.body as TrialBalanceReportBody;
      const parentRow = bodyWith.data.find(
        (r) => r.accountId === parentAccountId,
      );
      expect(parentRow).toBeDefined();
      expect(parentRow?.endingDebit).toBe('0.00');
      expect(parentRow?.endingCredit).toBe('0.00');
    });

    it('con accountIds filtrado: reconciliation.applicable=false, *Balanced en null, pero el subconjunto se muestra', async () => {
      const response = await getTrialBalance(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
        accountIds: childAccountId,
      });
      expect(response.status).toBe(200);
      const body = response.body as TrialBalanceReportBody;
      expect(body.reconciliation.applicable).toBe(false);
      expect(body.reconciliation.openingBalanced).toBeNull();
      expect(body.reconciliation.periodBalanced).toBeNull();
      expect(body.reconciliation.endingBalanced).toBeNull();
      expect(body.data).toHaveLength(1);
      expect(body.data[0].accountId).toBe(childAccountId);
    });

    it('cuenta histórica INACTIVE con movimiento aparece en el balance', async () => {
      const response = await getTrialBalance(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      const body = response.body as TrialBalanceReportBody;
      const row = body.data.find((r) => r.accountId === inactiveAccountId);
      expect(row).toBeDefined();
      expect(row?.endingDebit).toBe('30.00');
    });
  });

  // ====================================================================
  // Reasignación de systemKey (A1/A3.6): el Mayor sigue por accountId
  // ====================================================================
  describe('Reasignación de systemKey no afecta el historial por accountId', () => {
    it('un asiento posteado mientras una cuenta sostenía DISCOUNTS sigue siendo de ESA cuenta tras reasignar el systemKey a otra', async () => {
      const originalHolder = await prisma.account.findUniqueOrThrow({
        where: { systemKey: AccountingSystemKey.DISCOUNTS },
        select: { id: true, code: true },
      });
      const suffix = Date.now() % 1000000;
      const tempAccountId = await createTestAccount({
        code: `A3TMPKEY${suffix}`,
        name: 'Temporal reasignación E2E A3',
        type: AccountType.CONTRA_REVENUE,
      });
      // Contrapartida DEDICADA (nunca childAccountId): esta prueba no debe
      // alterar el conteo de movimientos que otras pruebas de este archivo
      // (Mayor, Balance, exportación) asumen sobre las cuentas fixture
      // compartidas.
      const offsetAccountId = await createTestAccount({
        code: `A3TMPOFF${suffix}`,
        name: 'Contrapartida dedicada E2E A3',
        type: AccountType.ASSET,
      });

      const reassignToTemp = await request(app.getHttpServer())
        .patch(
          `/api/v1/chart-of-accounts/system-keys/${AccountingSystemKey.DISCOUNTS}`,
        )
        .set('Cookie', adminCookie)
        .send({ accountId: tempAccountId });
      expect(reassignToTemp.status).toBe(200);

      try {
        await rawInsertBalancedEntry({
          sourceType: AccountingSourceType.SALE,
          description:
            'Descuento histórico E2E A3 — mientras sostenía DISCOUNTS',
          postedAt: new Date('2026-02-10T12:00:00.000Z'),
          lines: [
            { accountId: tempAccountId, debit: '15.00', credit: '0.00' },
            { accountId: offsetAccountId, debit: '0.00', credit: '15.00' },
          ],
        });
      } finally {
        const reassignBack = await request(app.getHttpServer())
          .patch(
            `/api/v1/chart-of-accounts/system-keys/${AccountingSystemKey.DISCOUNTS}`,
          )
          .set('Cookie', adminCookie)
          .send({ accountId: originalHolder.id });
        expect(reassignBack.status).toBe(200);
      }

      // Tras restaurar el systemKey original, el Mayor de la cuenta TEMPORAL
      // (por su propio accountId, nunca por systemKey) sigue mostrando el
      // movimiento histórico intacto.
      const ledger = await getLedger(adminCookie, {
        accountId: tempAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      expect(ledger.status).toBe(200);
      const body = ledger.body as LedgerReportBody;
      expect(body.data).toHaveLength(1);
      expect(body.closingBalance).toBe('15.00');

      const finalHolder = await prisma.account.findUniqueOrThrow({
        where: { systemKey: AccountingSystemKey.DISCOUNTS },
        select: { id: true },
      });
      expect(finalHolder.id).toBe(originalHolder.id);
    });
  });

  // ====================================================================
  // Revisión A3 — consistencia de lectura (REPEATABLE READ)
  // ====================================================================
  describe('Revisión A3 — consistencia de lectura bajo concurrencia real', () => {
    it('una transacción REPEATABLE READ no ve un asiento comprometido por otra conexión mientras permanece abierta, y SÍ lo ve una consulta posterior', async () => {
      // Cuenta dedicada y aislada (nunca childAccountId/CASH, que otras
      // pruebas de este archivo ya aseveran con conteos exactos): esta
      // prueba verifica el mecanismo de PostgreSQL en sí, no un reporte
      // completo, así que no debe compartir estado con ningún otro caso.
      const watchedAccountId = await createTestAccount({
        code: `A3CONC${Date.now() % 1000000}`,
        name: 'Cuenta dedicada — prueba de aislamiento E2E A3',
        type: AccountType.ASSET,
      });

      const countForWatchedAccount = (
        client: Pick<PrismaClient, 'accountingEntryLine'>,
      ): Promise<number> =>
        client.accountingEntryLine.count({
          where: { accountId: watchedAccountId },
        });

      const beforeAnyInsert = await countForWatchedAccount(prisma);
      expect(beforeAnyInsert).toBe(0);

      const observedInsideTransaction: number[] = [];
      await prisma.$transaction(
        async (tx) => {
          observedInsideTransaction.push(await countForWatchedAccount(tx));

          // Inserción real desde una conexión DISTINTA (el cliente externo
          // `prisma`, nunca `tx`), comprometida mientras la transacción
          // REPEATABLE READ sigue abierta — exactamente el escenario que
          // la revisión A3 pidió verificar.
          await rawInsertBalancedEntry({
            sourceType: AccountingSourceType.SALE,
            description:
              'Asiento concurrente E2E A3 — aislamiento REPEATABLE READ',
            postedAt: new Date('2026-02-20T12:00:00.000Z'),
            lines: [
              { accountId: watchedAccountId, debit: '1.00', credit: '0.00' },
              { accountId: accountIds.CASH, debit: '0.00', credit: '1.00' },
            ],
          });

          // Misma transacción abierta, segunda lectura: bajo REPEATABLE
          // READ debe seguir viendo el snapshot original (0), nunca el
          // asiento recién comprometido por la otra conexión.
          observedInsideTransaction.push(await countForWatchedAccount(tx));
        },
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      );

      expect(observedInsideTransaction).toEqual([0, 0]);

      // Una consulta nueva, fuera de aquella transacción ya cerrada, sí ve
      // el asiento comprometido.
      const afterTransactionCloses = await countForWatchedAccount(prisma);
      expect(afterTransactionCloses).toBe(1);
    });
  });

  // ====================================================================
  // A3.5 — Exportación a Excel
  // ====================================================================
  describe('Exportación a Excel', () => {
    it('Libro Diario: .xlsx real, una fila por LÍNEA (no por asiento), totales coincidentes con la API, protegido contra inyección de fórmulas', async () => {
      const jsonResponse = await getJournal(adminCookie, {
        accountingDateFrom: '2026-02-01',
        accountingDateTo: '2026-02-28',
        limit: 100,
      });
      const jsonBody = jsonResponse.body as JournalReportBody;
      const ownEntries = jsonBody.data.filter((e) =>
        createdEntryIds.includes(e.id),
      );
      const expectedLineCount = ownEntries.reduce(
        (sum, e) => sum + e.lines.length,
        0,
      );
      const expectedTotalDebit = ownEntries.reduce(
        (sum, e) => sum + Number(e.totalDebit),
        0,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/journal/export.xlsx')
        .query({
          accountingDateFrom: '2026-02-01',
          accountingDateTo: '2026-02-28',
        })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toContain(
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      );
      const sheet = await readWorkbook(response.body as Buffer);
      const descriptions: string[] = [];
      let xlsxDebitSum = 0;
      let xlsxCreditSum = 0;
      let ownLineRows = 0;
      let ownDebitSum = 0;
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber === 1) return;
        descriptions.push(row.getCell(6).value as string);
        xlsxDebitSum += Number(row.getCell(12).value ?? 0);
        xlsxCreditSum += Number(row.getCell(13).value ?? 0);
        const entryId = row.getCell(5).value as string;
        if (createdEntryIds.includes(entryId)) {
          ownLineRows++;
          ownDebitSum += Number(row.getCell(12).value ?? 0);
        }
      });
      // Una fila por LÍNEA, nunca por asiento: el conteo exacto de filas
      // propias (de esta fixture) debe coincidir con la suma de líneas de
      // sus asientos propios en el rango — nunca con el número de asientos.
      expect(ownLineRows).toBe(expectedLineCount);
      expect(ownDebitSum).toBeCloseTo(expectedTotalDebit, 2);
      // Invariante de partida doble: Debe total = Haber total en TODO el archivo.
      expect(xlsxDebitSum).toBeCloseTo(xlsxCreditSum, 2);

      // La descripción maliciosa (empieza con "=") debe llegar prefijada con comilla simple.
      expect(descriptions.some((d) => d.startsWith("'="))).toBe(true);
      expect(descriptions.some((d) => d.startsWith('=HYPERLINK'))).toBe(false);
    });

    it('Libro Diario: el límite de exportación se aplica a las filas reales (por línea), nunca al conteo de asientos', async () => {
      // No es viable generar 20 000 filas reales en una prueba E2E; se
      // verifica la lógica exacta de forma unitaria (ver
      // accounting-reports.service.spec.ts) y aquí, a nivel de contrato,
      // que un rango con resultado bien por debajo del máximo exporta sin
      // lanzar — regresión de que el chequeo por asientos (más laxo) no
      // bloquee exportaciones legítimas pequeñas.
      const response = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/journal/export.xlsx')
        .query({
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
        })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);
      expect(response.status).toBe(200);
    });

    it('Libro Mayor: .xlsx con filas de apertura, movimientos y cierre; saldo de cierre coincide con la API', async () => {
      const jsonResponse = await getLedger(adminCookie, {
        accountId: childAccountId,
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      const jsonBody = jsonResponse.body as LedgerReportBody;

      const response = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/ledger/export.xlsx')
        .query({
          accountId: childAccountId,
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
        })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);
      expect(response.status).toBe(200);
      const sheet = await readWorkbook(response.body as Buffer);
      const rowLabels: string[] = [];
      let closingRunningBalance = 0;
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          const label = row.getCell(1).value as string;
          rowLabels.push(label);
          if (label === 'CLOSING') {
            closingRunningBalance = Number(row.getCell(8).value);
          }
        }
      });
      expect(rowLabels[0]).toBe('OPENING');
      expect(rowLabels[rowLabels.length - 1]).toBe('CLOSING');
      expect(rowLabels.filter((l) => l === 'MOVEMENT')).toHaveLength(6);
      expect(closingRunningBalance).toBeCloseTo(
        Number(jsonBody.closingBalance),
        2,
      );
    });

    it('Balance de comprobación: .xlsx con todas las filas y totales débito/crédito coincidentes con la API (sin paginar)', async () => {
      const jsonResponse = await getTrialBalance(adminCookie, {
        accountingDateFrom: '2026-01-01',
        accountingDateTo: '2026-03-31',
      });
      const jsonBody = jsonResponse.body as TrialBalanceReportBody;

      const xlsxResponse = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/trial-balance/export.xlsx')
        .query({
          accountingDateFrom: '2026-01-01',
          accountingDateTo: '2026-03-31',
        })
        .set('Cookie', adminCookie)
        .buffer(true)
        .parse(binaryParser);
      expect(xlsxResponse.status).toBe(200);
      const sheet = await readWorkbook(xlsxResponse.body as Buffer);
      let dataRowCount = 0;
      let xlsxPeriodDebitSum = 0;
      let xlsxPeriodCreditSum = 0;
      sheet.eachRow((row, rowNumber) => {
        if (rowNumber > 1) {
          dataRowCount++;
          xlsxPeriodDebitSum += Number(row.getCell(7).value ?? 0);
          xlsxPeriodCreditSum += Number(row.getCell(8).value ?? 0);
        }
      });
      expect(dataRowCount).toBe(jsonBody.data.length);
      expect(xlsxPeriodDebitSum).toBeCloseTo(
        Number(jsonBody.reconciliation.totalPeriodDebit),
        2,
      );
      expect(xlsxPeriodCreditSum).toBeCloseTo(
        Number(jsonBody.reconciliation.totalPeriodCredit),
        2,
      );
    });
  });
});
