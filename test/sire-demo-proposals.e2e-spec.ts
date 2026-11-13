import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { DEMO_V1_COLUMNS_LINE } from '../src/sire-demo/core/demo-proposal.parser';
import { CURRENT_FIXTURE_SET } from '../src/sire-demo/fixtures/fixture-registry';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';
import {
  createSireDemoE2eApp,
  snapshotSireDemoEnv,
} from './helpers/sire-demo-app';

const BASE = '/api/v1/sire-demo/proposals';
/** Prefijo de los archivos de esta suite: permite limpiar solo lo propio. */
const PREFIX = 'e2e-s2-';

const USERS = {
  ACCOUNTANT: {
    name: 'e2e_accountant_sire_s2',
    password: 'AccountantSireS2Demo123',
    role: RoleName.ACCOUNTANT,
  },
  MANAGEMENT: {
    name: 'e2e_management_sire_s2',
    password: 'ManagementSireS2Demo123',
    role: RoleName.MANAGEMENT,
  },
  SELLER: {
    name: 'e2e_seller_sire_s2',
    password: 'SellerSireS2Demo123',
    role: RoleName.SELLER,
  },
  WAREHOUSE: {
    name: 'e2e_warehouse_sire_s2',
    password: 'WarehouseSireS2Demo123',
    role: RoleName.WAREHOUSE,
  },
} as const;

function row(n: number, month = '01'): string {
  const number = String(n).padStart(8, '0');
  return `01|F001|${number}|05/${month}/2099|6|99999000001|CLIENTE SENSIBLE SAC|PEN|847.46|152.54|1000.00`;
}

/** Archivo POS/RVIE de `count` filas con numeración desde `start` (hash distinto por start). */
function posFile(
  period: string,
  count: number,
  start = 1,
  register: 'RVIE' | 'RCE' = 'RVIE',
): Buffer {
  const month = period.slice(4);
  const rows = Array.from({ length: count }, (_, i) =>
    register === 'RCE'
      ? row(start + i, month).replace('|6|99999000001|', '|6|99999100001|')
      : row(start + i, month),
  );
  return Buffer.from(
    `#DEMO_V1|SOURCE=POS|REGISTER=${register}|PERIOD=${period}\n${DEMO_V1_COLUMNS_LINE}\n${rows.join('\n')}\n`,
    'utf8',
  );
}

interface ProposalBody {
  mode: string;
  officialValidity: boolean;
  reused: boolean;
  proposal: {
    id: string;
    source: string;
    register: string;
    period: string;
    fixtureSetVersion: string | null;
    fileHash: string;
    rowCount: number;
    status: string;
    reconcilable: boolean;
    discardedAt: string | null;
    discardedBy: { username: string } | null;
    createdBy: { username: string };
  };
}

