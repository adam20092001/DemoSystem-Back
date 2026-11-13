/* eslint-disable @typescript-eslint/no-unsafe-argument, @typescript-eslint/no-explicit-any -- ExcelJS.load espera su propio tipo Buffer */
import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName } from '@prisma/client';
import ExcelJS from 'exceljs';
import request from 'supertest';
import { App } from 'supertest/types';
import { DEMO_V1_COLUMNS_LINE } from '../src/sire-demo/core/demo-proposal.parser';
import { RECONCILIATION_CLASSIFICATIONS } from '../src/sire-demo/core/types';
import { CURRENT_FIXTURE_SET } from '../src/sire-demo/fixtures/fixture-registry';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { binaryParser } from './helpers/excel-download';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';
import {
  createSireDemoE2eApp,
  snapshotSireDemoEnv,
} from './helpers/sire-demo-app';

const BASE = '/api/v1/sire-demo/proposals';
const PREFIX = 'e2e-s3-';
// Datos reales de pos_db_test creados SOLO por esta suite (febrero 2025; ninguna
// otra suite genera documentos en ese mes) y eliminados al terminar.
const POS_TAG = 'E2E-SIRE-S3';
const POS_RUC = '99999000777';
const POS_SERIES = 'F9S3';
const POS_CLIENT = 'E2E SIRE S3 CLIENTE SAC';
const MALICIOUS_NAME = '=HYPERLINK("http://evil.test","x")';

const USERS = {
  ACCOUNTANT: {
    name: 'e2e_accountant_sire_s3',
    password: 'AccountantSireS3Demo123',
    role: RoleName.ACCOUNTANT,
  },
  MANAGEMENT: {
    name: 'e2e_management_sire_s3',
    password: 'ManagementSireS3Demo123',
    role: RoleName.MANAGEMENT,
  },
  SELLER: {
    name: 'e2e_seller_sire_s3',
    password: 'SellerSireS3Demo123',
    role: RoleName.SELLER,
  },
  WAREHOUSE: {
    name: 'e2e_warehouse_sire_s3',
    password: 'WarehouseSireS3Demo123',
    role: RoleName.WAREHOUSE,
  },
} as const;

interface ItemBody {
  classification: string;
  key: { docTypeCode: string; series: string; number: string } | null;
  differences: { field: string; delta: string | null }[];
  pos: { total: string; igv: string } | null;
  proposal: { total: string; occurrences: number } | null;
}
interface ReconBody {
  mode: string;
  officialValidity: boolean;
  sourceNote: string;
  proposal: {
    id: string;
    source: string;
    register: string;
    period: string;
    fixtureSetVersion: string | null;
  };
  counts: { posDocuments: number; proposalRows: number; items: number };
  summary: {
    currencyCode: string;
    total: number;
    byClassification: Record<string, { count: number; posTotal: string }>;
    totals: Record<string, string>;
  };
  resultDigest: string;
  classification: string | null;
  items: ItemBody[];
  page: number;
  pageSize: number;
  totalItems: number;
}

