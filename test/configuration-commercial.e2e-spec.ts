import { INestApplication } from '@nestjs/common';
import {
  AccountingSourceType,
  CategoryStatus,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { fromPrismaDate } from '../src/common/date/business-date';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Suite dedicada de integración cruzada Configuration <-> Quotes/Sales
 * (Fase 10, Bloque B). Se separa de configuration.e2e-spec.ts (que cubre
 * exclusivamente el contrato de GET/PATCH /configuration en aislamiento)
 * porque este archivo ejercita un flujo de negocio real de 3 módulos
 * (Configuration + Quotes + Sales) — mezclarlo en la suite de fundamento
 * hubiera diluido ambas responsabilidades. Mismo criterio de aislamiento
 * que el resto del dominio: pos_db_test únicamente, snapshot/restauración
 * exacta de CompanySettings, limpieza por ID propio, nunca deleteMany({}).
 */

interface SafeConfigurationBody {
  id: string;
  businessName: string;
  tradeName: string | null;
  taxId: string | null;
  address: string | null;
  phone: string | null;
  email: string | null;
  currencyCode: string;
  currencySymbol: string;
  taxEnabled: boolean;
  taxRate: string;
  quoteValidityDays: number;
  maxDiscountPercent: string;
  createdAt: string;
  updatedAt: string;
}

interface SafeQuoteBody {
  id: string;
  number: string;
  issueDate: string;
  expirationDate: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
}

interface SafeSaleBody {
  id: string;
  number: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
}

describe('Configuration — Commercial Integration (Bloque 10, B) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let customerId: string;

  let baseline: SafeConfigurationBody;
  let configurationAuditBaselineCount: number;

  const createdProductIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdQuoteIds: string[] = [];
  const createdSaleIds: string[] = [];
  /** AuditLog.id propios (nunca entityId: la fila singleton es compartida con historia real). */
  const ownedConfigurationAuditLogIds: string[] = [];

  async function patchConfiguration(
    body: Record<string, unknown>,
  ): Promise<{ status: number; body: SafeConfigurationBody }> {
    const response = await request(app.getHttpServer())
      .patch('/api/v1/configuration')
      .set('Cookie', adminCookie)
      .send(body);
    return {
      status: response.status,
      body: response.body as SafeConfigurationBody,
    };
  }

  async function trackLatestConfigurationAuditRow(): Promise<{
    id: string;
    metadata: unknown;
  }> {
    const row = await prisma.auditLog.findFirst({
      where: { action: AuditAction.CONFIGURATION_UPDATED },
      orderBy: { createdAt: 'desc' },
    });
    if (row === null) {
      throw new Error(
        'Se esperaba una fila CONFIGURATION_UPDATED recién creada',
      );
    }
    ownedConfigurationAuditLogIds.push(row.id);
    return row;
  }

  async function createQuote(body: {
    customerId: string;
    expirationDate?: string;
    discountAmount?: string;
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
    discountAmount?: string;
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

    // Secuencias QUOTE/SALE: upsert defensivo (identidad por documentType,
    // NUNCA se reinicia current_number si ya existe) — mismo criterio que
    // quotes.e2e-spec.ts/sales.e2e-spec.ts. Esta suite nunca borra las
    // filas de secuencia: no depende de números exactos, así que no hay
    // riesgo de interferir con otros archivos que sí los reinician.
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
      where: { code: 'E2ECFGCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2ECFGCAT', name: 'Categoria E2E Config Comercial' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2ECFGUND' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2ECFGUND',
        name: 'Unidad E2E Config Comercial',
        abbreviation: 'ecu',
        allowDecimal: false,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: 'E2ECFG-P1',
        name: 'Producto E2E Config Comercial',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('100.00'),
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
        name: 'Cliente E2E Config Comercial',
      },
    });
    customerId = customer.id;
    createdCustomerIds.push(customerId);

    configurationAuditBaselineCount = await prisma.auditLog.count({
      where: { action: AuditAction.CONFIGURATION_UPDATED },
    });

    const baselineResponse = await request(app.getHttpServer())
      .get('/api/v1/configuration')
      .set('Cookie', adminCookie);
    if (baselineResponse.status !== 200) {
      throw new Error(
        `No se pudo leer la configuración base: ${JSON.stringify(baselineResponse.body)}`,
      );
    }
    baseline = baselineResponse.body as SafeConfigurationBody;
  });

  afterAll(async () => {
    try {
      // Restaura exactamente quoteValidityDays/maxDiscountPercent (los
      // únicos campos que esta suite modifica) a su valor original.
      const restoreResponse = await patchConfiguration({
        quoteValidityDays: baseline.quoteValidityDays,
        maxDiscountPercent: baseline.maxDiscountPercent,
      });
      if (restoreResponse.status === 200) {
        await trackLatestConfigurationAuditRow();
      }

      if (ownedConfigurationAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedConfigurationAuditLogIds } },
        });
      }

      const allSaleIds = [...createdSaleIds];
      if (allSaleIds.length > 0) {
        // AccountingEntry: se identifican por (sourceType=SALE, sourceId in
        // allSaleIds) — sin FK real (polimórfico, ver comentario del
        // schema). Se capturan los IDs propios ANTES de borrar, para poder
        // limpiar exactamente sus filas de auditoría (entityType
        // 'AccountingEntry'). accounting_entry_lines se elimina en cascada
        // (onDelete: Cascade) al borrar su AccountingEntry — sin DELETE manual.
        const ownedEntries = await prisma.accountingEntry.findMany({
          where: {
            sourceType: AccountingSourceType.SALE,
            sourceId: { in: allSaleIds },
          },
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
          where: {
            sourceType: AccountingSourceType.SALE,
            sourceId: { in: allSaleIds },
          },
        });

        // InventoryMovement: mismo criterio — capturar IDs propios antes de
        // borrar, para limpiar su auditoría exacta (entityType
        // 'InventoryMovement'), nunca un deleteMany sin filtrar por ID.
        const ownedMovements = await prisma.inventoryMovement.findMany({
          where: { referenceType: 'Sale', referenceId: { in: allSaleIds } },
          select: { id: true },
        });
        const ownedMovementIds = ownedMovements.map((movement) => movement.id);
        if (ownedMovementIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: {
              entityType: 'InventoryMovement',
              entityId: { in: ownedMovementIds },
            },
          });
        }
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: allSaleIds } },
        });

        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: allSaleIds } },
        });
        // sale_items se elimina en cascada (onDelete: Cascade).
        await prisma.sale.deleteMany({ where: { id: { in: allSaleIds } } });
      }

      const allQuoteIds = [...createdQuoteIds];
      if (allQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: allQuoteIds } },
        });
        // quote_items se elimina en cascada (onDelete: Cascade). Las ventas
        // que referenciaban estas cotizaciones (quoteId, onDelete:
        // Restrict) ya se eliminaron arriba, así que este DELETE no falla
        // por la restricción de clave foránea.
        await prisma.quote.deleteMany({ where: { id: { in: allQuoteIds } } });
      }

      // Mismo criterio defensivo que quotes.e2e-spec.ts/sales.e2e-spec.ts:
      // esta suite consume las secuencias QUOTE/SALE compartidas (varios
      // números reales emitidos), y otros archivos (p. ej.
      // sales.e2e-spec.ts) asumen currentNumber = 0 al iniciar su propio
      // beforeAll. Se elimina la fila por completo (nunca se resetea
      // currentNumber con un UPDATE, que sería reescribir un correlativo ya
      // emitido): el próximo archivo que la necesite la vuelve a crear
      // fresca en su propio upsert defensivo.
      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.QUOTE },
      });
      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.SALE },
      });

      if (createdProductIds.length > 0) {
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

      // Verificaciones finales, DESPUÉS de que toda la limpieza física ya se
      // ejecutó: un throw aquí nunca deja fixtures propios sin borrar (a
      // diferencia de verificar esto antes de la limpieza, que saltaría el
      // resto del bloque try en cuanto lanzara — defecto real detectado y
      // corregido durante la validación del Bloque C).
      const finalConfigurationAuditCount = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      if (finalConfigurationAuditCount !== configurationAuditBaselineCount) {
        throw new Error(
          `Residuo de auditoría CONFIGURATION_UPDATED no controlado: esperado ${configurationAuditBaselineCount}, encontrado ${finalConfigurationAuditCount}`,
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

  describe('§36 — Vigencia por defecto de cotización', () => {
    it('expirationDate omitido usa issueDate + quoteValidityDays configurado; explícito gana; config posterior no muta lo ya creado', async () => {
      const configured = await patchConfiguration({ quoteValidityDays: 10 });
      expect(configured.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const withDefault = await createQuote({
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(withDefault.status).toBe(201);
      const expectedDefault = fromPrismaDate(
        new Date(
          new Date(withDefault.body.issueDate).getTime() +
            10 * 24 * 60 * 60 * 1000,
        ),
      );
      expect(withDefault.body.expirationDate).toBe(expectedDefault);

      const explicitExpiration = '2030-01-01';
      const withExplicit = await createQuote({
        customerId,
        expirationDate: explicitExpiration,
        items: [{ productId, quantity: '1' }],
      });
      expect(withExplicit.status).toBe(201);
      expect(withExplicit.body.expirationDate).toBe(explicitExpiration);

      // Cambiar la configuración DESPUÉS no debe mutar la primera cotización.
      const reconfigured = await patchConfiguration({ quoteValidityDays: 45 });
      expect(reconfigured.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const stillUnchanged = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${withDefault.body.id}`)
        .set('Cookie', adminCookie);
      expect((stillUnchanged.body as SafeQuoteBody).expirationDate).toBe(
        expectedDefault,
      );

      const withNewDefault = await createQuote({
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(withNewDefault.status).toBe(201);
      const expectedNewDefault = fromPrismaDate(
        new Date(
          new Date(withNewDefault.body.issueDate).getTime() +
            45 * 24 * 60 * 60 * 1000,
        ),
      );
      expect(withNewDefault.body.expirationDate).toBe(expectedNewDefault);
    });
  });

  describe('§37 — Descuento máximo en cotización', () => {
    it('en el límite exacto permite, por encima rechaza; al 100% permite descuento total', async () => {
      const toTen = await patchConfiguration({ maxDiscountPercent: '10.00' });
      expect(toTen.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const atLimit = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '10.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(atLimit.status).toBe(201);

      const aboveLimit = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '10.01',
        items: [{ productId, quantity: '1' }],
      });
      expect(aboveLimit.status).toBe(400);

      const toFull = await patchConfiguration({ maxDiscountPercent: '100.00' });
      expect(toFull.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const fullDiscount = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '100.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(fullDiscount.status).toBe(201);
      expect(fullDiscount.body.total).toBe('0.00');
    });
  });

  describe('§38 — Actualización de cotización: compatibilidad histórica vs. revalidación comercial', () => {
    it('edición NO comercial nunca revalida retroactivamente; edición comercial usa el límite VIGENTE', async () => {
      const toFull = await patchConfiguration({ maxDiscountPercent: '100.00' });
      expect(toFull.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const highDiscountQuote = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '50.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(highDiscountQuote.status).toBe(201);

      const toTen = await patchConfiguration({ maxDiscountPercent: '10.00' });
      expect(toTen.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      // Edición puramente no comercial: notes. Debe tener éxito aunque el
      // descuento histórico (50%) ya exceda el límite recién endurecido (10%).
      const nonCommercial = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${highDiscountQuote.body.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'Actualización no comercial' });
      expect(nonCommercial.status).toBe(200);
      expect((nonCommercial.body as SafeQuoteBody).discountAmount).toBe(
        '50.00',
      );

      // Edición comercial (cambia discountAmount): ahora sí se evalúa contra
      // el límite vigente (10%). Subtotal = 100.00, así que el máximo
      // permitido es 10.00.
      const commercialAboveLimit = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${highDiscountQuote.body.id}`)
        .set('Cookie', adminCookie)
        .send({ discountAmount: '20.00' });
      expect(commercialAboveLimit.status).toBe(400);

      const commercialWithinLimit = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${highDiscountQuote.body.id}`)
        .set('Cookie', adminCookie)
        .send({ discountAmount: '10.00' });
      expect(commercialWithinLimit.status).toBe(200);
      expect((commercialWithinLimit.body as SafeQuoteBody).discountAmount).toBe(
        '10.00',
      );
    });
  });

  describe('§39 — Descuento máximo en venta DIRECTA', () => {
    it('en el límite permite, por encima rechaza (sin usar conversión de cotización)', async () => {
      const toTen = await patchConfiguration({ maxDiscountPercent: '10.00' });
      expect(toTen.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const atLimit = await createDirectSale({
        customerId,
        discountAmount: '10.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(atLimit.status).toBe(201);

      const aboveLimit = await createDirectSale({
        customerId,
        discountAmount: '10.01',
        items: [{ productId, quantity: '1' }],
      });
      expect(aboveLimit.status).toBe(400);
    });
  });

  describe('§40 — Conversión Cotización -> Venta: snapshot sin revalidación (invariante histórico)', () => {
    it('cotización creada con 50% de descuento bajo max=100% convierte con éxito aunque el max VIGENTE sea 10%', async () => {
      const toFull = await patchConfiguration({ maxDiscountPercent: '100.00' });
      expect(toFull.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const quote = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '50.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(quote.status).toBe(201);
      expect(quote.body.subtotal).toBe('100.00');
      expect(quote.body.discountAmount).toBe('50.00');
      expect(quote.body.total).toBe('50.00');

      const toTen = await patchConfiguration({ maxDiscountPercent: '10.00' });
      expect(toTen.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const conversion = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.body.id}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(conversion.status).toBe(201);
      const sale = conversion.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      expect(sale.subtotal).toBe(quote.body.subtotal);
      expect(sale.discountAmount).toBe(quote.body.discountAmount);
      expect(sale.taxAmount).toBe(quote.body.taxAmount);
      expect(sale.total).toBe(quote.body.total);
    });
  });

  describe('§41 — Auditoría de configuración (Bloque B)', () => {
    it('PATCH real produce CONFIGURATION_UPDATED con changedFields/oldValues/newValues exactos; no-op y GET no auditan', async () => {
      const current = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      const currentBody = current.body as SafeConfigurationBody;

      const response = await patchConfiguration({
        quoteValidityDays: 20,
        maxDiscountPercent: '77.00',
      });
      expect(response.status).toBe(200);
      const auditRow = await trackLatestConfigurationAuditRow();
      const metadata = auditRow.metadata as {
        changedFields: string[];
        oldValues: Record<string, unknown>;
        newValues: Record<string, unknown>;
      };
      expect(metadata.changedFields.sort()).toEqual(
        ['quoteValidityDays', 'maxDiscountPercent'].sort(),
      );
      expect(metadata.oldValues).toEqual({
        quoteValidityDays: currentBody.quoteValidityDays,
        maxDiscountPercent: currentBody.maxDiscountPercent,
      });
      expect(metadata.newValues).toEqual({
        quoteValidityDays: 20,
        maxDiscountPercent: '77.00',
      });

      const beforeNoOp = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      const noOp = await patchConfiguration({
        quoteValidityDays: 20,
        maxDiscountPercent: '77.00',
      });
      expect(noOp.status).toBe(200);
      const afterNoOp = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      expect(afterNoOp).toBe(beforeNoOp);

      const beforeGet = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      const afterGet = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      expect(afterGet).toBe(beforeGet);
    });
  });

  describe('§42 — regresión: sin tocar configuración de IGV, Quote/Sale nuevas mantienen taxAmount 0.00', () => {
    // taxEnabled/taxRate se desbloquearon en el Bloque C (Fase 10): la
    // cobertura de "PATCH los rechaza" ya no aplica aquí (esa aserción
    // ahora sería falsa y, peor, mutaría config real y corrompería el
    // resto de la corrida — exactamente el defecto detectado y corregido
    // durante la validación del Bloque C). Esa cobertura positiva vive en
    // test/configuration-tax.e2e-spec.ts. Esta suite (Bloque B) solo
    // verifica que, en su propio alcance (sin tocar taxEnabled/taxRate),
    // el comportamiento por defecto (impuesto deshabilitado) se preserva.
    it('Quote/Sale nuevas mantienen taxAmount 0.00 cuando esta suite nunca toca taxEnabled/taxRate', async () => {
      const current = await request(app.getHttpServer())
        .get('/api/v1/configuration')
        .set('Cookie', adminCookie);
      expect((current.body as SafeConfigurationBody).taxEnabled).toBe(false);

      const quote = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(quote.status).toBe(201);
      expect(quote.body.taxAmount).toBe('0.00');

      const sale = await createDirectSale({
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      expect(sale.body.taxAmount).toBe('0.00');
    });
  });
});
