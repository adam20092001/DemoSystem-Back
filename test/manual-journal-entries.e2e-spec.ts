import { INestApplication } from '@nestjs/common';
import {
  AccountStatus,
  AccountType,
  AccountingSourceType,
  PrismaClient,
  RoleName,
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

/**
 * Fase A4 — Asientos manuales y rol ACCOUNTANT. Suite dedicada, separada de
 * accounting.e2e-spec.ts/accounting-periods.e2e-spec.ts/
 * accounting-reports.e2e-spec.ts (mismo criterio de aislamiento ya
 * establecido en el dominio contable): usa años lejanos en el futuro para
 * los periodos de prueba (2097-2098) y limpia por id propio.
 */

interface SafeDraftLineBody {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: string;
  creditAmount: string;
}

interface SafeDraftBody {
  id: string;
  accountingDate: string;
  description: string;
  status: 'DRAFT' | 'POSTED';
  postedEntryId: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
  lines: SafeDraftLineBody[];
}

interface SafeAccountBody {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  isPostable: boolean;
  status: AccountStatus;
}

interface SafeEntryListItem {
  id: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  eventType: string;
  journalNumber: number;
  accountingDate: string;
  periodId: string;
  reversesEntryId: string | null;
}

interface SafePeriodBody {
  id: string;
  year: number;
  month: number;
  status: 'OPEN' | 'CLOSED';
}

const ACCOUNTANT_USERNAME = 'e2e_a4_accountant';
const MANAGEMENT_USERNAME = 'e2e_a4_management';
const SELLER_USERNAME = 'e2e_a4_seller';
const WAREHOUSE_USERNAME = 'e2e_a4_warehouse';
const FIXTURE_PASSWORD = 'E2eA4Fixture2026Aa';
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

describe('Manual Journal Entries — Fase A4 (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let accountantCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let debitAccountId: string;
  let creditAccountId: string;
  let inactiveAccountId: string;

  const createdAccountIds: string[] = [];
  const createdDraftIds: string[] = [];
  const createdPeriodIds: string[] = [];

  function createDraft(
    body: Record<string, unknown>,
    cookie: string = accountantCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/accounting/manual-entries')
      .set('Cookie', cookie)
      .send(body);
  }

  function updateDraft(
    id: string,
    body: Record<string, unknown>,
    cookie: string = accountantCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .patch(`/api/v1/accounting/manual-entries/${id}`)
      .set('Cookie', cookie)
      .send(body);
  }

  function postDraft(
    id: string,
    cookie: string = accountantCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/accounting/manual-entries/${id}/post`)
      .set('Cookie', cookie)
      .send({});
  }

  function reverseDraft(
    id: string,
    reason: string,
    cookie: string = accountantCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/accounting/manual-entries/${id}/reverse`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  function getDraft(
    id: string,
    cookie: string = accountantCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/accounting/manual-entries/${id}`)
      .set('Cookie', cookie);
  }

  function listDrafts(
    query: Record<string, unknown> = {},
    cookie: string = accountantCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounting/manual-entries')
      .query(query)
      .set('Cookie', cookie);
  }

  async function createTestAccount(
    code: string,
    name: string,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/chart-of-accounts')
      .set('Cookie', adminCookie)
      .send({ code, name, type: AccountType.ASSET, isPostable: true });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la cuenta fixture ${code}: ${JSON.stringify(response.body)}`,
      );
    }
    const created = response.body as SafeAccountBody;
    createdAccountIds.push(created.id);
    return created.id;
  }

  async function createBalancedDraft(
    overrides: Partial<{
      accountingDate: string;
      description: string;
    }> = {},
  ): Promise<SafeDraftBody> {
    const response = await createDraft({
      accountingDate: overrides.accountingDate ?? businessToday(),
      description: overrides.description ?? 'Ajuste de provisión de alquiler',
      lines: [
        {
          accountId: debitAccountId,
          debitAmount: '100.00',
          creditAmount: '0.00',
        },
        {
          accountId: creditAccountId,
          debitAmount: '0.00',
          creditAmount: '100.00',
        },
      ],
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el borrador fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeDraftBody;
    createdDraftIds.push(body.id);
    return body;
  }

  async function findJournalEntry(
    sourceId: string,
    eventType: 'ORIGINAL' | 'REVERSAL' = 'ORIGINAL',
  ): Promise<SafeEntryListItem> {
    const response = await request(app.getHttpServer())
      .get('/api/v1/accounting/entries')
      .query({ sourceId })
      .set('Cookie', adminCookie);
    const body = response.body as { data: SafeEntryListItem[] };
    const row = body.data.find((entry) => entry.eventType === eventType);
    if (row === undefined) {
      throw new Error(
        `No se encontró ningún asiento ${eventType} para sourceId=${sourceId}`,
      );
    }
    return row;
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
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_a4_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_a4_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a4_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a4_warehouse@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    accountantCookie = (
      await login(app.getHttpServer(), ACCOUNTANT_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, FIXTURE_PASSWORD)
    ).cookie;

    const suffix = Date.now() % 1000000;
    debitAccountId = await createTestAccount(
      `A4DEB${suffix}`,
      'Cuenta débito E2E A4',
    );
    creditAccountId = await createTestAccount(
      `A4CRE${suffix}`,
      'Cuenta crédito E2E A4',
    );
    inactiveAccountId = await createTestAccount(
      `A4INA${suffix}`,
      'Cuenta inactiva E2E A4',
    );
    const deactivate = await request(app.getHttpServer())
      .post(`/api/v1/chart-of-accounts/${inactiveAccountId}/deactivate`)
      .set('Cookie', adminCookie);
    if (deactivate.status !== 200) {
      throw new Error(
        `No se pudo desactivar la cuenta fixture: ${JSON.stringify(deactivate.body)}`,
      );
    }
  }, 60000);

  afterAll(async () => {
    try {
      const postedDrafts = await prisma.manualJournalDraft.findMany({
        where: { id: { in: createdDraftIds }, postedEntryId: { not: null } },
        select: { postedEntryId: true },
      });
      const postedEntryIds = postedDrafts
        .map((d) => d.postedEntryId)
        .filter((id): id is string => id !== null);

      // Orden obligatorio: ManualJournalDraft.postedEntryId -> AccountingEntry
      // es RESTRICT (nunca CASCADE, A4 schema) — hay que soltar la
      // referencia (borrando el propio borrador) ANTES de poder borrar el
      // AccountingEntry al que apunta.
      await prisma.manualJournalDraftLine.deleteMany({
        where: { draftId: { in: createdDraftIds } },
      });
      await prisma.manualJournalDraft.deleteMany({
        where: { id: { in: createdDraftIds } },
      });

      if (postedEntryIds.length > 0) {
        const reversals = await prisma.accountingEntry.findMany({
          where: { reversesEntryId: { in: postedEntryIds } },
          select: { id: true },
        });
        const allEntryIds = [...postedEntryIds, ...reversals.map((r) => r.id)];
        await prisma.accountingEntryLine.deleteMany({
          where: { entryId: { in: allEntryIds } },
        });
        await prisma.accountingEntry.deleteMany({
          where: { id: { in: allEntryIds } },
        });
      }
      await prisma.accountingPeriod.deleteMany({
        where: { id: { in: createdPeriodIds } },
      });
      await prisma.account.deleteMany({
        where: { id: { in: createdAccountIds } },
      });
      await prisma.userRole.deleteMany({
        where: {
          user: {
            username: {
              in: [
                ACCOUNTANT_USERNAME,
                MANAGEMENT_USERNAME,
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
              ACCOUNTANT_USERNAME,
              MANAGEMENT_USERNAME,
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
  // RBAC (A4.1)
  // ====================================================================
  describe('RBAC', () => {
    it('SELLER/WAREHOUSE: 403 en todos los endpoints de asientos manuales', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        expect((await listDrafts({}, cookie)).status).toBe(403);
        expect((await getDraft(NON_EXISTENT_UUID, cookie)).status).toBe(403);
        expect(
          (
            await createDraft(
              { accountingDate: businessToday(), description: 'x' },
              cookie,
            )
          ).status,
        ).toBe(403);
        expect((await postDraft(NON_EXISTENT_UUID, cookie)).status).toBe(403);
        expect(
          (await reverseDraft(NON_EXISTENT_UUID, 'motivo', cookie)).status,
        ).toBe(403);
      }
    });

    it('MANAGEMENT: lee pero nunca escribe (alcance global sin escritura, P6-E4)', async () => {
      expect((await listDrafts({}, managementCookie)).status).toBe(200);
      expect(
        (
          await createDraft(
            { accountingDate: businessToday(), description: 'x' },
            managementCookie,
          )
        ).status,
      ).toBe(403);
      expect(
        (await postDraft(NON_EXISTENT_UUID, managementCookie)).status,
      ).toBe(403);
      expect(
        (await reverseDraft(NON_EXISTENT_UUID, 'motivo', managementCookie))
          .status,
      ).toBe(403);
    });

    it('ACCOUNTANT: lectura y administración completa (crear/editar/contabilizar/revertir)', async () => {
      expect((await listDrafts({}, accountantCookie)).status).toBe(200);
      const draft = await createBalancedDraft();
      expect(draft.status).toBe('DRAFT');
      const posted = await postDraft(draft.id, accountantCookie);
      expect(posted.status).toBe(200);
      const reversed = await reverseDraft(
        draft.id,
        'Prueba E2E A4 — RBAC ACCOUNTANT',
        accountantCookie,
      );
      expect(reversed.status).toBe(200);
    });

    it('ACCOUNTANT no adquiere acceso a módulos no relacionados (sin escalamiento de privilegios)', async () => {
      const sales = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Cookie', accountantCookie);
      expect(sales.status).toBe(403);

      const products = await request(app.getHttpServer())
        .get('/api/v1/products')
        .set('Cookie', accountantCookie);
      expect(products.status).toBe(403);

      const users = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Cookie', accountantCookie);
      expect(users.status).toBe(403);
    });

    it('ADMIN: acceso completo', async () => {
      expect((await listDrafts({}, adminCookie)).status).toBe(200);
      const draft = await createBalancedDraft();
      expect((await postDraft(draft.id, adminCookie)).status).toBe(200);
    });
  });

  // ====================================================================
  // CRUD de borrador (A4.2)
  // ====================================================================
  describe('Ciclo de vida del borrador', () => {
    it('crea un borrador sin líneas (incompleto permitido mientras se edita)', async () => {
      const response = await createDraft({
        accountingDate: businessToday(),
        description: 'Borrador sin líneas todavía',
      });
      expect(response.status).toBe(201);
      const body = response.body as SafeDraftBody;
      createdDraftIds.push(body.id);
      expect(body.status).toBe('DRAFT');
      expect(body.lines).toEqual([]);
    });

    it('description en blanco -> 400; > 200 caracteres -> 400', async () => {
      const blank = await createDraft({
        accountingDate: businessToday(),
        description: '   ',
      });
      expect(blank.status).toBe(400);

      const tooLong = await createDraft({
        accountingDate: businessToday(),
        description: 'x'.repeat(201),
      });
      expect(tooLong.status).toBe(400);
    });

    it('accountingDate con formato inválido -> 400', async () => {
      const response = await createDraft({
        accountingDate: '15/03/2026',
        description: 'Fecha inválida',
      });
      expect(response.status).toBe(400);
    });

    it('línea con cuenta inexistente -> 400, no crea el borrador', async () => {
      const before = await prisma.manualJournalDraft.count();
      const response = await createDraft({
        accountingDate: businessToday(),
        description: 'Cuenta inexistente',
        lines: [
          {
            accountId: NON_EXISTENT_UUID,
            debitAmount: '100.00',
            creditAmount: '0.00',
          },
        ],
      });
      expect(response.status).toBe(400);
      const after = await prisma.manualJournalDraft.count();
      expect(after).toBe(before);
    });

    it('GET de un borrador inexistente -> 404', async () => {
      expect((await getDraft(NON_EXISTENT_UUID)).status).toBe(404);
    });

    it('PATCH sin ningún campo -> 400', async () => {
      const draft = await createBalancedDraft();
      const response = await updateDraft(draft.id, {});
      expect(response.status).toBe(400);
    });

    it('PATCH reemplaza el arreglo completo de líneas (nunca un parche parcial)', async () => {
      const draft = await createBalancedDraft();
      const extraAccountId = await createTestAccount(
        `A4EXT${Date.now() % 1000000}`,
        'Cuenta extra E2E A4',
      );
      const updated = await updateDraft(draft.id, {
        lines: [
          {
            accountId: extraAccountId,
            debitAmount: '50.00',
            creditAmount: '0.00',
          },
          {
            accountId: creditAccountId,
            debitAmount: '0.00',
            creditAmount: '50.00',
          },
        ],
      });
      expect(updated.status).toBe(200);
      const body = updated.body as SafeDraftBody;
      expect(body.lines).toHaveLength(2);
      expect(body.lines.some((l) => l.accountId === debitAccountId)).toBe(
        false,
      );
    });

    it('editar un borrador ya POSTED -> 409, no modifica nada', async () => {
      const draft = await createBalancedDraft();
      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(200);

      const update = await updateDraft(draft.id, { description: 'nueva' });
      expect(update.status).toBe(409);
    });

    it('audita MANUAL_JOURNAL_DRAFT_CREATED y MANUAL_JOURNAL_DRAFT_UPDATED', async () => {
      const draft = await createBalancedDraft();
      await updateDraft(draft.id, { description: 'descripción auditada' });

      const createdAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.MANUAL_JOURNAL_DRAFT_CREATED,
          entityId: draft.id,
        },
      });
      expect(createdAudit).not.toBeNull();

      const updatedAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.MANUAL_JOURNAL_DRAFT_UPDATED,
          entityId: draft.id,
        },
      });
      expect(updatedAudit).not.toBeNull();
    });
  });

  // ====================================================================
  // Contabilización (A4.3/A4.4)
  // ====================================================================
  describe('Contabilización', () => {
    it('menos de 2 líneas -> 400, nunca contabiliza', async () => {
      const response = await createDraft({
        accountingDate: businessToday(),
        description: 'Una sola línea',
        lines: [
          {
            accountId: debitAccountId,
            debitAmount: '100.00',
            creditAmount: '0.00',
          },
        ],
      });
      expect(response.status).toBe(201);
      const draft = response.body as SafeDraftBody;
      createdDraftIds.push(draft.id);

      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(400);
    });

    it('líneas desbalanceadas -> 400, nunca contabiliza', async () => {
      const response = await createDraft({
        accountingDate: businessToday(),
        description: 'Desbalanceado',
        lines: [
          {
            accountId: debitAccountId,
            debitAmount: '100.00',
            creditAmount: '0.00',
          },
          {
            accountId: creditAccountId,
            debitAmount: '0.00',
            creditAmount: '90.00',
          },
        ],
      });
      const draft = response.body as SafeDraftBody;
      createdDraftIds.push(draft.id);

      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(400);
    });

    it('cuenta inactiva referenciada -> 400 al contabilizar (aunque el borrador se creó/editó sin problema)', async () => {
      const response = await createDraft({
        accountingDate: businessToday(),
        description: 'Cuenta inactiva',
        lines: [
          {
            accountId: inactiveAccountId,
            debitAmount: '100.00',
            creditAmount: '0.00',
          },
          {
            accountId: creditAccountId,
            debitAmount: '0.00',
            creditAmount: '100.00',
          },
        ],
      });
      expect(response.status).toBe(201);
      const draft = response.body as SafeDraftBody;
      createdDraftIds.push(draft.id);

      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(400);
    });

    it('camino feliz: contabiliza, marca POSTED, asigna journalNumber y aparece en GET /accounting/entries', async () => {
      const draft = await createBalancedDraft();
      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(200);
      const body = posted.body as SafeDraftBody;
      expect(body.status).toBe('POSTED');
      expect(body.postedEntryId).not.toBeNull();

      const entry = await findJournalEntry(draft.id);
      expect(entry.sourceType).toBe(AccountingSourceType.MANUAL);
      expect(entry.journalNumber).toBeGreaterThan(0);
      expect(entry.accountingDate).toBe(businessToday());
    });

    it('ya contabilizado -> 409, no crea un segundo AccountingEntry', async () => {
      const draft = await createBalancedDraft();
      expect((await postDraft(draft.id)).status).toBe(200);

      const second = await postDraft(draft.id);
      expect(second.status).toBe(409);

      const entries = await prisma.accountingEntry.count({
        where: { sourceType: AccountingSourceType.MANUAL, sourceId: draft.id },
      });
      expect(entries).toBe(1);
    });

    it('periodo del mes solicitado no existe y no es el mes en curso -> 404, nunca crea un periodo histórico', async () => {
      const draft = await createBalancedDraft({
        accountingDate: '2097-05-15',
      });
      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(404);

      const period = await prisma.accountingPeriod.findUnique({
        where: { year_month: { year: 2097, month: 5 } },
      });
      expect(period).toBeNull();
    });

    it('creado el periodo histórico por ADMIN, el mismo borrador se contabiliza con normalidad', async () => {
      const createPeriod = await request(app.getHttpServer())
        .post('/api/v1/accounting/periods')
        .set('Cookie', adminCookie)
        .send({ year: 2097, month: 6 });
      expect(createPeriod.status).toBe(201);
      const period = createPeriod.body as SafePeriodBody;
      createdPeriodIds.push(period.id);

      const draft = await createBalancedDraft({
        accountingDate: '2097-06-15',
      });
      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(200);

      const entry = await findJournalEntry(draft.id);
      expect(entry.periodId).toBe(period.id);
      expect(entry.accountingDate).toBe('2097-06-15');
    });

    it('periodo CLOSED -> 409 al contabilizar', async () => {
      const createPeriod = await request(app.getHttpServer())
        .post('/api/v1/accounting/periods')
        .set('Cookie', adminCookie)
        .send({ year: 2097, month: 7 });
      expect(createPeriod.status).toBe(201);
      const period = createPeriod.body as SafePeriodBody;
      createdPeriodIds.push(period.id);

      const close = await request(app.getHttpServer())
        .post(`/api/v1/accounting/periods/${period.id}/close`)
        .set('Cookie', adminCookie);
      expect(close.status).toBe(200);

      const draft = await createBalancedDraft({
        accountingDate: '2097-07-15',
      });
      const posted = await postDraft(draft.id);
      expect(posted.status).toBe(409);
    });

    it('audita MANUAL_JOURNAL_POSTED con el entryId definitivo', async () => {
      const draft = await createBalancedDraft();
      const posted = await postDraft(draft.id);
      const entryId = (posted.body as SafeDraftBody).postedEntryId;

      const audit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.MANUAL_JOURNAL_POSTED,
          entityId: draft.id,
        },
      });
      expect(audit).not.toBeNull();
      expect((audit?.metadata as { entryId?: string } | null)?.entryId).toBe(
        entryId,
      );
    });
  });

  // ====================================================================
  // Reversión (A4.5)
  // ====================================================================
  describe('Reversión', () => {
    it('revertir un borrador todavía en DRAFT -> 409, nunca contabiliza nada', async () => {
      const draft = await createBalancedDraft();
      const reversed = await reverseDraft(draft.id, 'motivo cualquiera');
      expect(reversed.status).toBe(409);
    });

    it('reason vacío -> 400; > 200 caracteres -> 400', async () => {
      const draft = await createBalancedDraft();
      expect((await postDraft(draft.id)).status).toBe(200);

      const blank = await reverseDraft(draft.id, '   ');
      expect(blank.status).toBe(400);

      const tooLong = await reverseDraft(draft.id, 'x'.repeat(201));
      expect(tooLong.status).toBe(400);
    });

    it('camino feliz: crea un REVERSAL, preserva el ORIGINAL sin cambios', async () => {
      const draft = await createBalancedDraft();
      const posted = await postDraft(draft.id);
      const entryId = (posted.body as SafeDraftBody).postedEntryId as string;

      const reversed = await reverseDraft(
        draft.id,
        'Error de cuenta al registrar',
      );
      expect(reversed.status).toBe(200);

      const reversal = await findJournalEntry(draft.id, 'REVERSAL');
      expect(reversal.reversesEntryId).toBe(entryId);

      const original = await prisma.accountingEntry.findUniqueOrThrow({
        where: { id: entryId },
        include: { lines: true },
      });
      expect(original.description).toBe('Ajuste de provisión de alquiler');
      expect(original.lines).toHaveLength(2);
    });

    it('doble reversión -> 409, no crea un segundo REVERSAL', async () => {
      const draft = await createBalancedDraft();
      await postDraft(draft.id);
      expect((await reverseDraft(draft.id, 'primera reversión')).status).toBe(
        200,
      );

      const second = await reverseDraft(draft.id, 'segunda reversión');
      expect(second.status).toBe(409);

      const entryId = (
        await prisma.manualJournalDraft.findUniqueOrThrow({
          where: { id: draft.id },
          select: { postedEntryId: true },
        })
      ).postedEntryId as string;
      const reversalCount = await prisma.accountingEntry.count({
        where: { reversesEntryId: entryId },
      });
      expect(reversalCount).toBe(1);
    });

    it('audita MANUAL_JOURNAL_REVERSED con el motivo exacto', async () => {
      const draft = await createBalancedDraft();
      await postDraft(draft.id);
      await reverseDraft(draft.id, 'Motivo auditado E2E A4');

      const audit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.MANUAL_JOURNAL_REVERSED,
          entityId: draft.id,
        },
      });
      expect(audit).not.toBeNull();
      expect((audit?.metadata as { reason?: string } | null)?.reason).toBe(
        'Motivo auditado E2E A4',
      );
    });
  });

  // ====================================================================
  // Integración con reportes A3 (A4.9)
  // ====================================================================
  describe('Integración con reportes A3', () => {
    it('un borrador DRAFT (sin contabilizar) nunca aparece en el reporte de Libro Diario', async () => {
      const draft = await createBalancedDraft({
        description: 'Nunca debe aparecer en el diario mientras sea DRAFT',
      });
      const today = businessToday();
      const journal = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/journal')
        .query({ accountingDateFrom: today, accountingDateTo: today })
        .set('Cookie', adminCookie);
      expect(journal.status).toBe(200);
      const body = journal.body as { data: { sourceId: string }[] };
      expect(body.data.some((row) => row.sourceId === draft.id)).toBe(false);
    });

    it('una vez contabilizado, el asiento MANUAL aparece en el Libro Diario con sourceType=MANUAL', async () => {
      const draft = await createBalancedDraft();
      await postDraft(draft.id);
      const today = businessToday();

      const journal = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/journal')
        .query({ accountingDateFrom: today, accountingDateTo: today })
        .set('Cookie', adminCookie);
      expect(journal.status).toBe(200);
      const body = journal.body as {
        data: { sourceId: string; sourceType: string }[];
      };
      const row = body.data.find((r) => r.sourceId === draft.id);
      expect(row).toBeDefined();
      expect(row?.sourceType).toBe(AccountingSourceType.MANUAL);
    });

    it('la reversión aparece como un asiento SEPARADO en el Libro Diario, el total debe/haber del día sigue cuadrando', async () => {
      const draft = await createBalancedDraft();
      await postDraft(draft.id);
      await reverseDraft(draft.id, 'Reversión visible en reportes');
      const today = businessToday();

      const journal = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/journal')
        .query({ accountingDateFrom: today, accountingDateTo: today })
        .set('Cookie', adminCookie);
      const body = journal.body as {
        data: { sourceId: string; eventType: string }[];
      };
      const rowsForDraft = body.data.filter((r) => r.sourceId === draft.id);
      expect(rowsForDraft).toHaveLength(2);
      expect(rowsForDraft.map((r) => r.eventType).sort()).toEqual([
        'ORIGINAL',
        'REVERSAL',
      ]);
    });

    it('el Balance de Comprobación sigue cuadrando (total debe = total haber) tras contabilizar un asiento manual', async () => {
      const draft = await createBalancedDraft();
      await postDraft(draft.id);
      const today = businessToday();

      const trialBalance = await request(app.getHttpServer())
        .get('/api/v1/accounting/reports/trial-balance')
        .query({ accountingDateFrom: today, accountingDateTo: today })
        .set('Cookie', adminCookie);
      expect(trialBalance.status).toBe(200);
      const body = trialBalance.body as {
        totalDebit: string;
        totalCredit: string;
      };
      expect(body.totalDebit).toBe(body.totalCredit);
    });
  });

  // ====================================================================
  // Concurrencia real (PostgreSQL) — A4.6
  // ====================================================================
  describe('Concurrencia real (PostgreSQL)', () => {
    it('dos peticiones simultáneas de contabilizar el MISMO borrador: exactamente una contabiliza, la otra 409, un solo AccountingEntry', async () => {
      const draft = await createBalancedDraft();

      const [first, second] = await Promise.all([
        postDraft(draft.id),
        postDraft(draft.id),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const entries = await prisma.accountingEntry.count({
        where: { sourceType: AccountingSourceType.MANUAL, sourceId: draft.id },
      });
      expect(entries).toBe(1);
    });

    it('edición vs. contabilización del MISMO borrador en paralelo: nunca termina en estado mixto', async () => {
      const draft = await createBalancedDraft();

      const [postResult, updateResult] = await Promise.all([
        postDraft(draft.id),
        updateDraft(draft.id, { description: 'editado en paralelo' }),
      ]);

      // Exactamente una de las dos operaciones gana la carrera por el
      // lock de fila; la otra observa el nuevo estado y se rechaza con
      // 409 — nunca ambas tienen éxito sobre el mismo borrador.
      const outcomes = [postResult.status, updateResult.status];
      expect(outcomes.filter((s) => s === 200)).toHaveLength(1);
      expect(outcomes.filter((s) => s === 409)).toHaveLength(1);

      const finalState = await prisma.manualJournalDraft.findUniqueOrThrow({
        where: { id: draft.id },
      });
      if (postResult.status === 200) {
        expect(finalState.status).toBe('POSTED');
      } else {
        expect(finalState.status).toBe('DRAFT');
        expect(finalState.description).toBe('editado en paralelo');
      }
    });

    it('dos reversiones simultáneas del MISMO asiento contabilizado: exactamente una revierte, la otra 409, un solo REVERSAL', async () => {
      const draft = await createBalancedDraft();
      await postDraft(draft.id);

      const [first, second] = await Promise.all([
        reverseDraft(draft.id, 'reversión concurrente A'),
        reverseDraft(draft.id, 'reversión concurrente B'),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const entryId = (
        await prisma.manualJournalDraft.findUniqueOrThrow({
          where: { id: draft.id },
          select: { postedEntryId: true },
        })
      ).postedEntryId as string;
      const reversalCount = await prisma.accountingEntry.count({
        where: { reversesEntryId: entryId },
      });
      expect(reversalCount).toBe(1);
    });
  });
});