describe('SIRE DEMO S3 — conciliación y exportación (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let restoreEnv: () => void;
  const cookies: Record<string, string> = {};
  const ids: Record<string, string> = {};

  const get = (url: string, who = 'ADMIN') =>
    request(app.getHttpServer())
      .get(url)
      .set('Cookie', cookies[who] ?? '');
  const recon = (id: string, qs = '', who = 'ADMIN') =>
    get(`${BASE}/${id}/reconciliation${qs}`, who);
  const exportReq = (id: string, qs = '', who = 'ADMIN') =>
    request(app.getHttpServer())
      .get(`${BASE}/${id}/reconciliation/export.xlsx${qs}`)
      .set('Cookie', cookies[who] ?? '')
      .buffer(true)
      .parse(binaryParser);
  const upload = (
    register: string,
    source: string,
    period: string,
    content: string,
    name: string,
  ) =>
    request(app.getHttpServer())
      .post(BASE)
      .set('Cookie', cookies.ADMIN)
      .field('source', source)
      .field('register', register)
      .field('period', period)
      .attach('file', Buffer.from(content, 'utf8'), `${PREFIX}${name}.txt`);

  /** El export usa parser binario: un error JSON llega como Buffer. */
  const codeOf = (res: request.Response): string | undefined => {
    const body: unknown = Buffer.isBuffer(res.body)
      ? JSON.parse(res.body.toString('utf8'))
      : res.body;
    return (body as { code?: string }).code;
  };
  async function cleanupPos(): Promise<void> {
    const sales = await prisma.sale.findMany({
      where: { number: { startsWith: POS_TAG } },
      select: { id: true },
    });
    const saleIds = sales.map((x) => x.id);
    await prisma.electronicDocument.deleteMany({
      where: { saleId: { in: saleIds } },
    });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    await prisma.fiscalSeries.deleteMany({
      where: { series: POS_SERIES, electronicDocuments: { none: {} } },
    });
    await prisma.customer.deleteMany({ where: { documentNumber: POS_RUC } });
  }

  /** Crea 3 comprobantes ACCEPTED (MOCK) + 1 REJECTED en febrero 2025 y una venta sin comprobante. */
  async function seedPos(): Promise<Record<number, string>> {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
    });
    const customer = await prisma.customer.create({
      data: {
        customerStage: 'CUSTOMER',
        customerType: 'COMPANY',
        documentType: 'RUC',
        documentNumber: POS_RUC,
        name: POS_CLIENT,
      },
    });
    const series = await prisma.fiscalSeries.upsert({
      where: {
        documentType_series: { documentType: 'FACTURA', series: POS_SERIES },
      },
      update: {},
      create: { documentType: 'FACTURA', series: POS_SERIES },
    });
    const makeSale = (n: number, total: string, confirmedAt: Date) =>
      prisma.sale.create({
        data: {
          number: `${POS_TAG}-${n}`,
          status: 'ACTIVE',
          paymentStatus: 'UNPAID',
          deliveryStatus: 'NOT_APPLICABLE',
          customerId: customer.id,
          customerIsGeneric: false,
          customerType: 'COMPANY',
          customerDocumentType: 'RUC',
          customerDocumentNumber: POS_RUC,
          customerName: POS_CLIENT,
          sellerId: admin.id,
          subtotal: total,
          discountAmount: '0.00',
          taxAmount: '0.00',
          total,
          currencyCode: 'PEN',
          taxEnabled: true,
          taxRate: '18.00',
          pricesIncludeTax: false,
          paidAmount: '0.00',
          balanceDue: total,
          confirmedAt,
        },
      });
    const docIds: Record<number, string> = {};
    const makeDoc = async (
      n: number,
      status: 'ACCEPTED' | 'REJECTED',
      issuedAt: Date,
      base: string,
      igv: string,
      total: string,
    ) => {
      const sale = await makeSale(n, total, issuedAt);
      const doc = await prisma.electronicDocument.create({
        data: {
          saleId: sale.id,
          fiscalSeriesId: series.id,
          documentType: 'FACTURA',
          series: POS_SERIES,
          number: 9000 + n,
          status,
          providerCode: 'MOCK',
          currencyCode: 'PEN',
          issuerTaxId: '20100000001',
          issuerBusinessName: 'E2E SIRE EMISOR SAC',
          customerDocumentType: 'RUC',
          customerDocumentNumber: POS_RUC,
          customerName: POS_CLIENT,
          subtotal: base,
          discountAmount: '0.00',
          taxableBase: base,
          taxAmount: igv,
          total,
          pricesIncludeTax: false,
          issuedAt,
        },
      });
      docIds[n] = doc.id;
    };
    await makeDoc(
      1,
      'ACCEPTED',
      new Date('2025-02-15T15:00:00.000Z'),
      '847.46',
      '152.54',
      '1000.00',
    );
    await makeDoc(
      2,
      'ACCEPTED',
      new Date('2025-02-20T15:00:00.000Z'),
      '423.73',
      '76.27',
      '500.00',
    );
    await makeDoc(
      3,
      'ACCEPTED',
      new Date('2025-02-25T15:00:00.000Z'),
      '169.49',
      '30.51',
      '200.00',
    );
    await makeDoc(
      4,
      'REJECTED',
      new Date('2025-02-26T15:00:00.000Z'),
      '84.75',
      '15.25',
      '100.00',
    );
    await makeSale(5, '300.00', new Date('2025-02-27T15:00:00.000Z'));
    return docIds;
  }

  async function readSheet(buffer: Buffer): Promise<ExcelJS.Worksheet> {
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buffer as any);
    const sheet = wb.worksheets[0];
    if (!sheet) throw new Error('Sin hojas');
    return sheet;
  }
  const headerIndex = (sheet: ExcelJS.Worksheet, header: string): number => {
    const headers = (sheet.getRow(1).values as unknown[]).map(String);
    const idx = headers.indexOf(header);
    if (idx < 0) throw new Error(`Columna ausente: ${header}`);
    return idx;
  };

  async function cleanup(): Promise<void> {
    const proposals = await prisma.sireDemoProposal.findMany({
      where: { fileName: { startsWith: PREFIX } },
      select: { id: true },
    });
    const pids = proposals.map((p) => p.id);
    await prisma.auditLog.deleteMany({
      where: {
        action: { startsWith: 'SIRE_DEMO_PROPOSAL_' },
        entityId: { in: pids },
      },
    });
    await prisma.sireDemoProposalLine.deleteMany({
      where: { proposalId: { in: pids } },
    });
    await prisma.sireDemoProposal.deleteMany({ where: { id: { in: pids } } });
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
    cookies.ADMIN = (
      await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_ACTIVE_PASSWORD,
      )
    ).cookie;
    for (const [key, user] of Object.entries(USERS)) {
      cookies[key] = (
        await login(app.getHttpServer(), user.name, user.password)
      ).cookie;
    }
    await cleanup();
    await cleanupPos();

    const samples = CURRENT_FIXTURE_SET.sampleFiles;
    for (const register of ['RVIE', 'RCE'] as const) {
      const res = await upload(
        register,
        'DEMO_FIXTURES',
        samples[register].period,
        samples[register].content,
        register.toLowerCase(),
      );
      if (res.status !== 201) {
        throw new Error(`Carga ${register} falló: ${JSON.stringify(res.body)}`);
      }
      ids[register] = (res.body as { proposal: { id: string } }).proposal.id;
    }
  }, 90000);

  afterAll(async () => {
    await cleanup();
    await cleanupPos();
    await app.close();
    await prisma.$disconnect();
    restoreEnv();
  });

  describe('conciliación RVIE y RCE contra DEMO_FIXTURES', () => {
    it.each([
      ['RVIE', '14000.00', '13600.00', '1000.00', '14600.00', '-400.00'],
      ['RCE', '14000.00', '12600.00', '1000.00', '13600.00', '-1400.00'],
    ])(
      '%s: modo DEMO, 8 clasificaciones calculadas, totales exactos y duplicados sin duplicar importes',
      async (register, pos, distinct, surplus, raw, delta) => {
        const res = await recon(ids[register], '?pageSize=200');
        expect(res.status).toBe(200);
        const body = res.body as ReconBody;
        expect(body).toMatchObject({
          mode: 'DEMO',
          officialValidity: false,
          proposal: {
            register,
            source: 'DEMO_FIXTURES',
            fixtureSetVersion: CURRENT_FIXTURE_SET.version,
          },
          classification: null,
        });
        expect(body.sourceNote).toContain('sin validez');
        expect(body.summary.currencyCode).toBe('PEN');
        expect(body.summary.totals).toEqual({
          pos,
          proposalDistinct: distinct,
          duplicateSurplus: surplus,
          proposalRaw: raw,
          delta,
        });
        // Cada clasificación aparece (RCE no tiene INSUFFICIENT_DATA de IGV: se exige solo RVIE).
        const classes = body.summary.byClassification;
        for (const c of RECONCILIATION_CLASSIFICATIONS) {
          expect(classes[c]).toBeDefined();
          if (register === 'RVIE' || c !== 'INSUFFICIENT_DATA') {
            expect(classes[c].count).toBeGreaterThanOrEqual(1);
          }
        }
        const sum = Object.values(classes).reduce((a, c) => a + c.count, 0);
        expect(sum).toBe(body.summary.total);
        expect(body.summary.total).toBe(body.counts.items);
        expect(body.items).toHaveLength(body.counts.items);
        // Duplicado: una sola clave, 2 apariciones, y su excedente fuera de proposalDistinct.
        const dup = body.items.filter(
          (i) => i.classification === 'DUPLICATE_IN_PROPOSAL',
        );
        expect(dup).toHaveLength(1);
        expect(dup[0].proposal?.occurrences).toBe(2);
        // Importes siempre string con 2 decimales.
        for (const item of body.items) {
          if (item.pos) expect(item.pos.total).toMatch(/^-?\d+\.\d{2}$/);
          if (item.proposal)
            expect(item.proposal.total).toMatch(/^-?\d+\.\d{2}$/);
        }
        expect(body.resultDigest).toMatch(/^[0-9a-f]{64}$/);
      },
    );

    it('AMOUNT_MISMATCH informa el delta calculado (propuesta - POS)', async () => {
      const body = (await recon(ids.RVIE, '?classification=AMOUNT_MISMATCH'))
        .body as ReconBody;
      expect(body.items.length).toBeGreaterThanOrEqual(1);
      const totalDiff = body.items[0].differences.find(
        (d) => d.field === 'total',
      );
      expect(totalDiff?.delta).toBe('100.00');
    });
  });

  describe('filtros, paginación y determinismo', () => {
    it('el filtro no altera el resumen; totalItems refleja el filtro; las páginas concatenadas igualan la lista completa', async () => {
      const full = (await recon(ids.RVIE, '?pageSize=200')).body as ReconBody;
      const filtered = (
        await recon(ids.RVIE, '?classification=MATCHED&pageSize=200')
      ).body as ReconBody;
      expect(filtered.summary).toEqual(full.summary);
      expect(filtered.resultDigest).toBe(full.resultDigest);
      expect(filtered.classification).toBe('MATCHED');
      expect(filtered.totalItems).toBe(
        full.summary.byClassification.MATCHED.count,
      );
      expect(filtered.items.every((i) => i.classification === 'MATCHED')).toBe(
        true,
      );

      const pages: ItemBody[] = [];
      for (let page = 1; page <= 4; page += 1) {
        const b = (await recon(ids.RVIE, `?page=${page}&pageSize=4`))
          .body as ReconBody;
        expect(b.totalItems).toBe(full.totalItems);
        expect(b.summary).toEqual(full.summary);
        pages.push(...b.items);
      }
      expect(pages).toEqual(full.items);
    });

    it('es determinista: misma propuesta, mismo resultDigest (independiente de página y filtro)', async () => {
      const a = (await recon(ids.RCE)).body as ReconBody;
      const b = (await recon(ids.RCE, '?classification=MISSING_IN_POS'))
        .body as ReconBody;
      const c = (await recon(ids.RCE, '?page=2&pageSize=3')).body as ReconBody;
      expect(new Set([a, b, c].map((x) => x.resultDigest)).size).toBe(1);
    });

    it('valida parámetros y UUID', async () => {
      expect((await recon(ids.RVIE, '?classification=X')).status).toBe(400);
      expect((await recon(ids.RVIE, '?page=0')).status).toBe(400);
      expect((await recon(ids.RVIE, '?pageSize=1000')).status).toBe(400);
      expect((await recon('no-uuid')).status).toBe(400);
      const missing = await recon('11111111-1111-4111-8111-111111111111');
      expect(missing.status).toBe(404);
      expect((missing.body as { code: string }).code).toBe(
        'SIRE_PROPOSAL_NOT_FOUND',
      );
    });
  });

  describe('exportación Excel', () => {
    it('exporta TODAS las filas del mismo resultado que la API (mismo orden, mismo digest) con identificación DEMO', async () => {
      const api = (await recon(ids.RVIE, '?pageSize=200')).body as ReconBody;
      const res = await exportReq(ids.RVIE);
      expect(res.status).toBe(200);
      expect(res.headers['content-type']).toContain('spreadsheetml');
      expect(res.headers['content-disposition']).toContain(
        'sire-demo-rvie-202601',
      );
      const sheet = await readSheet(res.body as Buffer);
      expect(sheet.rowCount - 1).toBe(api.totalItems);
      const col = (h: string) => headerIndex(sheet, h);
      const classes: string[] = [];
      const totals: number[] = [];
      for (let r = 2; r <= sheet.rowCount; r += 1) {
        const row = sheet.getRow(r);
        classes.push(row.getCell(col('Clasificación')).text);
        expect(row.getCell(col('Modo')).text).toBe(
          'DEMO — SIN VALIDEZ ANTE SUNAT',
        );
        expect(row.getCell(col('Registro')).text).toBe('RVIE');
        expect(row.getCell(col('Periodo')).text).toBe('202601');
        expect(row.getCell(col('Origen')).text).toBe('DEMO_FIXTURES');
        expect(row.getCell(col('Versión de fixtures')).text).toBe(
          CURRENT_FIXTURE_SET.version,
        );
        expect(row.getCell(col('resultDigest')).text).toBe(api.resultDigest);
        const t = row.getCell(col('Total propuesta')).value;
        totals.push(t === null ? NaN : Number(t));
      }
      expect(classes).toEqual(api.items.map((i) => i.classification));
      // Suma de totales propuesta del Excel == lo que reporta la API (sin recalcular).
      const apiProposal = api.items.map((i) =>
        i.proposal ? Number(i.proposal.total) : NaN,
      );
      expect(totals).toEqual(apiProposal);
    });

    it('respeta el filtro de clasificación y exporta todas sus filas', async () => {
      const api = (
        await recon(ids.RCE, '?classification=MISSING_IN_POS&pageSize=1')
      ).body as ReconBody;
      const sheet = await readSheet(
        (await exportReq(ids.RCE, '?classification=MISSING_IN_POS'))
          .body as Buffer,
      );
      expect(sheet.rowCount - 1).toBe(api.totalItems);
      for (let r = 2; r <= sheet.rowCount; r += 1) {
        expect(
          sheet.getRow(r).getCell(headerIndex(sheet, 'Clasificación')).text,
        ).toBe('MISSING_IN_POS');
      }
      expect((await exportReq(ids.RCE, '?classification=ZZZ')).status).toBe(
        400,
      );
    });

    it('audita SIRE_DEMO_PROPOSAL_EXPORTED sin RUC, nombres ni importes; la conciliación JSON no audita', async () => {
      const before = await prisma.auditLog.count({
        where: { action: 'SIRE_DEMO_PROPOSAL_EXPORTED', entityId: ids.RVIE },
      });
      await recon(ids.RVIE);
      expect(
        await prisma.auditLog.count({
          where: { action: 'SIRE_DEMO_PROPOSAL_EXPORTED', entityId: ids.RVIE },
        }),
      ).toBe(before);
      await exportReq(ids.RVIE, '?classification=MATCHED', 'ACCOUNTANT');
      const logs = await prisma.auditLog.findMany({
        where: { action: 'SIRE_DEMO_PROPOSAL_EXPORTED', entityId: ids.RVIE },
      });
      expect(logs).toHaveLength(before + 1);
      const last = logs[logs.length - 1];
      expect(Object.keys(last.metadata as object).sort()).toEqual([
        'classification',
        'fixtureSetVersion',
        'period',
        'proposalId',
        'register',
        'resultDigest',
        'rowCount',
        'source',
      ]);
      const serialized = JSON.stringify(last);
      expect(serialized).not.toMatch(/9999900\d+/);
      expect(serialized).not.toContain('DEMO CLIENTE');
      expect(serialized).not.toContain('1000.00');
    });

    it('sanitiza fórmulas (origen POS vacío: todas las filas son MISSING_IN_POS)', async () => {
      const content = `#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=209901\n${DEMO_V1_COLUMNS_LINE}\n01|F001|00000001|05/01/2099|6|99999000001|${MALICIOUS_NAME}|PEN|847.46|152.54|1000.00\n`;
      const up = await upload('RVIE', 'POS', '209901', content, 'pos-formula');
      expect(up.status).toBe(201);
      const pid = (up.body as { proposal: { id: string } }).proposal.id;

      const api = (await recon(pid)).body as ReconBody;
      expect(api.proposal.source).toBe('POS');
      expect(api.proposal.fixtureSetVersion).toBeNull();
      expect(api.sourceNote).toContain('MOCK');
      expect(api.counts.posDocuments).toBe(0);
      expect(api.items.map((i) => i.classification)).toEqual([
        'MISSING_IN_POS',
      ]);

      const sheet = await readSheet((await exportReq(pid)).body as Buffer);
      const cell = sheet
        .getRow(2)
        .getCell(headerIndex(sheet, 'Contraparte propuesta')).text;
      expect(cell.startsWith("'=")).toBe(true);
      expect(cell).not.toMatch(/^=/);
      expect(sheet.getRow(2).getCell(headerIndex(sheet, 'Origen')).text).toBe(
        'POS',
      );
    });
  });

  describe('origen POS con documentos reales (comprobantes MOCK en pos_db_test)', () => {
    let docIds: Record<number, string>;
    let posProposalId: string;

    const row = (
      n: string,
      date: string,
      base: string,
      igv: string,
      total: string,
    ) =>
      `01|${POS_SERIES}|${n}|${date}|6|${POS_RUC}|${POS_CLIENT}|PEN|${base}|${igv}|${total}`;

    beforeAll(async () => {
      docIds = await seedPos();
      const content = [
        '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202502',
        DEMO_V1_COLUMNS_LINE,
        row('00009001', '15/02/2025', '847.46', '152.54', '1000.00'), // igual al POS
        row('00009002', '20/02/2025', '508.47', '91.53', '600.00'), // monto distinto (POS 500.00)
        row('00009099', '22/02/2025', '100.00', '18.00', '118.00'), // no existe en POS
      ].join('\n');
      const up = await upload(
        'RVIE',
        'POS',
        '202502',
        `${content}\n`,
        'pos-real',
      );
      expect(up.status).toBe(201);
      posProposalId = (up.body as { proposal: { id: string } }).proposal.id;
    }, 60000);

    it('el comprobante registrado en POS participa: MATCHED, AMOUNT_MISMATCH, MISSING_IN_PROPOSAL y MISSING_IN_POS, con montos y totales exactos', async () => {
      const res = await recon(posProposalId, '?pageSize=200');
      expect(res.status).toBe(200);
      const body = res.body as ReconBody & {
        source: string;
        fixtureSetVersion: string | null;
        register: string;
        period: string;
        excluded: {
          notEligibleStatus: number;
          salesWithoutFiscalDocument: number;
        };
        items: (ItemBody & { pos: { refId: string; total: string } | null })[];
      };
      expect(body).toMatchObject({
        mode: 'DEMO',
        officialValidity: false,
        source: 'POS',
        fixtureSetVersion: null,
        register: 'RVIE',
        period: '202502',
      });
      expect(body.sourceNote).toContain('MOCK');
      // 3 ACCEPTED participan; el REJECTED se excluye por estado; 1 venta sin comprobante.
      expect(body.counts).toEqual({
        posDocuments: 3,
        proposalRows: 3,
        items: 4,
      });
      expect(body.excluded).toEqual({
        notEligibleStatus: 1,
        salesWithoutFiscalDocument: 1,
      });

      const byNumber = new Map(body.items.map((i) => [i.key?.number, i]));
      const matched = byNumber.get('9001');
      expect(matched?.classification).toBe('MATCHED');
      expect(matched?.pos?.refId).toBe(docIds[1]); // el ElectronicDocument REAL
      expect(matched?.key).toMatchObject({
        docTypeCode: '01',
        series: POS_SERIES,
      });
      expect(matched?.pos?.total).toBe('1000.00');
      expect(matched?.proposal?.total).toBe('1000.00');

      const mismatch = byNumber.get('9002');
      expect(mismatch?.classification).toBe('AMOUNT_MISMATCH');
      expect(mismatch?.pos?.refId).toBe(docIds[2]);
      expect(mismatch?.pos?.total).toBe('500.00');
      expect(mismatch?.proposal?.total).toBe('600.00');
      expect(
        mismatch?.differences.find((d) => d.field === 'total')?.delta,
      ).toBe('100.00');

      const missingProposal = byNumber.get('9003');
      expect(missingProposal?.classification).toBe('MISSING_IN_PROPOSAL');
      expect(missingProposal?.pos?.refId).toBe(docIds[3]);
      expect(byNumber.has('9004')).toBe(false); // REJECTED nunca participa

      expect(byNumber.get('9099')?.classification).toBe('MISSING_IN_POS');
      expect(byNumber.get('9099')?.pos).toBeNull();

      // pos = 1000 + 500 + 200; propuesta (claves distintas) = 1000 + 600 + 118.
      expect(body.summary.totals).toEqual({
        pos: '1700.00',
        proposalDistinct: '1718.00',
        duplicateSurplus: '0.00',
        proposalRaw: '1718.00',
        delta: '18.00',
      });
    });

    it('el Excel contiene las mismas filas y el mismo resultDigest que la API para el origen POS', async () => {
      const api = (await recon(posProposalId, '?pageSize=200'))
        .body as ReconBody;
      const sheet = await readSheet(
        (await exportReq(posProposalId)).body as Buffer,
      );
      expect(sheet.rowCount - 1).toBe(api.totalItems);
      expect(
        sheet.getRow(2).getCell(headerIndex(sheet, 'resultDigest')).text,
      ).toBe(api.resultDigest);
      expect(sheet.getRow(2).getCell(headerIndex(sheet, 'Origen')).text).toBe(
        'POS',
      );
      const classes: string[] = [];
      for (let r = 2; r <= sheet.rowCount; r += 1) {
        classes.push(
          sheet.getRow(r).getCell(headerIndex(sheet, 'Clasificación')).text,
        );
      }
      expect(classes).toEqual(api.items.map((i) => i.classification));
    });

    it('Excel SIN resultados: conserva la identificación DEMO en una fila "SIN RESULTADOS"', async () => {
      // En este escenario no hay ningún DATE_MISMATCH.
      const api = (await recon(posProposalId, '?classification=DATE_MISMATCH'))
        .body as ReconBody;
      expect(api.totalItems).toBe(0);
      expect(api.items).toEqual([]);
      const res = await exportReq(
        posProposalId,
        '?classification=DATE_MISMATCH',
      );
      expect(res.status).toBe(200);
      const sheet = await readSheet(res.body as Buffer);
      expect(sheet.rowCount).toBe(2); // encabezado + 1 fila de identificación
      const cell = (h: string) =>
        sheet.getRow(2).getCell(headerIndex(sheet, h)).text;
      expect(cell('Modo')).toBe('DEMO — SIN VALIDEZ ANTE SUNAT');
      expect(cell('Clasificación')).toBe('SIN RESULTADOS');
      expect(cell('Registro')).toBe('RVIE');
      expect(cell('Periodo')).toBe('202502');
      expect(cell('Origen')).toBe('POS');
      expect(cell('resultDigest')).toBe(api.resultDigest);
      expect(cell('Serie')).toBe('');
    });

    it('los datos POS no fueron modificados por conciliar ni exportar', async () => {
      const docs = await prisma.electronicDocument.findMany({
        where: { series: POS_SERIES },
        orderBy: { number: 'asc' },
      });
      expect(docs.map((d) => [d.number, d.status, d.total.toFixed(2)])).toEqual(
        [
          [9001, 'ACCEPTED', '1000.00'],
          [9002, 'ACCEPTED', '500.00'],
          [9003, 'ACCEPTED', '200.00'],
          [9004, 'REJECTED', '100.00'],
        ],
      );
    });
  });

  describe('errores y consistencia de versión', () => {
    it('versión de fixtures inexistente: 409 FIXTURE_SET_UNAVAILABLE (nunca usa la más reciente)', async () => {
      await prisma.sireDemoProposal.update({
        where: { id: ids.RCE },
        data: { fixtureSetVersion: 'demo-fixtures-v999' },
      });
      try {
        for (const res of [await recon(ids.RCE), await exportReq(ids.RCE)]) {
          expect(res.status).toBe(409);
          expect(codeOf(res)).toBe('FIXTURE_SET_UNAVAILABLE');
        }
      } finally {
        await prisma.sireDemoProposal.update({
          where: { id: ids.RCE },
          data: { fixtureSetVersion: CURRENT_FIXTURE_SET.version },
        });
      }
      expect((await recon(ids.RCE)).status).toBe(200);
    });

    it('propuesta descartada: 409 SIRE_PROPOSAL_DISCARDED en ambas rutas', async () => {
      const content = `#DEMO_V1|SOURCE=POS|REGISTER=RCE|PERIOD=209902\n${DEMO_V1_COLUMNS_LINE}\n01|E001|00000001|05/02/2099|6|99999100001|PROVEEDOR|PEN|847.46|152.54|1000.00\n`;
      const up = await upload('RCE', 'POS', '209902', content, 'to-discard');
      const pid = (up.body as { proposal: { id: string } }).proposal.id;
      expect((await recon(pid)).status).toBe(200);
      await request(app.getHttpServer())
        .post(`${BASE}/${pid}/discard`)
        .set('Cookie', cookies.ADMIN);
      for (const res of [await recon(pid), await exportReq(pid)]) {
        expect(res.status).toBe(409);
        expect(codeOf(res)).toBe('SIRE_PROPOSAL_DISCARDED');
      }
    });
  });

  describe('RBAC y aislamiento', () => {
    it('ADMIN, ACCOUNTANT y MANAGEMENT leen y exportan; SELLER y WAREHOUSE 403; sin sesión 401', async () => {
      for (const who of ['ADMIN', 'ACCOUNTANT', 'MANAGEMENT']) {
        expect((await recon(ids.RVIE, '', who)).status).toBe(200);
        expect((await exportReq(ids.RVIE, '', who)).status).toBe(200);
      }
      for (const who of ['SELLER', 'WAREHOUSE']) {
        expect((await recon(ids.RVIE, '', who)).status).toBe(403);
        expect((await exportReq(ids.RVIE, '', who)).status).toBe(403);
      }
      expect(
        (
          await request(app.getHttpServer()).get(
            `${BASE}/${ids.RVIE}/reconciliation`,
          )
        ).status,
      ).toBe(401);
    });

    it('conciliar y exportar no modifican ventas, comprobantes, compras, asientos ni inventario', async () => {
      const before = await commercialCounts();
      await recon(ids.RVIE);
      await exportReq(ids.RCE);
      expect(await commercialCounts()).toEqual(before);
    });

    it('documenta las rutas en OpenAPI', async () => {
      const docs = await request(app.getHttpServer()).get('/api/docs-json');
      expect(docs.status).toBe(200);
      const paths = Object.keys(
        (docs.body as { paths: Record<string, unknown> }).paths,
      );
      expect(paths).toEqual(
        expect.arrayContaining([
          '/api/v1/sire-demo/proposals/{id}/reconciliation',
          '/api/v1/sire-demo/proposals/{id}/reconciliation/export.xlsx',
        ]),
      );
    });
  });
});
