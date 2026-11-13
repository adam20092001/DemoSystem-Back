import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { parseDemoProposal } from '../src/sire-demo/core/demo-proposal.parser';
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

const BASE = '/api/v1/sire-demo';
const FIXTURE_QS = 'source=DEMO_FIXTURES&period=202601';

const USERS = {
  ACCOUNTANT: {
    name: 'e2e_accountant_sire_demo',
    password: 'AccountantSireDemo123',
    role: RoleName.ACCOUNTANT,
  },
  MANAGEMENT: {
    name: 'e2e_management_sire_demo',
    password: 'ManagementSireDemo123',
    role: RoleName.MANAGEMENT,
  },
  SELLER: {
    name: 'e2e_seller_sire_demo',
    password: 'SellerSireDemo123',
    role: RoleName.SELLER,
  },
  WAREHOUSE: {
    name: 'e2e_warehouse_sire_demo',
    password: 'WarehouseSireDemo123',
    role: RoleName.WAREHOUSE,
  },
} as const;

// Datos reales de pos_db_test creados SOLO por esta suite, en marzo/abril de 2025
// (ninguna otra suite genera documentos en esos meses) y eliminados al terminar.
const TAG = 'E2E-SIRE-S1';
const RUC = '99999000555';
const SUPPLIER_RUC = '99999100555';
const SERIES = 'F9S1';

interface DocsBody {
  mode: string;
  officialValidity: boolean;
  formatVersion: string;
  source: string;
  fixtureSetVersion: string | null;
  register: string;
  period: string;
  periodRule: string;
  summary: {
    documentCount: number;
    excluded: {
      notEligibleStatus: number;
      salesWithoutFiscalDocument: number | null;
    };
    totalsByCurrency: Record<string, Record<string, string | number>>;
    flags: Record<string, number>;
  };
  items: Array<Record<string, unknown>>;
  page: number;
  pageSize: number;
  totalItems: number;
}

