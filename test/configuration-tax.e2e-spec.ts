import { INestApplication } from '@nestjs/common';
import {
  AccountingSourceType,
  AccountingSystemKey,
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
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Suite dedicada de integración IGV (Fase 10, Bloque C): Configuration <->
 * Quotes/Sales/Accounting. Separada de configuration-commercial.e2e-spec.ts
 * (Bloque B: vigencia/descuento) porque la integración de impuesto +
 * contabilidad es un riesgo materialmente mayor (afecta el cuadre de
 * asientos reales). Mismo criterio de aislamiento que el resto del
 * dominio: pos_db_test únicamente, snapshot/restauración exacta de
 * CompanySettings, limpieza por ID propio, nunca deleteMany({}).
 */

interface SafeConfigurationBody {
  id: string;
  businessName: string;
  currencyCode: string;
  taxEnabled: boolean;
  taxRate: string;
  quoteValidityDays: number;
  maxDiscountPercent: string;
}

interface SafeQuoteBody {
  id: string;
  number: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  currencyCode: string;
  taxEnabled: boolean;
  taxRate: string;
  pricesIncludeTax: boolean;
  itemsTotal: string;
  customerDiscountAmount: string;
  taxableBase: string;
}

interface SafeSaleBody {
  id: string;
  number: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  currencyCode: string;
  taxEnabled: boolean;
  taxRate: string;
}

describe('Configuration — Tax/IGV Integration (Bloque 10, C) (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let customerId: string;
  let vatAccountId: string;

  let baseline: SafeConfigurationBody;
  let configurationAuditBaselineCount: number;

  const createdProductIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdQuoteIds: string[] = [];
  const createdSaleIds: string[] = [];
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

  let historicalQuoteCounter = 0;

  /**
   * R2-B3: cotización HISTÓRICA (pricesIncludeTax=false), insertada tal cual
   * la habría persistido el código previo a R2: 1 × 100.00 antes de
   * impuesto, descuento 10.00, IGV 18% sumado sobre 90.00 -> 16.20, total
   * 106.20. Cumple las CHECK de cabecera y de línea.
   */
  async function createHistoricalQuote(): Promise<string> {
    historicalQuoteCounter += 1;
    const admin = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
      select: { id: true },
    });
    const row = await prisma.quote.create({
      data: {
        number: `COT-HIST-${Date.now()}-${historicalQuoteCounter}`,
        customerId,
        customerType: CustomerType.PERSON,
        customerName: 'Cliente E2E Config IGV',
        sellerId: admin.id,
        issueDate: new Date('2026-01-01T00:00:00.000Z'),
        expirationDate: new Date('2030-01-01T00:00:00.000Z'),
        subtotal: new Prisma.Decimal('100.00'),
        discountAmount: new Prisma.Decimal('10.00'),
        taxAmount: new Prisma.Decimal('16.20'),
        total: new Prisma.Decimal('106.20'),
        currencyCode: 'PEN',
        taxEnabled: true,
        taxRate: new Prisma.Decimal('18.00'),
        pricesIncludeTax: false,
        items: {
          create: [
            {
              productId,
              productSku: 'E2ECFGTAX-P1',
              productName: 'Producto E2E Config IGV',
              unitCode: 'E2ECFGTAXU',
              unitName: 'Unidad E2E Config IGV',
              unitAbbreviation: 'ecti',
              quantity: new Prisma.Decimal('1'),
              unitPrice: new Prisma.Decimal('100.00'),
              lineTotal: new Prisma.Decimal('100.00'),
            },
          ],
        },
      },
    });
    createdQuoteIds.push(row.id);
    return row.id;
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

    // Secuencias QUOTE/SALE: upsert defensivo (nunca reinicia
    // current_number si ya existe) — mismo criterio que
    // configuration-commercial.e2e-spec.ts/quotes.e2e-spec.ts/
    // sales.e2e-spec.ts. Se eliminan por completo en el afterAll (nunca se
    // asume currentNumber == 0 al empezar).
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
      where: { code: 'E2ECFGTAXCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2ECFGTAXCAT', name: 'Categoria E2E Config IGV' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2ECFGTAXU' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2ECFGTAXU',
        name: 'Unidad E2E Config IGV',
        abbreviation: 'ecti',
        allowDecimal: false,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: 'E2ECFGTAX-P1',
        name: 'Producto E2E Config IGV',
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
        name: 'Cliente E2E Config IGV',
      },
    });
    customerId = customer.id;
    createdCustomerIds.push(customerId);

    const vatAccount = await prisma.account.findUniqueOrThrow({
      where: { systemKey: AccountingSystemKey.VAT_PAYABLE },
      select: { id: true },
    });
    vatAccountId = vatAccount.id;

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
      const restoreResponse = await patchConfiguration({
        currencyCode: baseline.currencyCode,
        taxEnabled: baseline.taxEnabled,
        taxRate: baseline.taxRate,
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
        await prisma.product.deleteMany({
          where: { id: { in: createdProductIds } },
        });
      }

      // Guarda explícita: un `id: undefined` (si beforeAll lanzó antes de
      // asignar) haría que Prisma omita la condición y deleteMany({})
      // borrara toda la tabla — mismo criterio que createdProductIds arriba.
      if (unitId) {
        await prisma.unit.deleteMany({ where: { id: unitId } });
      }
      if (categoryId) {
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }

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

      // Mismo criterio defensivo que configuration-commercial.e2e-spec.ts:
      // esta suite consume las secuencias compartidas, así que se eliminan
      // por completo (nunca se resetea currentNumber con UPDATE) para que
      // el próximo archivo las recree frescas en su propio upsert.
      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.QUOTE },
      });
      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.SALE },
      });

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

  describe('§39 — Configuración de IGV vía PATCH', () => {
    it('activa IGV con tasa existente, cambia la tasa, rechaza tasa 0 activo, permite desactivar+cero, audita exacto, no-op sin auditoría', async () => {
      const enableWithExistingRate = await patchConfiguration({
        taxEnabled: true,
      });
      expect(enableWithExistingRate.status).toBe(200);
      const auditEnable = await trackLatestConfigurationAuditRow();
      const enableMetadata = auditEnable.metadata as {
        changedFields: string[];
        oldValues: Record<string, unknown>;
        newValues: Record<string, unknown>;
      };
      expect(enableMetadata.changedFields).toEqual(['taxEnabled']);
      expect(enableMetadata.oldValues).toEqual({ taxEnabled: false });
      expect(enableMetadata.newValues).toEqual({ taxEnabled: true });

      const changeRate = await patchConfiguration({ taxRate: '18.00' });
      expect(changeRate.status).toBe(200);

      const beforeReject = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      const rejectZeroWhileEnabled = await patchConfiguration({
        taxRate: '0.00',
      });
      expect(rejectZeroWhileEnabled.status).toBe(400);
      const afterReject = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      expect(afterReject).toBe(beforeReject);

      const disableAndZero = await patchConfiguration({
        taxEnabled: false,
        taxRate: '0.00',
      });
      expect(disableAndZero.status).toBe(200);
      await trackLatestConfigurationAuditRow();
      expect(disableAndZero.body.taxEnabled).toBe(false);
      expect(disableAndZero.body.taxRate).toBe('0.00');

      const reEnable = await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
      });
      expect(reEnable.status).toBe(200);
      await trackLatestConfigurationAuditRow();

      const beforeNoOp = await prisma.auditLog.count({
        where: { action: AuditAction.CONFIGURATION_UPDATED },
      });
      const noOp = await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
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

  describe('§40/§41 — Cálculo de IGV en cotización, incluida descuento total', () => {
    it('R2-B3: precio final 100.00 con descuento al cliente 10.00 al 18% -> total 90.00, base 76.27, IGV 13.73 (desglosado, nunca sumado); persiste y responde exacto', async () => {
      await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '10.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      // total = 100.00 - 10.00 = 90.00; base = ROUND(90.00/1.18) = 76.27;
      // IGV = 13.73; descuento persistido = ROUND(10.00/1.18) = 8.47;
      // subtotal = 76.27 + 8.47 = 84.74.
      expect(created.body).toMatchObject({
        pricesIncludeTax: true,
        itemsTotal: '100.00',
        customerDiscountAmount: '10.00',
        taxableBase: '76.27',
        subtotal: '84.74',
        discountAmount: '8.47',
        taxAmount: '13.73',
        total: '90.00',
      });

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie);
      expect(fetched.body).toMatchObject({
        subtotal: '84.74',
        discountAmount: '8.47',
        taxAmount: '13.73',
        total: '90.00',
      });

      // Invariantes que exigen las CHECK, sobre la fila persistida real.
      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: created.body.id },
      });
      expect(
        row.total.equals(
          row.subtotal.minus(row.discountAmount).plus(row.taxAmount),
        ),
      ).toBe(true);
      expect(row.pricesIncludeTax).toBe(true);
    });

    it('R2-B3: 118.00 al 18% -> base 100.00, IGV 18.00, total 118.00 (el cliente nunca paga 139.24)', async () => {
      await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();
      const product118 = await prisma.product.create({
        data: {
          sku: `E2ECFGTAX-P118-${Date.now()}`,
          name: 'Producto 118 E2E Config IGV',
          productType: ProductType.PRODUCT,
          categoryId,
          unitId,
          salePrice: new Prisma.Decimal('118.00'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('10.000'),
          status: ProductStatus.ACTIVE,
        },
      });
      createdProductIds.push(product118.id);

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId: product118.id, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        subtotal: '100.00',
        discountAmount: '0.00',
        taxAmount: '18.00',
        total: '118.00',
      });
    });

    it('R2-B3: IGV desactivado: el precio final es el total y el IGV es 0.00', async () => {
      await patchConfiguration({ taxEnabled: false });
      await trackLatestConfigurationAuditRow();

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      expect(created.body).toMatchObject({
        pricesIncludeTax: true,
        subtotal: '100.00',
        taxAmount: '0.00',
        total: '100.00',
      });
    });

    it('R2-B3: descuento máximo configurado (10%) sobre el precio final: 10.00 sobre 100.00 válido, 10.01 inválido', async () => {
      await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '10.00',
      });
      await trackLatestConfigurationAuditRow();

      const valid = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '10.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(valid.status).toBe(201);

      const invalid = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '10.01',
        items: [{ productId, quantity: '1' }],
      });
      expect(invalid.status).toBe(400);
    });

    it('cotización HISTÓRICA: GET conserva sus montos y su semántica (descuento al cliente = discountAmount)', async () => {
      const historicalId = await createHistoricalQuote();
      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${historicalId}`)
        .set('Cookie', adminCookie);
      expect(fetched.status).toBe(200);
      expect(fetched.body).toMatchObject({
        pricesIncludeTax: false,
        subtotal: '100.00',
        discountAmount: '10.00',
        taxAmount: '16.20',
        total: '106.20',
        itemsTotal: '100.00',
        customerDiscountAmount: '10.00',
        taxableBase: '90.00',
      });
    });

    it('descuento total (100%): taxAmount 0.00, total 0.00', async () => {
      await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '100.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      expect(created.body.taxAmount).toBe('0.00');
      expect(created.body.total).toBe('0.00');
    });
  });

  describe('§42 — Compatibilidad histórica del IGV en cotizaciones', () => {
    it('R2-B3 nueva: creada al 18% conserva su monto tras bajar la config a 10%; edición no comercial preserva, edición comercial recalcula al 10%', async () => {
      await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      // 100.00 final al 18%: base 84.75, IGV 15.25.
      expect(created.body.taxAmount).toBe('15.25');
      expect(created.body.total).toBe('100.00');

      await patchConfiguration({ taxRate: '10.00' });
      await trackLatestConfigurationAuditRow();

      const stillUnchanged = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie);
      expect((stillUnchanged.body as SafeQuoteBody).taxAmount).toBe('15.25');
      expect((stillUnchanged.body as SafeQuoteBody).total).toBe('100.00');

      const nonCommercial = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'Actualización no comercial' });
      expect(nonCommercial.status).toBe(200);
      expect(nonCommercial.body).toMatchObject({
        subtotal: '84.75',
        discountAmount: '0.00',
        taxAmount: '15.25',
        total: '100.00',
      });

      const commercial = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie)
        .send({ discountAmount: '1.00' });
      expect(commercial.status).toBe(200);
      // total = 100.00 - 1.00 = 99.00; base al 10% vigente = 90.00; IGV 9.00;
      // descuento persistido = ROUND(1.00/1.10) = 0.91; subtotal 90.91.
      expect(commercial.body).toMatchObject({
        itemsTotal: '100.00',
        customerDiscountAmount: '1.00',
        taxableBase: '90.00',
        subtotal: '90.91',
        discountAmount: '0.91',
        taxAmount: '9.00',
        total: '99.00',
        taxRate: '10.00',
      });
    });

    it('R2-B3 histórica: edición no comercial preserva EXACTO sus montos e indicador; edición comercial -> 409 sin cambios', async () => {
      const historicalId = await createHistoricalQuote();
      const before = await prisma.quote.findUniqueOrThrow({
        where: { id: historicalId },
        include: { items: true },
      });

      const nonCommercial = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${historicalId}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'Nota histórica', expirationDate: '2030-06-01' });
      expect(nonCommercial.status).toBe(200);

      for (const change of [
        { discountAmount: '5.00' },
        { items: [{ productId, quantity: '2' }] },
      ]) {
        const commercial = await request(app.getHttpServer())
          .patch(`/api/v1/quotes/${historicalId}`)
          .set('Cookie', adminCookie)
          .send(change);
        expect(commercial.status).toBe(409);
        expect(JSON.stringify(commercial.body)).toContain(
          'modelo de precios anterior',
        );
      }

      const after = await prisma.quote.findUniqueOrThrow({
        where: { id: historicalId },
        include: { items: true },
      });
      expect(after.pricesIncludeTax).toBe(false);
      expect(after.subtotal.equals(before.subtotal)).toBe(true);
      expect(after.discountAmount.equals(before.discountAmount)).toBe(true);
      expect(after.taxAmount.equals(before.taxAmount)).toBe(true);
      expect(after.total.equals(before.total)).toBe(true);
      expect(after.taxRate.equals(before.taxRate)).toBe(true);
      expect(after.items.map((item) => item.lineTotal.toFixed(2))).toEqual(
        before.items.map((item) => item.lineTotal.toFixed(2)),
      );
      expect(after.notes).toBe('Nota histórica');
    });

    it('R2-B3 histórica: aceptar y rechazar siguen funcionando', async () => {
      const toAccept = await createHistoricalQuote();
      const accepted = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${toAccept}/accept`)
        .set('Cookie', adminCookie);
      expect(accepted.status).toBe(200);
      expect((accepted.body as { status: string }).status).toBe('ACCEPTED');

      const toReject = await createHistoricalQuote();
      const rejected = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${toReject}/reject`)
        .set('Cookie', adminCookie);
      expect(rejected.status).toBe(200);
      expect((rejected.body as { status: string }).status).toBe('REJECTED');
    });
  });

  describe('§43 — IGV en venta DIRECTA + verificación de asiento contable', () => {
    it('venta directa al 18%: monto persistido exacto y VAT_PAYABLE == taxAmount, asiento balanceado', async () => {
      await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();

      const sale = await createDirectSale({
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      expect(sale.body.subtotal).toBe('100.00');
      expect(sale.body.taxAmount).toBe('18.00');
      expect(sale.body.total).toBe('118.00');

      const entry = await prisma.accountingEntry.findFirst({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.body.id,
        },
        include: { lines: true },
      });
      expect(entry).not.toBeNull();
      if (entry === null) return;

      const vatLine = entry.lines.find(
        (line) => line.accountId === vatAccountId,
      );
      expect(vatLine).toBeDefined();
      expect(vatLine?.creditAmount.toFixed(2)).toBe('18.00');
      expect(vatLine?.debitAmount.toFixed(2)).toBe('0.00');

      const totalDebit = entry.lines.reduce(
        (sum, line) => sum.plus(line.debitAmount),
        new Prisma.Decimal(0),
      );
      const totalCredit = entry.lines.reduce(
        (sum, line) => sum.plus(line.creditAmount),
        new Prisma.Decimal(0),
      );
      expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));
      expect(totalDebit.toFixed(2)).toBe('118.00');
    });
  });

  describe('§44 — Regresión de IGV desactivado', () => {
    it('IGV desactivado: taxAmount 0.00, sin línea VAT_PAYABLE en el asiento', async () => {
      await patchConfiguration({ taxEnabled: false });
      await trackLatestConfigurationAuditRow();

      const sale = await createDirectSale({
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      expect(sale.body.taxAmount).toBe('0.00');
      expect(sale.body.total).toBe('100.00');

      const entry = await prisma.accountingEntry.findFirst({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.body.id,
        },
        include: { lines: true },
      });
      expect(entry).not.toBeNull();
      if (entry === null) return;
      const vatLine = entry.lines.find(
        (line) => line.accountId === vatAccountId,
      );
      expect(vatLine).toBeUndefined();
    });
  });

  describe('§45 — Snapshot de IGV en la conversión Cotización -> Venta', () => {
    it('cotización creada al 18% convierte con éxito tras bajar la config a 10%, Sale copia EXACTO el monto del 18%', async () => {
      await patchConfiguration({
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();

      const quote = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        discountAmount: '10.00',
        items: [{ productId, quantity: '1' }],
      });
      expect(quote.status).toBe(201);
      expect(quote.body).toMatchObject({
        subtotal: '84.74',
        discountAmount: '8.47',
        taxAmount: '13.73',
        total: '90.00',
      });

      await patchConfiguration({ taxRate: '10.00' });
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
      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.pricesIncludeTax).toBe(true);

      const entry = await prisma.accountingEntry.findFirst({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.id,
        },
        include: { lines: true },
      });
      expect(entry).not.toBeNull();
      if (entry === null) return;
      const vatLine = entry.lines.find(
        (line) => line.accountId === vatAccountId,
      );
      expect(vatLine?.creditAmount.toFixed(2)).toBe('13.73');
      const totalDebit = entry.lines.reduce(
        (sum, line) => sum.plus(line.debitAmount),
        new Prisma.Decimal(0),
      );
      const totalCredit = entry.lines.reduce(
        (sum, line) => sum.plus(line.creditAmount),
        new Prisma.Decimal(0),
      );
      expect(totalDebit.equals(totalCredit)).toBe(true);
    });

    it('R2-B3 histórica: la conversión copia VERBATIM montos (16.20 al 18%) e indicador false, aunque la config sea otra', async () => {
      await patchConfiguration({ taxEnabled: true, taxRate: '10.00' });
      await trackLatestConfigurationAuditRow();
      const historicalId = await createHistoricalQuote();

      const conversion = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${historicalId}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(conversion.status).toBe(201);
      const sale = conversion.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      expect(sale).toMatchObject({
        subtotal: '100.00',
        discountAmount: '10.00',
        taxAmount: '16.20',
        total: '106.20',
        taxRate: '18.00',
      });
      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.pricesIncludeTax).toBe(false);
    });
  });

  describe('§46 — Snapshot de contexto fiscal (Fase 11, Bloque B): currencyCode/taxEnabled/taxRate', () => {
    it('cotización creada bajo USD+IGV 18% activo persiste ese contexto exacto', async () => {
      await patchConfiguration({
        currencyCode: 'USD',
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();

      const quote = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(quote.status).toBe(201);
      expect(quote.body.currencyCode).toBe('USD');
      expect(quote.body.taxEnabled).toBe(true);
      expect(quote.body.taxRate).toBe('18.00');

      await patchConfiguration({ currencyCode: 'PEN' });
      await trackLatestConfigurationAuditRow();
    });

    it('venta directa creada bajo USD+IGV 18% activo persiste ese mismo contexto (misma lectura de settings que taxAmount)', async () => {
      await patchConfiguration({
        currencyCode: 'USD',
        taxEnabled: true,
        taxRate: '18.00',
      });
      await trackLatestConfigurationAuditRow();

      const sale = await createDirectSale({
        customerId,
        items: [{ productId, quantity: '1' }],
      });
      expect(sale.status).toBe(201);
      expect(sale.body.currencyCode).toBe('USD');
      expect(sale.body.taxEnabled).toBe(true);
      expect(sale.body.taxRate).toBe('18.00');

      await patchConfiguration({ currencyCode: 'PEN' });
      await trackLatestConfigurationAuditRow();
    });

    it('conversión Cotización -> Venta copia VERBATIM currencyCode/taxEnabled/taxRate de la cotización, aunque la configuración vigente ya haya cambiado', async () => {
      await patchConfiguration({
        currencyCode: 'USD',
        taxEnabled: true,
        taxRate: '18.00',
        maxDiscountPercent: '100.00',
      });
      await trackLatestConfigurationAuditRow();

      const quote = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(quote.status).toBe(201);
      expect(quote.body.currencyCode).toBe('USD');
      expect(quote.body.taxEnabled).toBe(true);
      expect(quote.body.taxRate).toBe('18.00');

      // Configuración vigente cambia drásticamente ANTES de la conversión:
      // moneda distinta e IGV desactivado. La venta debe seguir copiando el
      // contexto congelado de la cotización, nunca releer CompanySettings.
      await patchConfiguration({ currencyCode: 'PEN', taxEnabled: false });
      await trackLatestConfigurationAuditRow();

      const conversion = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.body.id}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(conversion.status).toBe(201);
      const sale = conversion.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      expect(sale.currencyCode).toBe('USD');
      expect(sale.taxEnabled).toBe(true);
      expect(sale.taxRate).toBe('18.00');
      // Explícitamente NO el contexto vigente al momento de convertir.
      expect(sale.currencyCode).not.toBe('PEN');
      expect(sale.taxEnabled).not.toBe(false);

      await patchConfiguration({ currencyCode: 'PEN', taxEnabled: true });
      await trackLatestConfigurationAuditRow();
    });
  });
});