describe('SIRE DEMO S2 — propuestas (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let restoreEnv: () => void;
  const cookies: Record<string, string> = {};

  const upload = (
    who: string,
    fields: { source: string; register: string; period: string },
    file: Buffer | null,
    fileName = `${PREFIX}file.txt`,
  ) => {
    const req = request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookies[who] ?? '')
      .field('source', fields.source)
      .field('register', fields.register)
      .field('period', fields.period);
    return file ? req.attach('file', file, fileName) : req;
  };
  const uploadPos = (
    period: string,
    count: number,
    start = 1,
    register: 'RVIE' | 'RCE' = 'RVIE',
    who = 'ADMIN',
  ) =>
    upload(
      who,
      { source: 'POS', register, period },
      posFile(period, count, start, register),
    );
  const get = (url: string, who = 'ADMIN') =>
    request(app.getHttpServer())
      .get(url)
      .set('Cookie', cookies[who] ?? '');
  const discard = (id: string, who = 'ADMIN') =>
    request(app.getHttpServer())
      .post(`${BASE}/${id}/discard`)
      .set('Cookie', cookies[who] ?? '');

  async function cleanup(): Promise<void> {
    const proposals = await prisma.sireDemoProposal.findMany({
      where: { fileName: { startsWith: PREFIX } },
      select: { id: true },
    });
    const ids = proposals.map((p) => p.id);
    await prisma.auditLog.deleteMany({
      where: {
        action: {
          in: ['SIRE_DEMO_PROPOSAL_IMPORTED', 'SIRE_DEMO_PROPOSAL_DISCARDED'],
        },
        entityId: { in: ids },
      },
    });
    await prisma.sireDemoProposalLine.deleteMany({
      where: { proposalId: { in: ids } },
    });
    await prisma.sireDemoProposal.deleteMany({ where: { id: { in: ids } } });
  }

  const commercialCounts = async () => ({
    sales: await prisma.sale.count(),
    documents: await prisma.electronicDocument.count(),
    purchases: await prisma.purchaseInvoice.count(),
    entries: await prisma.accountingEntry.count(),
    stock: await prisma.inventoryMovement.count(),
  });

  beforeAll(async () => {
    restoreEnv = snapshotSireDemoEnv();
    prisma = createTestPrismaClient();
    app = await createSireDemoE2eApp({ enabled: true, fixtures: true });
    for (const user of Object.values(USERS)) {
      await upsertFixtureUser(prisma, {
        username: user.name,
        email: `${user.name}@demosystem.test`,
        password: user.password,
        roleName: user.role,
      });
    }
    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    cookies.ADMIN = adminLogin.cookie;
    for (const [key, user] of Object.entries(USERS)) {
      cookies[key] = (
        await login(app.getHttpServer(), user.name, user.password)
      ).cookie;
    }
    await cleanup();
  }, 90000);

  afterAll(async () => {
    await cleanup();
    await app.close();
    await prisma.$disconnect();
    restoreEnv();
  });

  describe('carga válida, idempotencia y descarte', () => {
    let firstId = '';

    it('carga RVIE POS: 201, modo DEMO, sin validez oficial, hash SHA-256 y auditoría sin datos sensibles', async () => {
      const before = await commercialCounts();
      const res = await uploadPos('209901', 3);
      expect(res.status).toBe(201);
      const body = res.body as ProposalBody;
      expect(body.mode).toBe('DEMO');
      expect(body.officialValidity).toBe(false);
      expect(body.reused).toBe(false);
      expect(body.proposal).toMatchObject({
        source: 'POS',
        register: 'RVIE',
        period: '209901',
        fixtureSetVersion: null,
        rowCount: 3,
        status: 'IMPORTED',
        reconcilable: true,
        discardedAt: null,
        discardedBy: null,
      });
      expect(body.proposal.fileHash).toMatch(/^[0-9a-f]{64}$/);
      firstId = body.proposal.id;

      expect(
        await prisma.sireDemoProposalLine.count({
          where: { proposalId: firstId },
        }),
      ).toBe(3);

      const audits = await prisma.auditLog.findMany({
        where: {
          action: 'SIRE_DEMO_PROPOSAL_IMPORTED',
          entityId: firstId,
        },
      });
      expect(audits).toHaveLength(1);
      const serialized = JSON.stringify(audits[0]);
      expect(serialized).not.toContain('99999000001');
      expect(serialized).not.toContain('CLIENTE SENSIBLE');
      expect(serialized).not.toContain('1000.00');
      expect(Object.keys(audits[0].metadata as object).sort()).toEqual([
        'fileSizeBytes',
        'fixtureSetVersion',
        'period',
        'proposalId',
        'register',
        'rowCount',
        'source',
      ]);
      expect(await commercialCounts()).toEqual(before);
    });

    it('carga RCE POS válida', async () => {
      const res = await uploadPos('209901', 2, 1, 'RCE', 'ACCOUNTANT');
      expect(res.status).toBe(201);
      expect((res.body as ProposalBody).proposal.register).toBe('RCE');
      expect((res.body as ProposalBody).proposal.createdBy.username).toBe(
        USERS.ACCOUNTANT.name,
      );
    });

    it('idempotencia: el mismo archivo activo responde 200 reused=true, sin duplicar filas ni auditoría', async () => {
      const res = await uploadPos('209901', 3);
      expect(res.status).toBe(200);
      const body = res.body as ProposalBody;
      expect(body.reused).toBe(true);
      expect(body.proposal.id).toBe(firstId);
      expect(
        await prisma.sireDemoProposal.count({
          where: { fileName: { startsWith: PREFIX }, period: '209901' },
        }),
      ).toBe(2); // RVIE + RCE
      expect(
        await prisma.sireDemoProposalLine.count({
          where: { proposalId: firstId },
        }),
      ).toBe(3);
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'SIRE_DEMO_PROPOSAL_IMPORTED',
            entityId: firstId,
          },
        }),
      ).toBe(1);
    });

    it('descarte lógico: conserva líneas, registra usuario/fecha y audita sin datos sensibles', async () => {
      const res = await discard(firstId, 'ACCOUNTANT');
      expect(res.status).toBe(200);
      const body = res.body as ProposalBody;
      expect(body.proposal.status).toBe('DISCARDED');
      expect(body.proposal.reconcilable).toBe(false);
      expect(body.proposal.discardedAt).not.toBeNull();
      expect(body.proposal.discardedBy?.username).toBe(USERS.ACCOUNTANT.name);
      expect(
        await prisma.sireDemoProposalLine.count({
          where: { proposalId: firstId },
        }),
      ).toBe(3);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: { action: 'SIRE_DEMO_PROPOSAL_DISCARDED', entityId: firstId },
      });
      expect(Object.keys(audit.metadata as object).sort()).toEqual([
        'period',
        'proposalId',
        'register',
        'source',
      ]);
    });

    it('descarte repetido: 409 sin segunda auditoría; inexistente 404; id inválido 400', async () => {
      const again = await discard(firstId);
      expect(again.status).toBe(409);
      expect((again.body as { code: string }).code).toBe(
        'SIRE_PROPOSAL_ALREADY_DISCARDED',
      );
      expect(
        await prisma.auditLog.count({
          where: { action: 'SIRE_DEMO_PROPOSAL_DISCARDED', entityId: firstId },
        }),
      ).toBe(1);
      const missing = await discard('11111111-1111-4111-8111-111111111111');
      expect(missing.status).toBe(404);
      expect((missing.body as { code: string }).code).toBe(
        'SIRE_PROPOSAL_NOT_FOUND',
      );
      expect((await discard('no-es-uuid')).status).toBe(400);
    });

    it('un archivo descartado puede cargarse de nuevo como propuesta nueva', async () => {
      const res = await uploadPos('209901', 3);
      expect(res.status).toBe(201);
      expect((res.body as ProposalBody).proposal.id).not.toBe(firstId);
    });
  });

  describe('validación de archivos (todo o nada)', () => {
    const expectRejected = (
      res: request.Response,
      status: number,
      code?: string,
    ) => {
      expect(res.status).toBe(status);
      if (code) {
        expect((res.body as { code: string }).code).toBe(code);
      }
    };
    const countFor = (period: string) =>
      prisma.sireDemoProposal.count({
        where: { period, fileName: { startsWith: PREFIX } },
      });

    it('una fila inválida rechaza todo el archivo y no persiste nada', async () => {
      const text = posFile('209902', 4).toString('utf8').split('\n');
      text[4] = '01|F-01|3|05/02/2099|6|99999000001|X|PEN|1.00|0.00|1.00';
      const res = await upload(
        'ADMIN',
        { source: 'POS', register: 'RVIE', period: '209902' },
        Buffer.from(text.join('\n'), 'utf8'),
      );
      expectRejected(res, 400, 'SIRE_FILE_INVALID');
      expect(Array.isArray((res.body as { message: unknown }).message)).toBe(
        true,
      );
      expect(await countFor('209902')).toBe(0);
      expect(
        await prisma.sireDemoProposalLine.count({
          where: { proposal: { period: '209902' } },
        }),
      ).toBe(0);
    });

    it('archivo ausente, vacío, extensión distinta de .txt y cabecera que no coincide', async () => {
      const fields = { source: 'POS', register: 'RVIE', period: '209902' };
      expectRejected(
        await upload('ADMIN', fields, null),
        400,
        'SIRE_FILE_REQUIRED',
      );
      expectRejected(
        await upload('ADMIN', fields, Buffer.alloc(0)),
        400,
        'SIRE_FILE_REQUIRED',
      );
      expectRejected(
        await upload(
          'ADMIN',
          fields,
          posFile('209902', 1),
          `${PREFIX}file.csv`,
        ),
        400,
        'SIRE_FILE_EXTENSION_INVALID',
      );
      expectRejected(
        await upload(
          'ADMIN',
          { ...fields, period: '209903' },
          posFile('209902', 1),
        ),
        400,
        'SIRE_FILE_INVALID',
      );
      expectRejected(
        await upload(
          'ADMIN',
          { ...fields, register: 'RCE' },
          posFile('209902', 1),
        ),
        400,
        'SIRE_FILE_INVALID',
      );
      expect(
        (
          await upload(
            'ADMIN',
            { source: 'X', register: 'RVIE', period: '209902' },
            posFile('209902', 1),
          )
        ).status,
      ).toBe(400);
      expect(await countFor('209902')).toBe(0);
    });

    it('límites: 5000 filas se aceptan; 5001 se rechazan; más de 2 MB responde 413', async () => {
      const ok = await uploadPos('209905', 5000);
      expect(ok.status).toBe(201);
      const id = (ok.body as ProposalBody).proposal.id;
      expect(
        await prisma.sireDemoProposalLine.count({ where: { proposalId: id } }),
      ).toBe(5000);

      expectRejected(
        await uploadPos('209905', 5001, 10000),
        400,
        'SIRE_FILE_INVALID',
      );
      expect(await countFor('209905')).toBe(1);

      const big = Buffer.alloc(2 * 1024 * 1024 + 10, 'a');
      expect(
        (
          await upload(
            'ADMIN',
            { source: 'POS', register: 'RVIE', period: '209905' },
            big,
          )
        ).status,
      ).toBe(413);
      expect(await countFor('209905')).toBe(1);
    }, 60000);
  });

  describe('límite de 10 propuestas activas y concurrencia', () => {
    it('la propuesta 11 secuencial responde 409; descartar una libera cupo', async () => {
      const ids: string[] = [];
      for (let i = 0; i < 10; i += 1) {
        const res = await uploadPos('209906', 1, 100 + i);
        expect(res.status).toBe(201);
        ids.push((res.body as ProposalBody).proposal.id);
      }
      const eleventh = await uploadPos('209906', 1, 500);
      expect(eleventh.status).toBe(409);
      expect((eleventh.body as { code: string }).code).toBe(
        'SIRE_PROPOSAL_LIMIT_REACHED',
      );
      // Idempotencia con el cupo lleno: un archivo ya activo sigue respondiendo reused.
      expect((await uploadPos('209906', 1, 100)).status).toBe(200);
      // El cupo es por registro: RCE del mismo periodo no se ve afectado.
      expect((await uploadPos('209906', 1, 100, 'RCE')).status).toBe(201);

      expect((await discard(ids[0])).status).toBe(200);
      expect((await uploadPos('209906', 1, 500)).status).toBe(201);
    }, 60000);

    it('12 cargas concurrentes de archivos distintos: exactamente 10 se importan y 2 reciben 409', async () => {
      const results = await Promise.all(
        Array.from({ length: 12 }, (_, i) => uploadPos('209907', 1, 200 + i)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(10);
      expect(statuses.filter((s) => s === 409)).toHaveLength(2);
      expect(
        await prisma.sireDemoProposal.count({
          where: { period: '209907', status: 'IMPORTED' },
        }),
      ).toBe(10);
    }, 60000);

    it('6 cargas concurrentes del MISMO archivo: una propuesta, una auditoría, el resto reused', async () => {
      const results = await Promise.all(
        Array.from({ length: 6 }, () => uploadPos('209908', 2, 300)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses.filter((s) => s === 201)).toHaveLength(1);
      expect(statuses.filter((s) => s === 200)).toHaveLength(5);
      const proposals = await prisma.sireDemoProposal.findMany({
        where: { period: '209908', fileName: { startsWith: PREFIX } },
      });
      expect(proposals).toHaveLength(1);
      expect(
        await prisma.sireDemoProposalLine.count({
          where: { proposalId: proposals[0].id },
        }),
      ).toBe(2);
      expect(
        await prisma.auditLog.count({
          where: {
            action: 'SIRE_DEMO_PROPOSAL_IMPORTED',
            entityId: proposals[0].id,
          },
        }),
      ).toBe(1);
    }, 60000);

    it('descartes concurrentes de la misma propuesta: uno gana (200) y el resto 409', async () => {
      const created = await uploadPos('209909', 1, 400);
      const id = (created.body as ProposalBody).proposal.id;
      const results = await Promise.all(
        Array.from({ length: 4 }, () => discard(id)),
      );
      const statuses = results.map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409, 409, 409]);
      expect(
        await prisma.auditLog.count({
          where: { action: 'SIRE_DEMO_PROPOSAL_DISCARDED', entityId: id },
        }),
      ).toBe(1);
    }, 60000);
  });

  describe('DEMO_FIXTURES: versionado y disponibilidad', () => {
    const rvie = CURRENT_FIXTURE_SET.sampleFiles.RVIE;
    const fixtureFields = {
      source: 'DEMO_FIXTURES',
      register: 'RVIE',
      period: rvie.period,
    };
    const fixtureName = `${PREFIX}fixtures.txt`;

    it('carga el archivo versionado y guarda la versión; repetirlo es idempotente', async () => {
      const first = await upload(
        'ADMIN',
        fixtureFields,
        Buffer.from(rvie.content, 'utf8'),
        fixtureName,
      );
      expect(first.status).toBe(201);
      const body = first.body as ProposalBody;
      expect(body.proposal).toMatchObject({
        source: 'DEMO_FIXTURES',
        fixtureSetVersion: CURRENT_FIXTURE_SET.version,
        reconcilable: true,
      });
      const again = await upload(
        'ACCOUNTANT',
        fixtureFields,
        Buffer.from(rvie.content, 'utf8'),
        fixtureName,
      );
      expect(again.status).toBe(200);
      expect((again.body as ProposalBody).reused).toBe(true);
    });

    it('versión inexistente y periodo fuera del conjunto se rechazan sin sustituir por otra versión', async () => {
      const unknown = rvie.content.replace(
        `FIXTURE=${CURRENT_FIXTURE_SET.version}`,
        'FIXTURE=demo-fixtures-v999',
      );
      const resUnknown = await upload(
        'ADMIN',
        fixtureFields,
        Buffer.from(unknown, 'utf8'),
        fixtureName,
      );
      expect(resUnknown.status).toBe(400);
      expect((resUnknown.body as { code: string }).code).toBe(
        'FIXTURE_VERSION_UNKNOWN',
      );

      const otherPeriod = rvie.content.replace(
        `PERIOD=${rvie.period}`,
        'PERIOD=202602',
      );
      const resPeriod = await upload(
        'ADMIN',
        { ...fixtureFields, period: '202602' },
        Buffer.from(otherPeriod, 'utf8'),
        fixtureName,
      );
      expect(resPeriod.status).toBe(400);
      expect((resPeriod.body as { code: string }).code).toBe(
        'FIXTURE_PERIOD_UNAVAILABLE',
      );
    });

    it('un archivo POS declarado como DEMO_FIXTURES (o al revés) no coincide con la cabecera', async () => {
      const res = await upload(
        'ADMIN',
        fixtureFields,
        posFile(rvie.period, 1),
        fixtureName,
      );
      expect(res.status).toBe(400);
    });
  });

  describe('listado y paginación', () => {
    it('filtra por source, register, period y status; pagina y ordena', async () => {
      const all = await get(`${BASE}?period=209906&register=RVIE&pageSize=100`);
      expect(all.status).toBe(200);
      const body = all.body as {
        mode: string;
        officialValidity: boolean;
        items: ProposalBody['proposal'][];
        page: number;
        pageSize: number;
        totalItems: number;
      };
      expect(body.mode).toBe('DEMO');
      expect(body.officialValidity).toBe(false);
      expect(body.totalItems).toBe(11); // 10 activas + 1 descartada
      expect(body.items.every((p) => p.period === '209906')).toBe(true);

      const discarded = await get(
        `${BASE}?period=209906&register=RVIE&status=DISCARDED`,
      );
      expect((discarded.body as { totalItems: number }).totalItems).toBe(1);

      const paged = await get(
        `${BASE}?period=209906&register=RVIE&pageSize=4&page=3`,
      );
      const pagedBody = paged.body as typeof body;
      expect(pagedBody.items).toHaveLength(3);
      expect(pagedBody.page).toBe(3);
      expect(pagedBody.pageSize).toBe(4);
      expect(pagedBody.totalItems).toBe(11);

      const fixtures = await get(`${BASE}?source=DEMO_FIXTURES`);
      const fixtureItems = (fixtures.body as typeof body).items;
      expect(fixtureItems.length).toBeGreaterThan(0);
      expect(fixtureItems.every((p) => p.source === 'DEMO_FIXTURES')).toBe(
        true,
      );
    });

    it('rechaza filtros inválidos', async () => {
      expect((await get(`${BASE}?status=X`)).status).toBe(400);
      expect((await get(`${BASE}?period=202613`)).status).toBe(400);
      expect((await get(`${BASE}?pageSize=1000`)).status).toBe(400);
    });
  });

  describe('rollback transaccional', () => {
    it('un fallo después de insertar cabecera y parte de las líneas revierte todo, libera el lock y no altera lo existente', async () => {
      // Propuesta previa del mismo periodo: debe permanecer idéntica.
      const keep = await uploadPos('209912', 2, 1);
      expect(keep.status).toBe(201);
      const keepId = (keep.body as ProposalBody).proposal.id;
      const auditsBefore = await prisma.auditLog.count({
        where: { action: { startsWith: 'SIRE_DEMO_PROPOSAL_' } },
      });

      // Fallo REAL de base de datos a mitad de la persistencia: 1500 filas se
      // insertan en 2 lotes de 1000; el trigger rechaza la línea 1200 (2.º lote),
      // cuando la cabecera y el primer lote ya están insertados.
      await prisma.$executeRawUnsafe(`
        CREATE OR REPLACE FUNCTION e2e_sire_s2_fail() RETURNS trigger AS $$
        BEGIN
          IF NEW.line_number = 1200 THEN
            RAISE EXCEPTION 'e2e_sire_s2_forced_failure';
          END IF;
          RETURN NEW;
        END; $$ LANGUAGE plpgsql`);
      await prisma.$executeRawUnsafe(
        `CREATE TRIGGER e2e_sire_s2_fail_trg BEFORE INSERT ON sire_demo_proposal_lines FOR EACH ROW EXECUTE FUNCTION e2e_sire_s2_fail()`,
      );
      let failed: request.Response;
      try {
        failed = await uploadPos('209912', 1500, 1000);
      } finally {
        await prisma.$executeRawUnsafe(
          'DROP TRIGGER IF EXISTS e2e_sire_s2_fail_trg ON sire_demo_proposal_lines',
        );
        await prisma.$executeRawUnsafe(
          'DROP FUNCTION IF EXISTS e2e_sire_s2_fail()',
        );
      }
      expect(failed.status).toBe(500);

      // Sin cabecera ni líneas parciales; sin auditoría; lo existente intacto.
      const proposals = await prisma.sireDemoProposal.findMany({
        where: { period: '209912', fileName: { startsWith: PREFIX } },
      });
      expect(proposals.map((p) => p.id)).toEqual([keepId]);
      expect(
        await prisma.sireDemoProposalLine.count({
          where: { proposal: { period: '209912' } },
        }),
      ).toBe(2);
      expect(
        await prisma.auditLog.count({
          where: { action: { startsWith: 'SIRE_DEMO_PROPOSAL_' } },
        }),
      ).toBe(auditsBefore);
      expect(
        (
          await prisma.sireDemoProposal.findUniqueOrThrow({
            where: { id: keepId },
          })
        ).status,
      ).toBe('IMPORTED');

      // El lock se liberó y el mismo archivo ahora se importa con normalidad
      // (con el lock retenido esta llamada quedaría bloqueada).
      const retry = await uploadPos('209912', 1500, 1000);
      expect(retry.status).toBe(201);
      expect(
        await prisma.sireDemoProposalLine.count({
          where: { proposalId: (retry.body as ProposalBody).proposal.id },
        }),
      ).toBe(1500);
    }, 60000);
  });

  describe('RBAC', () => {
    it('ADMIN y ACCOUNTANT leen y escriben; MANAGEMENT solo lee; SELLER y WAREHOUSE sin acceso; sin sesión 401', async () => {
      expect((await get(BASE, 'ACCOUNTANT')).status).toBe(200);
      expect((await get(BASE, 'MANAGEMENT')).status).toBe(200);

      const target = await uploadPos('209910', 1, 900);
      const id = (target.body as ProposalBody).proposal.id;

      expect(
        (await uploadPos('209910', 1, 901, 'RVIE', 'MANAGEMENT')).status,
      ).toBe(403);
      expect((await discard(id, 'MANAGEMENT')).status).toBe(403);
      for (const who of ['SELLER', 'WAREHOUSE']) {
        expect((await get(BASE, who)).status).toBe(403);
        expect((await uploadPos('209910', 1, 902, 'RVIE', who)).status).toBe(
          403,
        );
        expect((await discard(id, who)).status).toBe(403);
      }
      expect((await request(app.getHttpServer()).get(BASE)).status).toBe(401);
      expect(
        (await request(app.getHttpServer()).post(`${BASE}/${id}/discard`))
          .status,
      ).toBe(401);
      // Nada de lo denegado dejó rastro.
      expect(
        await prisma.sireDemoProposal.count({
          where: { period: '209910', fileName: { startsWith: PREFIX } },
        }),
      ).toBe(1);
      expect(
        (await prisma.sireDemoProposal.findUniqueOrThrow({ where: { id } }))
          .status,
      ).toBe('IMPORTED');
    });
  });

  describe('contrato OpenAPI y aislamiento', () => {
    it('documenta las rutas de propuestas', async () => {
      const res = await request(app.getHttpServer()).get('/api/docs-json');
      if (res.status !== 200) {
        return; // Swagger deshabilitado en este ambiente
      }
      const paths = Object.keys(
        (res.body as { paths: Record<string, unknown> }).paths,
      );
      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/v1/sire-demo/proposals',
          '/api/v1/sire-demo/proposals/{id}/discard',
        ]),
      );
    });

    it('las cargas y descartes no modifican ventas, comprobantes, compras, asientos ni inventario', async () => {
      const before = await commercialCounts();
      const created = await uploadPos('209911', 2, 950);
      await discard((created.body as ProposalBody).proposal.id);
      expect(await commercialCounts()).toEqual(before);
    });
  });
});