describe('SIRE DEMO S1 — contexto, documentos y archivo de ejemplo (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let restoreEnv: () => void;
  const cookies: Record<string, string> = {};

  const get = (url: string, who: string = 'ADMIN') =>
    request(app.getHttpServer())
      .get(url)
      .set('Cookie', cookies[who] ?? '');

  async function cleanupPosData(): Promise<void> {
    const sales = await prisma.sale.findMany({
      where: { number: { startsWith: TAG } },
      select: { id: true },
    });
    const saleIds = sales.map((s) => s.id);
    await prisma.electronicDocument.deleteMany({
      where: { saleId: { in: saleIds } },
    });
    await prisma.sale.deleteMany({ where: { id: { in: saleIds } } });
    await prisma.fiscalSeries.deleteMany({
      where: { series: SERIES, electronicDocuments: { none: {} } },
    });
    await prisma.customer.deleteMany({ where: { documentNumber: RUC } });
    await prisma.purchaseInvoice.deleteMany({
      where: { documentSeries: SERIES },
    });
    await prisma.supplier.deleteMany({
      where: { documentNumber: SUPPLIER_RUC },
    });
  }

  async function seedPosData(): Promise<void> {
    const admin = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
    });
    const customer = await prisma.customer.create({
      data: {
        customerStage: 'CUSTOMER',
        customerType: 'COMPANY',
        documentType: 'RUC',
        documentNumber: RUC,
        name: 'E2E SIRE CLIENTE SAC',
      },
    });
    const series = await prisma.fiscalSeries.upsert({
      where: {
        documentType_series: { documentType: 'FACTURA', series: SERIES },
      },
      update: {},
      create: { documentType: 'FACTURA', series: SERIES },
    });

    const makeSale = (n: number, confirmedAt: Date) =>
      prisma.sale.create({
        data: {
          number: `${TAG}-${n}`,
          status: 'ACTIVE',
          paymentStatus: 'UNPAID',
          deliveryStatus: 'NOT_APPLICABLE',
          customerId: customer.id,
          customerIsGeneric: false,
          customerType: 'COMPANY',
          customerDocumentType: 'RUC',
          customerDocumentNumber: RUC,
          customerName: 'E2E SIRE CLIENTE SAC',
          sellerId: admin.id,
          subtotal: '847.46',
          discountAmount: '0.00',
          taxAmount: '152.54',
          total: '1000.00',
          currencyCode: 'PEN',
          taxEnabled: true,
          taxRate: '18.00',
          pricesIncludeTax: false,
          paidAmount: '0.00',
          balanceDue: '1000.00',
          confirmedAt,
        },
      });
    const makeDoc = async (
      n: number,
      status: 'ACCEPTED' | 'REJECTED',
      issuedAt: Date,
    ) => {
      const sale = await makeSale(n, issuedAt);
      await prisma.electronicDocument.create({
        data: {
          saleId: sale.id,
          fiscalSeriesId: series.id,
          documentType: 'FACTURA',
          series: SERIES,
          number: 9000 + n,
          status,
          providerCode: 'MOCK',
          currencyCode: 'PEN',
          issuerTaxId: '20100000001',
          issuerBusinessName: 'E2E SIRE EMISOR SAC',
          customerDocumentType: 'RUC',
          customerDocumentNumber: RUC,
          customerName: 'E2E SIRE CLIENTE SAC',
          subtotal: '847.46',
          discountAmount: '0.00',
          taxableBase: '847.46',
          taxAmount: '152.54',
          total: '1000.00',
          pricesIncludeTax: false,
          issuedAt,
        },
      });
    };

    // Marzo 2025 en Lima: 15/03 10:00 y 31/03 22:00 (ya 01/04 03:00 UTC).
    await makeDoc(1, 'ACCEPTED', new Date('2025-03-15T15:00:00.000Z'));
    await makeDoc(2, 'ACCEPTED', new Date('2025-04-01T03:00:00.000Z'));
    // Abril 2025 en Lima: 01/04 00:00 exacto (05:00 UTC).
    await makeDoc(3, 'ACCEPTED', new Date('2025-04-01T05:00:00.000Z'));
    // Excluido por estado (marzo).
    await makeDoc(4, 'REJECTED', new Date('2025-03-20T15:00:00.000Z'));
    // Venta activa de marzo SIN comprobante fiscal.
    await makeSale(5, new Date('2025-03-18T15:00:00.000Z'));

    // Factura de compra en borrador: existe pero no es elegible para el RCE.
    const supplier = await prisma.supplier.create({
      data: {
        documentType: 'RUC',
        documentNumber: SUPPLIER_RUC,
        countryCode: 'PE',
        legalName: 'E2E SIRE PROVEEDOR SAC',
      },
    });
    await prisma.purchaseInvoice.create({
      data: {
        supplierId: supplier.id,
        documentType: 'FACTURA',
        documentSeries: SERIES,
        documentNumber: '9001',
        issueDate: new Date('2025-03-10T00:00:00.000Z'),
        registrationDate: new Date('2025-03-10T00:00:00.000Z'),
        accountingDate: new Date('2025-03-10T00:00:00.000Z'),
        currencyCode: 'PEN',
        subtotal: '847.46',
        taxAmount: '152.54',
        totalAmount: '1000.00',
        status: 'DRAFT',
        createdByUserId: admin.id,
      },
    });
  }

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
    if (adminLogin.status !== 200) {
      throw new Error(
        `No se pudo autenticar al admin: ${JSON.stringify(adminLogin.body)}`,
      );
    }
    cookies.ADMIN = adminLogin.cookie;
    for (const [key, user] of Object.entries(USERS)) {
      cookies[key] = (
        await login(app.getHttpServer(), user.name, user.password)
      ).cookie;
    }

    await cleanupPosData();
    await seedPosData();
  }, 90000);

  afterAll(async () => {
    try {
      await cleanupPosData();
      const names = Object.values(USERS).map((u) => u.name);
      await prisma.userRole.deleteMany({
        where: { user: { username: { in: names } } },
      });
      await prisma.user.deleteMany({ where: { username: { in: names } } });
    } finally {
      await prisma.$disconnect();
      await app?.close();
      restoreEnv();
    }
  });

  describe('autorización por rol', () => {
    const ROUTES = [
      `${BASE}/context`,
      `${BASE}/registers/rvie/documents?${FIXTURE_QS}`,
      `${BASE}/registers/rce/sample-file?${FIXTURE_QS}`,
    ];

    it.each(ROUTES)('%s sin sesión responde 401', async (url) => {
      expect((await request(app.getHttpServer()).get(url)).status).toBe(401);
    });

    it.each(['ADMIN', 'ACCOUNTANT', 'MANAGEMENT'])(
      '%s consulta las tres rutas',
      async (who) => {
        for (const url of ROUTES) {
          expect((await get(url, who)).status).toBe(200);
        }
      },
    );

    it.each(['SELLER', 'WAREHOUSE'])(
      '%s no accede a información tributaria (403)',
      async (who) => {
        for (const url of ROUTES) {
          expect((await get(url, who)).status).toBe(403);
        }
      },
    );
  });

  describe('GET /context', () => {
    it('identifica el modo DEMO y separa los orígenes', async () => {
      const response = await get(`${BASE}/context`);
      const body = response.body as {
        mode: string;
        officialValidity: boolean;
        formatVersion: string;
        disclaimer: string;
        limits: { maxFileBytes: number; maxRows: number };
        sources: Array<{
          source: string;
          available: boolean;
          fixtureSetVersion: string | null;
          supportedFixtureVersions: string[];
          isEmpty: boolean;
          registers: {
            RVIE: { periods: Array<{ period: string; documentCount: number }> };
            RCE: { periods: Array<{ period: string; documentCount: number }> };
          };
        }>;
      };
      expect(body).toMatchObject({
        mode: 'DEMO',
        officialValidity: false,
        formatVersion: 'DEMO_V1',
        limits: { maxFileBytes: 2097152, maxRows: 5000 },
      });
      expect(body.disclaimer).toContain('Sin validez ante SUNAT');
      expect(body.sources.map((s) => s.source)).toEqual([
        'POS',
        'DEMO_FIXTURES',
      ]);

      const fixtures = body.sources[1];
      expect(fixtures).toMatchObject({
        available: true,
        fixtureSetVersion: 'demo-fixtures-v1',
        supportedFixtureVersions: ['demo-fixtures-v1'],
        isEmpty: false,
      });
      expect(fixtures.registers.RVIE.periods).toEqual([
        { period: '202601', documentCount: 14 },
      ]);
      expect(fixtures.registers.RCE.periods).toEqual([
        { period: '202601', documentCount: 14 },
      ]);
    });

    it('POS refleja las filas reales de la base (conversión a America/Lima incluida)', async () => {
      const body = (await get(`${BASE}/context`)).body as {
        sources: Array<{
          source: string;
          isEmpty: boolean;
          registers: {
            RVIE: { periods: Array<{ period: string; documentCount: number }> };
            RCE: { periods: Array<{ period: string; documentCount: number }> };
          };
        }>;
      };
      const pos = body.sources[0];
      expect(pos.isEmpty).toBe(false);
      expect(pos.registers.RVIE.periods).toEqual(
        expect.arrayContaining([
          { period: '202503', documentCount: 2 },
          { period: '202504', documentCount: 1 },
        ]),
      );
      // Cuadra con el conteo directo de la base.
      const total = pos.registers.RVIE.periods.reduce(
        (acc, p) => acc + p.documentCount,
        0,
      );
      expect(total).toBe(
        await prisma.electronicDocument.count({
          where: { status: 'ACCEPTED' },
        }),
      );
      const rceTotal = pos.registers.RCE.periods.reduce(
        (acc, p) => acc + p.documentCount,
        0,
      );
      expect(rceTotal).toBe(
        await prisma.purchaseInvoice.count({ where: { status: 'CONFIRMED' } }),
      );
    });
  });

  describe('GET /registers/:register/documents — DEMO_FIXTURES', () => {
    it('RVIE: contrato JSON y totales', async () => {
      const response = await get(
        `${BASE}/registers/rvie/documents?${FIXTURE_QS}`,
      );
      expect(response.status).toBe(200);
      const body = response.body as DocsBody;
      expect(body).toMatchObject({
        mode: 'DEMO',
        officialValidity: false,
        formatVersion: 'DEMO_V1',
        source: 'DEMO_FIXTURES',
        fixtureSetVersion: 'demo-fixtures-v1',
        register: 'RVIE',
        period: '202601',
        periodRule: 'issueDate (America/Lima) - PROVISIONAL (DEMO)',
        page: 1,
        pageSize: 50,
        totalItems: 14,
      });
      expect(body.summary.excluded).toEqual({
        notEligibleStatus: 2,
        salesWithoutFiscalDocument: null,
      });
      expect(body.summary.totalsByCurrency).toEqual({
        PEN: {
          documents: 14,
          taxableBase: '11016.98',
          igv: '1983.02',
          unclassifiedTotal: '1000.00',
          total: '14000.00',
        },
      });
      expect(body.summary.flags.TAX_TREATMENT_UNCLASSIFIED).toBe(1);
      expect(body.items[0]).toEqual({
        refId: 'fixture-rvie-F001-1',
        key: { docTypeCode: '01', series: 'F001', number: '1' },
        docTypeCode: '01',
        series: 'F001',
        number: '1',
        issueDate: '2026-01-05',
        accountingDate: null,
        counterparty: {
          docTypeCode: '6',
          docNumber: '99999000001',
          name: 'DEMO CLIENTE 1 SAC',
        },
        currencyCode: 'PEN',
        taxableBase: '847.46',
        igv: '152.54',
        total: '1000.00',
        internalStatus: 'ACCEPTED_MOCK',
        flags: [],
      });
    });

    it('RCE: periodo por accountingDate y recibo sin código', async () => {
      const body = (await get(`${BASE}/registers/RCE/documents?${FIXTURE_QS}`))
        .body as DocsBody;
      expect(body).toMatchObject({
        register: 'RCE',
        periodRule: 'accountingDate - PROVISIONAL (DEMO)',
        totalItems: 14,
      });
      expect(body.summary.flags.DOC_TYPE_UNMAPPED).toBe(1);
      expect(
        body.items.find((i) => i.refId === 'fixture-rce-E001-108'),
      ).toMatchObject({
        issueDate: '2025-12-28',
        accountingDate: '2026-01-12',
      });
    });

    it('pagina, filtra por alerta y mantiene el resumen del periodo', async () => {
      const page = (
        await get(
          `${BASE}/registers/rvie/documents?${FIXTURE_QS}&page=3&pageSize=5`,
        )
      ).body as DocsBody;
      expect(page.items).toHaveLength(4);
      expect(page).toMatchObject({ page: 3, pageSize: 5, totalItems: 14 });

      const flagged = (
        await get(
          `${BASE}/registers/rvie/documents?${FIXTURE_QS}&flag=TAX_TREATMENT_UNCLASSIFIED`,
        )
      ).body as DocsBody;
      expect(flagged.items).toHaveLength(1);
      expect(flagged.totalItems).toBe(1);
      expect(flagged.summary.documentCount).toBe(14);
    });

    it('un periodo sin fixtures responde vacío', async () => {
      const body = (
        await get(
          `${BASE}/registers/rvie/documents?source=DEMO_FIXTURES&period=202602`,
        )
      ).body as DocsBody;
      expect(body.items).toEqual([]);
      expect(body.summary).toMatchObject({
        documentCount: 0,
        totalsByCurrency: {},
      });
    });
  });

  describe('GET /registers/:register/documents — POS (filas reales)', () => {
    it('RVIE marzo 2025: elegibles, excluidos y ventas sin comprobante', async () => {
      const response = await get(
        `${BASE}/registers/rvie/documents?source=POS&period=202503`,
      );
      expect(response.status).toBe(200);
      const body = response.body as DocsBody;
      expect(body).toMatchObject({
        mode: 'DEMO',
        officialValidity: false,
        source: 'POS',
        fixtureSetVersion: null,
        totalItems: 2,
      });
      expect(body.summary.excluded).toEqual({
        notEligibleStatus: 1,
        salesWithoutFiscalDocument: 1,
      });
      expect(body.summary.totalsByCurrency).toEqual({
        PEN: {
          documents: 2,
          taxableBase: '1694.92',
          igv: '305.08',
          unclassifiedTotal: '0.00',
          total: '2000.00',
        },
      });
      expect(body.items.map((i) => i.key)).toEqual([
        { docTypeCode: '01', series: SERIES, number: '9001' },
        { docTypeCode: '01', series: SERIES, number: '9002' },
      ]);
      expect(body.items[0]).toMatchObject({
        issueDate: '2025-03-15',
        internalStatus: 'ACCEPTED_MOCK',
        total: '1000.00',
      });
      // 01/04 03:00 UTC sigue siendo 31/03 en Lima.
      expect(body.items[1]).toMatchObject({ issueDate: '2025-03-31' });
    });

    it('RVIE abril 2025: el límite exacto de mes en Lima', async () => {
      const body = (
        await get(`${BASE}/registers/rvie/documents?source=POS&period=202504`)
      ).body as DocsBody;
      expect(body.totalItems).toBe(1);
      expect(body.items[0]).toMatchObject({
        key: { number: '9003' },
        issueDate: '2025-04-01',
      });
      expect(body.summary.excluded).toEqual({
        notEligibleStatus: 0,
        salesWithoutFiscalDocument: 0,
      });
    });

    it('RCE: una factura de compra en borrador se excluye del registro', async () => {
      const body = (
        await get(`${BASE}/registers/rce/documents?source=POS&period=202503`)
      ).body as DocsBody;
      expect(body.totalItems).toBe(0);
      expect(body.summary.excluded).toEqual({
        notEligibleStatus: 1,
        salesWithoutFiscalDocument: null,
      });
    });

    it('nunca mezcla: el origen POS no ve los fixtures y viceversa', async () => {
      const pos = (
        await get(`${BASE}/registers/rvie/documents?source=POS&period=202601`)
      ).body as DocsBody;
      expect(
        pos.items.some((i) => String(i.refId).startsWith('fixture-')),
      ).toBe(false);
      const fx = (await get(`${BASE}/registers/rvie/documents?${FIXTURE_QS}`))
        .body as DocsBody;
      expect(
        fx.items.every((i) => String(i.refId).startsWith('fixture-')),
      ).toBe(true);
    });

    it('un periodo sin datos reales responde vacío', async () => {
      const body = (
        await get(`${BASE}/registers/rvie/documents?source=POS&period=200001`)
      ).body as DocsBody;
      expect(body.items).toEqual([]);
      expect(body.summary.excluded).toEqual({
        notEligibleStatus: 0,
        salesWithoutFiscalDocument: 0,
      });
    });
  });

  describe('validación de parámetros', () => {
    it.each([
      ['source ausente', `${BASE}/registers/rvie/documents?period=202601`],
      [
        'source inválido',
        `${BASE}/registers/rvie/documents?source=PRODUCCION&period=202601`,
      ],
      ['period ausente', `${BASE}/registers/rvie/documents?source=POS`],
      [
        'period con mes 13',
        `${BASE}/registers/rvie/documents?source=POS&period=202613`,
      ],
      [
        'period con formato libre',
        `${BASE}/registers/rvie/documents?source=POS&period=2026-01`,
      ],
      ['registro desconocido', `${BASE}/registers/foo/documents?${FIXTURE_QS}`],
      [
        'flag inexistente',
        `${BASE}/registers/rvie/documents?${FIXTURE_QS}&flag=X`,
      ],
      [
        'pageSize excesivo',
        `${BASE}/registers/rvie/documents?${FIXTURE_QS}&pageSize=201`,
      ],
      ['page cero', `${BASE}/registers/rvie/documents?${FIXTURE_QS}&page=0`],
      [
        'sample-file sin source',
        `${BASE}/registers/rvie/sample-file?period=202601`,
      ],
    ])('%s responde 400', async (_label, url) => {
      expect((await get(url)).status).toBe(400);
    });
  });

  describe('GET /registers/:register/sample-file', () => {
    it('DEMO_FIXTURES: archivo versionado, descargable y parseable', async () => {
      for (const register of ['rvie', 'rce'] as const) {
        const response = await get(
          `${BASE}/registers/${register}/sample-file?${FIXTURE_QS}`,
        );
        expect(response.status).toBe(200);
        expect(response.headers['content-type']).toContain(
          'text/plain; charset=utf-8',
        );
        expect(response.headers['content-disposition']).toBe(
          `attachment; filename="DEMO_V1_${register.toUpperCase()}_202601_DEMO_FIXTURES.txt"`,
        );
        expect(response.headers['x-sire-mode']).toBe('DEMO');
        expect(response.text).toBe(
          CURRENT_FIXTURE_SET.sampleFiles[
            register.toUpperCase() as 'RVIE' | 'RCE'
          ].content,
        );
        const parsed = parseDemoProposal(response.text);
        expect(parsed.ok && parsed.header.fixtureSetVersion).toBe(
          'demo-fixtures-v1',
        );
      }
    });

    it('DEMO_FIXTURES con un periodo fuera del conjunto: 400 FIXTURE_PERIOD_UNAVAILABLE', async () => {
      const response = await get(
        `${BASE}/registers/rvie/sample-file?source=DEMO_FIXTURES&period=202602`,
      );
      expect(response.status).toBe(400);
      expect(response.body).toMatchObject({
        code: 'FIXTURE_PERIOD_UNAVAILABLE',
      });
    });

    it('POS: deriva el archivo de los documentos reales y lo identifica como POS', async () => {
      const response = await get(
        `${BASE}/registers/rvie/sample-file?source=POS&period=202503`,
      );
      expect(response.status).toBe(200);
      expect(response.headers['content-disposition']).toContain(
        'DEMO_V1_RVIE_202503_POS.txt',
      );
      expect(response.text.split('\n')[0]).toBe(
        '#DEMO_V1|SOURCE=POS|REGISTER=RVIE|PERIOD=202503',
      );
      const parsed = parseDemoProposal(response.text, {
        expected: { source: 'POS', register: 'RVIE', period: '202503' },
      });
      expect(parsed.ok).toBe(true);
      // Primer documento real + su duplicado + la fila sintética ZZ99.
      expect(
        parsed.ok && parsed.rows.map((r) => `${r.series}-${r.number}`),
      ).toEqual([`${SERIES}-9001`, `${SERIES}-9001`, 'ZZ99-1']);
    });

    it('POS sin documentos: 409 POS_SOURCE_EMPTY', async () => {
      for (const register of ['rvie', 'rce']) {
        const response = await get(
          `${BASE}/registers/${register}/sample-file?source=POS&period=200001`,
        );
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({ code: 'POS_SOURCE_EMPTY' });
      }
    });
  });

  describe('documentación y aislamiento', () => {
    it('las rutas de S1, S2 y S3 aparecen en OpenAPI cuando el módulo está activo', async () => {
      const docs = await request(app.getHttpServer()).get('/api/docs-json');
      const paths = Object.keys(
        (docs.body as { paths: Record<string, unknown> }).paths,
      )
        .filter((p) => p.includes('sire-demo'))
        .sort();
      expect(paths).toEqual([
        '/api/v1/sire-demo/context',
        '/api/v1/sire-demo/proposals',
        '/api/v1/sire-demo/proposals/{id}/discard',
        '/api/v1/sire-demo/proposals/{id}/reconciliation',
        '/api/v1/sire-demo/proposals/{id}/reconciliation/export.xlsx',
        '/api/v1/sire-demo/registers/{register}/documents',
        '/api/v1/sire-demo/registers/{register}/sample-file',
      ]);
    });

    it('ninguna ruta modifica ventas, compras, inventario, contabilidad ni auditoría', async () => {
      const snapshot = async () => ({
        sales: await prisma.sale.count(),
        electronicDocuments: await prisma.electronicDocument.count(),
        purchaseInvoices: await prisma.purchaseInvoice.count(),
        accountingEntries: await prisma.accountingEntry.count(),
        inventoryMovements: await prisma.inventoryMovement.count(),
        auditLogs: await prisma.auditLog.count(),
      });
      const before = await snapshot();
      for (const who of ['ADMIN', 'ACCOUNTANT', 'MANAGEMENT']) {
        await get(`${BASE}/context`, who);
        await get(
          `${BASE}/registers/rvie/documents?source=POS&period=202503`,
          who,
        );
        await get(`${BASE}/registers/rce/documents?${FIXTURE_QS}`, who);
        await get(
          `${BASE}/registers/rvie/sample-file?source=POS&period=202503`,
          who,
        );
        await get(`${BASE}/registers/rce/sample-file?${FIXTURE_QS}`, who);
      }
      expect(await snapshot()).toEqual(before);
    });
  });
});
