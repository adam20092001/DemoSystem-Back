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
    it('subtotal 100.00, descuento 10.00 -> taxableBase 90.00, tax 16.20, total 106.20; persiste exacto', async () => {
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
      expect(created.body.subtotal).toBe('100.00');
      expect(created.body.discountAmount).toBe('10.00');
      expect(created.body.taxAmount).toBe('16.20');
      expect(created.body.total).toBe('106.20');

      const fetched = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie);
      const fetchedBody = fetched.body as SafeQuoteBody;
      expect(fetchedBody.subtotal).toBe('100.00');
      expect(fetchedBody.discountAmount).toBe('10.00');
      expect(fetchedBody.taxAmount).toBe('16.20');
      expect(fetchedBody.total).toBe('106.20');
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
    it('cotización creada al 18% conserva su monto tras bajar la config a 10%; edición no comercial preserva, edición comercial recalcula', async () => {
      await patchConfiguration({ taxEnabled: true, taxRate: '18.00' });
      await trackLatestConfigurationAuditRow();

      const created = await createQuote({
        customerId,
        expirationDate: '2030-01-01',
        items: [{ productId, quantity: '1' }],
      });
      expect(created.status).toBe(201);
      expect(created.body.taxAmount).toBe('18.00');
      expect(created.body.total).toBe('118.00');

      await patchConfiguration({ taxRate: '10.00' });
      await trackLatestConfigurationAuditRow();

      const stillUnchanged = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie);
      expect((stillUnchanged.body as SafeQuoteBody).taxAmount).toBe('18.00');
      expect((stillUnchanged.body as SafeQuoteBody).total).toBe('118.00');

      const nonCommercial = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'Actualización no comercial' });
      expect(nonCommercial.status).toBe(200);
      expect((nonCommercial.body as SafeQuoteBody).taxAmount).toBe('18.00');
      expect((nonCommercial.body as SafeQuoteBody).total).toBe('118.00');

      const commercial = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.body.id}`)
        .set('Cookie', adminCookie)
        .send({ discountAmount: '1.00' });
      expect(commercial.status).toBe(200);
      const commercialBody = commercial.body as SafeQuoteBody;
      // taxableBase = 100.00 - 1.00 = 99.00; tax al 10% vigente = 9.90;
      // total = taxableBase + tax = 99.00 + 9.90 = 108.90.
      expect(commercialBody.taxAmount).toBe('9.90');
      expect(commercialBody.total).toBe('108.90');
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
      expect(quote.body.subtotal).toBe('100.00');
      expect(quote.body.discountAmount).toBe('10.00');
      expect(quote.body.taxAmount).toBe('16.20');
      expect(quote.body.total).toBe('106.20');

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
      // Explícitamente NO el 10% vigente: 90.00*10/100 = 9.00, distinto de 16.20.
      expect(sale.taxAmount).not.toBe('9.00');

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
      expect(vatLine?.creditAmount.toFixed(2)).toBe('16.20');
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
