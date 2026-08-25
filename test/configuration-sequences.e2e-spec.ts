import { INestApplication } from '@nestjs/common';
import {
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
import { AuditAction } from '../src/audit/audit-action.enum';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Suite dedicada de administración de secuencias (Fase 10, Bloque D):
 * GET/PATCH /configuration/sequences/:documentType. Separada de
 * configuration.e2e-spec.ts/configuration-commercial.e2e-spec.ts/
 * configuration-tax.e2e-spec.ts porque el riesgo es distinto (concurrencia
 * real de generación automática de correlativos vs. administración manual),
 * no una simple extensión de CompanySettings.
 *
 * Usuarios SELLER/WAREHOUSE/MANAGEMENT: se reutilizan exactamente los mismos
 * username/password que configuration.e2e-spec.ts (mismo criterio de
 * fixtures compartidas idempotentes vía upsertFixtureUser — nunca se crean
 * usuarios adicionales solo para esta suite).
 *
 * document_sequences QUOTE/SALE: mismo criterio defensivo que
 * quotes.e2e-spec.ts/sales.e2e-spec.ts/configuration-commercial.e2e-spec.ts/
 * configuration-tax.e2e-spec.ts — upsert con `update: {}` al iniciar (nunca
 * asume currentNumber == 0), deleteMany completo al cerrar (nunca un UPDATE
 * de "reseteo": el siguiente archivo que las necesite las recrea frescas en
 * su propio upsert). Restaurar el currentNumber EXACTO previo por API es
 * imposible por diseño una vez avanzado (la invariante de no-decremento del
 * propio Bloque D lo impide deliberadamente); el deleteMany final logra el
 * mismo objetivo neto (cero crecimiento no controlado) sin depender de una
 * vía que el propio bloque bloquea intencionalmente.
 */

const SELLER_USERNAME = 'e2e_seller_configuration';
const SELLER_PASSWORD = 'SellerConfig123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_configuration';
const WAREHOUSE_PASSWORD = 'WarehouseConfig123';
const MANAGEMENT_USERNAME = 'e2e_management_configuration';
const MANAGEMENT_PASSWORD = 'ManagementConfig123';

interface SafeSequenceBody {
  id: string;
  documentType: DocumentType;
  prefix: string;
  padding: number;
  currentNumber: number;
  updatedAt: string;
}

interface SafeQuoteBody {
  id: string;
  number: string;
}

interface SafeSaleBody {
  id: string;
  number: string;
}

/**
 * Snapshot exacto del estado de un DocumentSequence ANTES de que esta suite
 * lo toque, capturado por lectura directa de Prisma (nunca vía la API
 * pública) antes del upsert defensivo de beforeAll. `existed: false`
 * significa que la fila no existía en absoluto: en ese caso la suite la creó
 * y afterAll debe eliminarla por completo, nunca "restaurarla" a un valor
 * inventado. `existed: true` conserva prefix/padding/currentNumber exactos
 * para una restauración directa por fixture (updatedAt no se restaura: lo
 * mantiene Prisma automáticamente y ningún test de este archivo depende de
 * su valor exacto).
 */
interface SequenceSnapshot {
  existed: boolean;
  prefix?: string;
  padding?: number;
  currentNumber?: number;
}

describe('Configuration — Document Sequence Administration (Bloque 10, D) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let managementCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let customerId: string;

  let sequenceAuditBaselineCount: number;

  /** Snapshots exactos pre-suite (sección 3 del kickoff de remediación), capturados antes de cualquier upsert. */
  let quoteSequenceSnapshot: SequenceSnapshot;
  let saleSequenceSnapshot: SequenceSnapshot;

  const createdProductIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdQuoteIds: string[] = [];
  const createdSaleIds: string[] = [];
  const ownedSequenceAuditLogIds: string[] = [];

  /** Lectura directa (nunca vía API): captura el estado exacto ANTES de tocar nada. */
  async function captureSequenceSnapshot(
    documentType: DocumentType,
  ): Promise<SequenceSnapshot> {
    const row = await prisma.documentSequence.findUnique({
      where: { documentType },
    });
    if (row === null) {
      return { existed: false };
    }
    return {
      existed: true,
      prefix: row.prefix,
      padding: row.padding,
      currentNumber: row.currentNumber,
    };
  }

  /**
   * Restauración de fixture (nunca la API pública `PATCH
   * /configuration/sequences`): si la fila existía antes de la suite, se
   * restaura exactamente prefix/padding/currentNumber por escritura directa
   * de Prisma — permitido y esperado incluso si currentNumber debe
   * DISMINUIR, porque esto es limpieza de prueba, no la invariante de
   * negocio de no-decremento (que sigue intacta y sin tocar en
   * SequenceAdminService). Si la fila NO existía, se elimina por completo:
   * la existencia final debe igualar la existencia inicial, nunca "ambas
   * filas siempre presentes" ni "ambas filas siempre ausentes".
   */
  async function restoreSequenceSnapshot(
    documentType: DocumentType,
    snapshot: SequenceSnapshot,
  ): Promise<void> {
    if (snapshot.existed) {
      await prisma.documentSequence.update({
        where: { documentType },
        data: {
          prefix: snapshot.prefix,
          padding: snapshot.padding,
          currentNumber: snapshot.currentNumber,
        },
      });
    } else {
      await prisma.documentSequence.deleteMany({ where: { documentType } });
    }
  }

  /**
   * Verificación de aislamiento (sección 9 del kickoff de remediación):
   * compara existencia y, si existía, prefix/padding/currentNumber exactos
   * contra el snapshot pre-suite. Se invoca al final de afterAll, después de
   * toda la limpieza física — un throw aquí nunca debe saltarse limpieza
   * pendiente (lección del Bloque C).
   */
  async function assertSequenceMatchesSnapshot(
    documentType: DocumentType,
    snapshot: SequenceSnapshot,
  ): Promise<void> {
    const row = await prisma.documentSequence.findUnique({
      where: { documentType },
    });
    if (!snapshot.existed) {
      if (row !== null) {
        throw new Error(
          `Aislamiento violado: ${documentType} no existía antes de la suite y sigue existiendo al cerrarla`,
        );
      }
      return;
    }
    if (row === null) {
      throw new Error(
        `Aislamiento violado: ${documentType} existía antes de la suite y no existe al cerrarla`,
      );
    }
    if (
      row.prefix !== snapshot.prefix ||
      row.padding !== snapshot.padding ||
      row.currentNumber !== snapshot.currentNumber
    ) {
      throw new Error(
        `Aislamiento violado en ${documentType}: esperado prefix=${snapshot.prefix} padding=${snapshot.padding} currentNumber=${snapshot.currentNumber}, encontrado prefix=${row.prefix} padding=${row.padding} currentNumber=${row.currentNumber}`,
      );
    }
  }

  async function getSequences(
    cookie?: string,
  ): Promise<{ status: number; body: SafeSequenceBody[] }> {
    const req = request(app.getHttpServer()).get(
      '/api/v1/configuration/sequences',
    );
    if (cookie !== undefined) {
      req.set('Cookie', cookie);
    }
    const response = await req;
    return {
      status: response.status,
      body: response.body as SafeSequenceBody[],
    };
  }

  /**
   * `cookie` usa `null` (nunca `undefined`) para pedir explícitamente "sin
   * cookie": un parámetro con valor por defecto se sustituye también cuando
   * se pasa `undefined` de forma explícita (no solo cuando se omite), así
   * que un default de `undefined` sería indistinguible de "usar el admin".
   */
  async function patchSequence(
    documentType: string,
    body: Record<string, unknown>,
    cookie: string | null = adminCookie,
  ): Promise<{ status: number; body: SafeSequenceBody }> {
    const req = request(app.getHttpServer()).patch(
      `/api/v1/configuration/sequences/${documentType}`,
    );
    if (cookie !== null) {
      req.set('Cookie', cookie);
    }
    const response = await req.send(body);
    return { status: response.status, body: response.body as SafeSequenceBody };
  }

  async function trackLatestSequenceAuditRow(): Promise<{
    id: string;
    metadata: unknown;
  }> {
    const row = await prisma.auditLog.findFirst({
      where: { action: AuditAction.SEQUENCE_UPDATED },
      orderBy: { createdAt: 'desc' },
    });
    if (row === null) {
      throw new Error('Se esperaba una fila SEQUENCE_UPDATED recién creada');
    }
    ownedSequenceAuditLogIds.push(row.id);
    return row;
  }

  async function createQuote(body: {
    customerId: string;
    expirationDate?: string;
    items: { productId: string; quantity: string }[];
  }): Promise<{ status: number; body: SafeQuoteBody }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/quotes')
      .set('Cookie', adminCookie)
      .send(body);
    if (response.status === 201) {
      createdQuoteIds.push((response.body as SafeQuoteBody).id);
    }
    return { status: response.status, body: response.body as SafeQuoteBody };
  }

  async function createDirectSale(body: {
    customerId: string;
    items: { productId: string; quantity: string }[];
  }): Promise<{ status: number; body: SafeSaleBody }> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send(body);
    if (response.status === 201) {
      createdSaleIds.push((response.body as SafeSaleBody).id);
    }
    return { status: response.status, body: response.body as SafeSaleBody };
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_configuration@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_configuration@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_configuration@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
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
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;

    // Snapshot exacto ANTES de tocar nada (sección 3 del kickoff de
    // remediación): captura si la fila existía y, de ser así, sus valores
    // exactos, para poder restaurar el estado compartido byte-a-byte en
    // afterAll en vez de recrearlo siempre desde cero.
    quoteSequenceSnapshot = await captureSequenceSnapshot(DocumentType.QUOTE);
    saleSequenceSnapshot = await captureSequenceSnapshot(DocumentType.SALE);

    await prisma.documentSequence.upsert({
      where: { documentType: DocumentType.QUOTE },
      update: {},
      create: {
        documentType: DocumentType.QUOTE,
        prefix: 'COT-',
        currentNumber: 0,
        padding: 6,
      },
    });
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
      where: { code: 'E2ECFGSEQCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2ECFGSEQCAT', name: 'Categoria E2E Config Secuencias' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2ECFGSEQU' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2ECFGSEQU',
        name: 'Unidad E2E Config Secuencias',
        abbreviation: 'ecsq',
        allowDecimal: false,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: 'E2ECFGSEQ-P1',
        name: 'Producto E2E Config Secuencias',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('50.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('1000.000'),
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
        name: 'Cliente E2E Config Secuencias',
      },
    });
    customerId = customer.id;
    createdCustomerIds.push(customerId);

    sequenceAuditBaselineCount = await prisma.auditLog.count({
      where: { action: AuditAction.SEQUENCE_UPDATED },
    });
  });

  afterAll(async () => {
    try {
      if (ownedSequenceAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedSequenceAuditLogIds } },
        });
      }

      const allSaleIds = [...createdSaleIds];
      if (allSaleIds.length > 0) {
        const ownedEntries = await prisma.accountingEntry.findMany({
          where: { sourceType: 'SALE', sourceId: { in: allSaleIds } },
          select: { id: true },
        });
        const ownedEntryIds = ownedEntries.map((entry) => entry.id);
        if (ownedEntryIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: {
              entityType: 'AccountingEntry',
              entityId: { in: ownedEntryIds },
            },
          });
        }
        await prisma.accountingEntry.deleteMany({
          where: { sourceType: 'SALE', sourceId: { in: allSaleIds } },
        });

        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: allSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: allSaleIds } } });
      }

      const allQuoteIds = [...createdQuoteIds];
      if (allQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: allQuoteIds } },
        });
        await prisma.quote.deleteMany({ where: { id: { in: allQuoteIds } } });
      }

      if (createdProductIds.length > 0) {
        // La venta directa confirmada descuenta stock: queda un
        // InventoryMovement referenciando el producto (sin FK a Sale). Se
        // limpia por productId — mismo criterio que sales.e2e-spec.ts — o
        // el FK inventory_movements_product_id_fkey bloquea el DELETE.
        await prisma.inventoryMovement.deleteMany({
          where: { productId: { in: createdProductIds } },
        });
        await prisma.product.deleteMany({
          where: { id: { in: createdProductIds } },
        });
      }

      await prisma.unit.deleteMany({ where: { id: unitId } });
      await prisma.category.deleteMany({ where: { id: categoryId } });

      if (createdCustomerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'Customer',
            entityId: { in: createdCustomerIds },
          },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: createdCustomerIds } },
        });
      }

      // Restauración exacta por fixture (nunca deleteMany incondicional, y
      // nunca vía la API pública): si la fila existía antes de la suite se
      // restaura byte-a-byte a sus valores originales, incluso si
      // currentNumber debe disminuir — legítimo en limpieza de prueba,
      // nunca en la API real (SequenceAdminService no se toca). Si no
      // existía, se elimina exactamente esa fila. Nunca "ambas siempre
      // presentes" ni "ambas siempre ausentes": la existencia final debe
      // igualar la inicial, por tipo de documento.
      await restoreSequenceSnapshot(DocumentType.QUOTE, quoteSequenceSnapshot);
      await restoreSequenceSnapshot(DocumentType.SALE, saleSequenceSnapshot);

      // Verificaciones finales DESPUÉS de toda la limpieza física (lección
      // del Bloque C: un throw aquí nunca debe saltarse limpieza pendiente).
      await assertSequenceMatchesSnapshot(
        DocumentType.QUOTE,
        quoteSequenceSnapshot,
      );
      await assertSequenceMatchesSnapshot(
        DocumentType.SALE,
        saleSequenceSnapshot,
      );

      const finalSequenceAuditCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });
      if (finalSequenceAuditCount !== sequenceAuditBaselineCount) {
        throw new Error(
          `Residuo de auditoría SEQUENCE_UPDATED no controlado: esperado ${sequenceAuditBaselineCount}, encontrado ${finalSequenceAuditCount}`,
        );
      }

      const finalOwnedQuoteCount = await prisma.quote.count({
        where: { id: { in: createdQuoteIds } },
      });
      if (finalOwnedQuoteCount !== 0) {
        throw new Error(
          `Residuo de Quote propio no controlado: encontrados ${finalOwnedQuoteCount}`,
        );
      }
      const finalOwnedSaleCount = await prisma.sale.count({
        where: { id: { in: createdSaleIds } },
      });
      if (finalOwnedSaleCount !== 0) {
        throw new Error(
          `Residuo de Sale propio no controlado: encontrados ${finalOwnedSaleCount}`,
        );
      }

      const settingsCount = await prisma.companySettings.count();
      if (settingsCount !== 1) {
        throw new Error(
          `Invariante de singleton violado al cerrar la suite: se esperaba 1 fila, se encontraron ${settingsCount}`,
        );
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  describe('§38 — Matriz de roles', () => {
    it('GET: ADMIN 200, MANAGEMENT 200, SELLER 403, WAREHOUSE 403, sin cookie 401', async () => {
      expect((await getSequences(adminCookie)).status).toBe(200);
      expect((await getSequences(managementCookie)).status).toBe(200);
      expect((await getSequences(sellerCookie)).status).toBe(403);
      expect((await getSequences(warehouseCookie)).status).toBe(403);
      expect((await getSequences(undefined)).status).toBe(401);
    });

    it('PATCH: ADMIN 200 (no-op), MANAGEMENT 403, SELLER 403, WAREHOUSE 403, sin cookie 401', async () => {
      const current = await getSequences(adminCookie);
      const quoteRow = current.body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (quoteRow === undefined) {
        throw new Error('Se esperaba una fila QUOTE en la lista');
      }

      const beforeCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });

      const admin = await patchSequence(
        DocumentType.QUOTE,
        { prefix: quoteRow.prefix },
        adminCookie,
      );
      expect(admin.status).toBe(200);

      const afterCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });
      expect(afterCount).toBe(beforeCount);

      const management = await patchSequence(
        DocumentType.QUOTE,
        { prefix: quoteRow.prefix },
        managementCookie,
      );
      expect(management.status).toBe(403);

      const seller = await patchSequence(
        DocumentType.QUOTE,
        { prefix: quoteRow.prefix },
        sellerCookie,
      );
      expect(seller.status).toBe(403);

      const warehouse = await patchSequence(
        DocumentType.QUOTE,
        { prefix: quoteRow.prefix },
        warehouseCookie,
      );
      expect(warehouse.status).toBe(403);

      const unauth = await patchSequence(
        DocumentType.QUOTE,
        { prefix: quoteRow.prefix },
        null,
      );
      expect(unauth.status).toBe(401);
    });
  });

  describe('§39 — GET devuelve QUOTE y SALE exactos, sin auditoría', () => {
    it('lista ambos tipos con documentType/prefix/padding/currentNumber; no genera AuditLog', async () => {
      const beforeCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });

      const response = await getSequences(adminCookie);
      expect(response.status).toBe(200);
      expect(response.body).toHaveLength(2);

      const quoteRow = response.body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      const saleRow = response.body.find(
        (row) => row.documentType === DocumentType.SALE,
      );
      expect(quoteRow).toBeDefined();
      expect(saleRow).toBeDefined();
      expect(typeof quoteRow?.prefix).toBe('string');
      expect(typeof quoteRow?.padding).toBe('number');
      expect(typeof quoteRow?.currentNumber).toBe('number');

      const afterCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe('§29 — documentType inválido', () => {
    it('PATCH /configuration/sequences/INVALID -> 400', async () => {
      const response = await patchSequence('INVALID', { prefix: 'X-' });
      expect(response.status).toBe(400);
    });
  });

  describe('§32 — Validación', () => {
    it('body vacío -> 400', async () => {
      const response = await patchSequence(DocumentType.QUOTE, {});
      expect(response.status).toBe(400);
    });

    it('prefix en blanco -> 400', async () => {
      const response = await patchSequence(DocumentType.QUOTE, {
        prefix: '   ',
      });
      expect(response.status).toBe(400);
    });

    it('prefix de más de 10 caracteres -> 400', async () => {
      const response = await patchSequence(DocumentType.QUOTE, {
        prefix: '12345678901',
      });
      expect(response.status).toBe(400);
    });

    it.each([0, 13])('padding = %d fuera de 1..12 -> 400', async (padding) => {
      const response = await patchSequence(DocumentType.QUOTE, { padding });
      expect(response.status).toBe(400);
    });

    it('currentNumber negativo -> 400', async () => {
      const response = await patchSequence(DocumentType.QUOTE, {
        currentNumber: -1,
      });
      expect(response.status).toBe(400);
    });

    it('campo no declarado -> 400 (forbidNonWhitelisted)', async () => {
      const response = await patchSequence(DocumentType.QUOTE, {
        documentType: DocumentType.SALE,
      });
      expect(response.status).toBe(400);
    });
  });

  describe('§24/§33 — PATCH no-op', () => {
    it('mismos prefix/padding/currentNumber -> 200, sin auditoría, sin cambios', async () => {
      const current = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (current === undefined) throw new Error('Fila QUOTE no encontrada');

      const beforeCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });

      const response = await patchSequence(DocumentType.QUOTE, {
        prefix: current.prefix,
        padding: current.padding,
        currentNumber: current.currentNumber,
      });
      expect(response.status).toBe(200);
      expect(response.body.prefix).toBe(current.prefix);
      expect(response.body.padding).toBe(current.padding);
      expect(response.body.currentNumber).toBe(current.currentNumber);

      const afterCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });
      expect(afterCount).toBe(beforeCount);
    });
  });

  describe('§40/§43 — Cambio de prefix/padding: histórico inalterado, nuevos documentos usan la config nueva', () => {
    it('QUOTE: cotización previa conserva su número; cotización nueva usa prefix/padding nuevos', async () => {
      const before = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(before.status).toBe(201);
      const previousNumber = before.body.number;

      const patchResponse = await patchSequence(DocumentType.QUOTE, {
        prefix: 'QSEQ-',
        padding: 8,
      });
      expect(patchResponse.status).toBe(200);
      expect(patchResponse.body.prefix).toBe('QSEQ-');
      expect(patchResponse.body.padding).toBe(8);
      await trackLatestSequenceAuditRow();

      const stillUnchanged = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${before.body.id}`)
        .set('Cookie', adminCookie);
      expect((stillUnchanged.body as SafeQuoteBody).number).toBe(
        previousNumber,
      );

      const after = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(after.status).toBe(201);
      const expectedNext = patchResponse.body.currentNumber + 1;
      expect(after.body.number).toBe(
        `QSEQ-${String(expectedNext).padStart(8, '0')}`,
      );
    });
  });

  describe('§41 — currentNumber hacia adelante: siguiente generado = nuevo + 1', () => {
    it('QUOTE: avanza currentNumber y verifica el formato exacto del siguiente número', async () => {
      const current = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (current === undefined) throw new Error('Fila QUOTE no encontrada');

      const forward = current.currentNumber + 25;
      const patchResponse = await patchSequence(DocumentType.QUOTE, {
        currentNumber: forward,
      });
      expect(patchResponse.status).toBe(200);
      expect(patchResponse.body.currentNumber).toBe(forward);
      await trackLatestSequenceAuditRow();

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      expect(created.body.number).toBe(
        `${current.prefix}${String(forward + 1).padStart(current.padding, '0')}`,
      );
    });
  });

  describe('§42 — Rechazo de disminución', () => {
    it('PATCH currentNumber menor -> 409, secuencia sin cambios, cero auditoría, siguiente generación válida', async () => {
      const before = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (before === undefined) throw new Error('Fila QUOTE no encontrada');

      const beforeCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });

      const decrease = await patchSequence(DocumentType.QUOTE, {
        currentNumber: Math.max(0, before.currentNumber - 5),
      });
      expect(decrease.status).toBe(409);

      const afterCount = await prisma.auditLog.count({
        where: { action: AuditAction.SEQUENCE_UPDATED },
      });
      expect(afterCount).toBe(beforeCount);

      const unchanged = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      expect(unchanged?.currentNumber).toBe(before.currentNumber);
      expect(unchanged?.prefix).toBe(before.prefix);
      expect(unchanged?.padding).toBe(before.padding);

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      expect(created.body.number).toBe(
        `${before.prefix}${String(before.currentNumber + 1).padStart(before.padding, '0')}`,
      );
    });
  });

  describe('§44 — Auditoría exacta', () => {
    it('un PATCH combinado real genera exactamente un SEQUENCE_UPDATED con documentType/changedFields/oldValues/newValues exactos', async () => {
      const before = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (before === undefined) throw new Error('Fila QUOTE no encontrada');

      const newCurrentNumber = before.currentNumber + 3;
      const response = await patchSequence(DocumentType.QUOTE, {
        prefix: 'QAUD-',
        currentNumber: newCurrentNumber,
      });
      expect(response.status).toBe(200);
      const audit = await trackLatestSequenceAuditRow();

      const metadata = audit.metadata as {
        documentType: string;
        changedFields: string[];
        oldValues: Record<string, unknown>;
        newValues: Record<string, unknown>;
      };
      expect(metadata.documentType).toBe(DocumentType.QUOTE);
      expect(metadata.changedFields.sort()).toEqual(
        ['currentNumber', 'prefix'].sort(),
      );
      expect(metadata.oldValues).toEqual({
        prefix: before.prefix,
        currentNumber: before.currentNumber,
      });
      expect(metadata.newValues).toEqual({
        prefix: 'QAUD-',
        currentNumber: newCurrentNumber,
      });
    });
  });

  describe('§47 — Cobertura SALE', () => {
    it('cambia prefix/padding/currentNumber de SALE y verifica el formato del siguiente número generado', async () => {
      const current = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.SALE,
      );
      if (current === undefined) throw new Error('Fila SALE no encontrada');

      const forward = current.currentNumber + 10;
      const patchResponse = await patchSequence(DocumentType.SALE, {
        prefix: 'VSEQ-',
        padding: 7,
        currentNumber: forward,
      });
      expect(patchResponse.status).toBe(200);
      await trackLatestSequenceAuditRow();

      const sale = await createDirectSale({
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      expect(sale.body.number).toBe(
        `VSEQ-${String(forward + 1).padStart(7, '0')}`,
      );
    });
  });

  describe('§45 — CRÍTICO: concurrencia next() vs PATCH admin de currentNumber', () => {
    it('venta/cotización real concurrente con PATCH currentNumber: invariantes sostenidas sin importar el orden de ejecución', async () => {
      const before = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (before === undefined) throw new Error('Fila QUOTE no encontrada');

      // Ancla muy por encima de cualquier valor en vuelo, para que la
      // comparación de invariantes sea inequívoca sin importar el orden de
      // ejecución real entre next() y el PATCH admin.
      const anchor = before.currentNumber + 1000;
      const anchorPatch = await patchSequence(DocumentType.QUOTE, {
        currentNumber: anchor,
      });
      expect(anchorPatch.status).toBe(200);
      await trackLatestSequenceAuditRow();

      const target = anchor + 50;

      const [quoteResult, patchResult] = await Promise.all([
        createQuote({
          customerId,
          expirationDate: '2030-01-01',
          items: [{ productId, quantity: '1' }],
        }),
        patchSequence(DocumentType.QUOTE, { currentNumber: target }),
      ]);

      expect(quoteResult.status).toBe(201);
      expect(patchResult.status).toBe(200);
      if (patchResult.status === 200) {
        await trackLatestSequenceAuditRow();
      }

      const prefix = before.prefix;
      const padding = before.padding;
      const quoteNumeric = Number(quoteResult.body.number.slice(prefix.length));

      const final = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (final === undefined) throw new Error('Fila QUOTE no encontrada');

      // Dos únicos órdenes válidos de ejecución posibles, ninguno pierde el
      // incremento de next() ni permite que el admin "retroceda" el valor
      // que next() ya confirmó:
      // A) next() corre primero: quote = anchor+1; admin ve anchor+1 <=
      //    target, actualiza a target (= anchor+50).
      // B) admin corre primero: fila pasa a target (= anchor+50); next()
      //    corre después e incrementa a target+1 (= anchor+51).
      const orderA =
        quoteNumeric === anchor + 1 && final.currentNumber === target;
      const orderB =
        quoteNumeric === target + 1 && final.currentNumber === target + 1;
      expect(orderA || orderB).toBe(true);

      // Invariante central: el valor final nunca es menor que ningún valor
      // ya consumido (ni el que generó el número de la cotización).
      expect(final.currentNumber).toBeGreaterThanOrEqual(quoteNumeric);
      expect(quoteResult.body.number).toBe(
        `${prefix}${String(quoteNumeric).padStart(padding, '0')}`,
      );
    });
  });

  describe('§46 — Concurrencia prefix-only vs next()', () => {
    it('PATCH de solo prefix concurrente con generación real: el incremento de next() nunca se pierde', async () => {
      const before = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (before === undefined) throw new Error('Fila QUOTE no encontrada');

      const newPrefix = 'QRACE-';
      const [quoteResult, patchResult] = await Promise.all([
        createQuote({
          customerId,
          expirationDate: '2030-01-01',
          items: [{ productId, quantity: '1' }],
        }),
        patchSequence(DocumentType.QUOTE, { prefix: newPrefix }),
      ]);

      expect(quoteResult.status).toBe(201);
      expect(patchResult.status).toBe(200);
      await trackLatestSequenceAuditRow();

      const final = (await getSequences(adminCookie)).body.find(
        (row) => row.documentType === DocumentType.QUOTE,
      );
      if (final === undefined) throw new Error('Fila QUOTE no encontrada');

      // El PATCH de solo prefix nunca incluye currentNumber en su UPDATE:
      // el incremento de next() sobrevive siempre, sin importar el orden.
      expect(final.currentNumber).toBe(before.currentNumber + 1);
      expect(final.prefix).toBe(newPrefix);

      // El número generado usa exactamente uno de los dos prefixes válidos
      // (el vigente en el instante en que next() ejecutó su propio UPDATE
      // ... RETURNING), con el número correlativo correcto en cualquier caso.
      const expectedNumeric = before.currentNumber + 1;
      const possibleNumbers = [
        `${before.prefix}${String(expectedNumeric).padStart(before.padding, '0')}`,
        `${newPrefix}${String(expectedNumeric).padStart(before.padding, '0')}`,
      ];
      expect(possibleNumbers).toContain(quoteResult.body.number);
    });
  });
});
