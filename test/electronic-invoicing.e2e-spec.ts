import {
  ConflictException,
  INestApplication,
  ServiceUnavailableException,
} from '@nestjs/common';
import { Test } from '@nestjs/testing';
import {
  AccountingSourceType,
  CategoryStatus,
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  ElectronicDocumentStatus,
  FiscalDocumentType,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AppModule } from '../src/app.module';
import { setupApp } from '../src/app.setup';
import { AuditAction } from '../src/audit/audit-action.enum';
import { ElectronicDocumentsService } from '../src/electronic-invoicing/electronic-documents.service';
import { RetryableProviderSubmissionError } from '../src/electronic-invoicing/providers/electronic-invoicing-provider-errors';
import type { ElectronicInvoicingProvider } from '../src/electronic-invoicing/providers/electronic-invoicing-provider.interface';
import { ELECTRONIC_INVOICING_PROVIDER } from '../src/electronic-invoicing/providers/electronic-invoicing-provider.token';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * Suite dedicada al motor de emisión fiscal interna (Fase 11, Bloque C).
 * Sin controller/ruta HTTP todavía (Fase 11D): se invoca
 * ElectronicDocumentsService directamente vía `app.get(...)`, dentro de un
 * proceso Nest real conectado a pos_db_test — mismo aislamiento que el
 * resto del dominio (solo pos_db_test, limpieza por ID propio, nunca
 * deleteMany({})). Las Ventas fixture SÍ se crean vía HTTP real
 * (POST /api/v1/sales) para reutilizar la lógica ya probada de
 * correlativos/snapshot/auditoría de Ventas sin duplicarla aquí.
 *
 * Usa TRES instancias de aplicación:
 *  - `app`: proveedor real (MockElectronicInvoicingProvider, vía DI normal).
 *  - `failingApp`: mismo AppModule con ELECTRONIC_INVOICING_PROVIDER
 *    sobrescrito por un doble de prueba que SIEMPRE lanza
 *    RetryableProviderSubmissionError (falla DEFINITIVA, §23: el
 *    MockProvider de producción nunca se contamina con interruptores de
 *    prueba).
 *  - `unknownOutcomeApp`: mismo AppModule con el proveedor sobrescrito por
 *    un doble que SIEMPRE lanza un Error genérico no clasificado
 *    (remediación final del Bloque 11C: prueba end-to-end de la política
 *    "fail closed" — el documento debe permanecer SUBMITTED, nunca
 *    SUBMISSION_FAILED, ante una excepción no reconocida del adaptador).
 */
describe('Electronic Invoicing — motor de emisión fiscal interna (Fase 11, Bloque C) (e2e)', () => {
  let app: INestApplication<App>;
  let failingApp: INestApplication<App>;
  let unknownOutcomeApp: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let adminId: string;
  let electronicDocumentsService: ElectronicDocumentsService;
  let failingElectronicDocumentsService: ElectronicDocumentsService;
  let unknownOutcomeElectronicDocumentsService: ElectronicDocumentsService;

  let categoryId: string;
  let unitId: string;
  let productId: string;
  let rucCustomerId: string;
  let companySettingsId: string;
  let companySettingsBaseline: {
    businessName: string;
    taxId: string | null;
    address: string | null;
  };

  const FACTURA_SERIES = 'F900';
  const BOLETA_SERIES = 'B900';

  const createdSaleIds: string[] = [];
  const createdDocumentIds: string[] = [];

  interface FixtureSale {
    id: string;
    number: string;
    total: string;
  }

  async function createFixtureSale(): Promise<FixtureSale> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', adminCookie)
      .send({
        customerId: rucCustomerId,
        items: [{ productId, quantity: '1' }],
      });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la venta fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as FixtureSale;
    createdSaleIds.push(body.id);
    return body;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    // Remediación final del Bloque 11C: solo un error EXPLÍCITAMENTE
    // clasificado como RetryableProviderSubmissionError produce
    // SUBMISSION_FAILED (reintentable). Un Error genérico se trataría como
    // resultado DESCONOCIDO (permanece SUBMITTED, sin reintento) — ver
    // cobertura unitaria dedicada en electronic-documents.service.spec.ts.
    const failingProvider: ElectronicInvoicingProvider = {
      code: 'MOCK',
      submit: () =>
        Promise.reject(
          new RetryableProviderSubmissionError(
            'ECONNREFUSED (simulado, prueba e2e Fase 11C)',
          ),
        ),
    };
    const failingModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ELECTRONIC_INVOICING_PROVIDER)
      .useValue(failingProvider)
      .compile();
    failingApp = failingModule.createNestApplication<INestApplication<App>>();
    setupApp(failingApp);
    await failingApp.init();

    // Doble que lanza un Error genérico NO clasificado: prueba end-to-end
    // de la política "fail closed" (§5/§7 de la remediación) contra
    // PostgreSQL real.
    const unknownOutcomeProvider: ElectronicInvoicingProvider = {
      code: 'MOCK',
      submit: () =>
        Promise.reject(
          new Error('raw sensitive provider failure (simulado, e2e)'),
        ),
    };
    const unknownOutcomeModule = await Test.createTestingModule({
      imports: [AppModule],
    })
      .overrideProvider(ELECTRONIC_INVOICING_PROVIDER)
      .useValue(unknownOutcomeProvider)
      .compile();
    unknownOutcomeApp =
      unknownOutcomeModule.createNestApplication<INestApplication<App>>();
    setupApp(unknownOutcomeApp);
    await unknownOutcomeApp.init();

    electronicDocumentsService = app.get(ElectronicDocumentsService);
    failingElectronicDocumentsService = failingApp.get(
      ElectronicDocumentsService,
    );
    unknownOutcomeElectronicDocumentsService = unknownOutcomeApp.get(
      ElectronicDocumentsService,
    );

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
    });
    adminId = adminUser.id;

    // Identidad del emisor (§8): el seed base no necesariamente satisface
    // "taxId exactamente 11 numéricos" (no es su responsabilidad). Se
    // captura el valor vigente y se restaura EXACTO en el afterAll, mismo
    // criterio de snapshot/restauración que configuration-tax.e2e-spec.ts.
    const companySettingsRow = await prisma.companySettings.findFirstOrThrow();
    companySettingsId = companySettingsRow.id;
    companySettingsBaseline = {
      businessName: companySettingsRow.businessName,
      taxId: companySettingsRow.taxId,
      address: companySettingsRow.address,
    };
    await prisma.companySettings.update({
      where: { id: companySettingsId },
      data: {
        businessName: 'Empresa Demo Fiscal E2E SAC',
        taxId: '20100000001',
        address: 'Av. Fiscal E2E 100',
      },
    });

    // Secuencia SALE: upsert defensivo (nunca reinicia currentNumber si ya
    // existe), mismo criterio que configuration-tax.e2e-spec.ts/
    // quotes.e2e-spec.ts/sales.e2e-spec.ts. Se elimina en el afterAll.
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
      where: { code: 'E2EEIVCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EEIVCAT', name: 'Categoria E2E Facturacion' },
    });
    categoryId = category.id;

    const unit = await prisma.unit.upsert({
      where: { code: 'E2EEIVU' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2EEIVU',
        name: 'Unidad E2E Facturacion',
        abbreviation: 'eeiv',
        allowDecimal: false,
      },
    });
    unitId = unit.id;

    const product = await prisma.product.create({
      data: {
        sku: `E2EEIV-P-${Date.now()}`,
        name: 'Producto E2E Facturacion',
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('50.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('100000.000'),
        status: ProductStatus.ACTIVE,
      },
    });
    productId = product.id;

    const rucCustomer = await prisma.customer.create({
      data: {
        customerType: CustomerType.COMPANY,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: CustomerDocumentType.RUC,
        documentNumber: '20123456789',
        name: 'Distribuidora Fiscal E2E SAC',
      },
    });
    rucCustomerId = rucCustomer.id;

    // FiscalSeries EXCLUSIVAS de esta suite (nunca F001/B001 sembradas,
    // compartidas con el resto del dominio): así las aserciones de
    // incremento parten de un currentNumber = 0 conocido, sin depender del
    // orden de ejecución de otras suites.
    await prisma.fiscalSeries.create({
      data: {
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
        currentNumber: 0,
        active: true,
      },
    });
    await prisma.fiscalSeries.create({
      data: {
        documentType: FiscalDocumentType.BOLETA,
        series: BOLETA_SERIES,
        currentNumber: 0,
        active: true,
      },
    });
  });

  afterAll(async () => {
    try {
      if (createdDocumentIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'ElectronicDocument',
            entityId: { in: createdDocumentIds },
          },
        });
        await prisma.electronicDocument.deleteMany({
          where: { id: { in: createdDocumentIds } },
        });
      }

      await prisma.fiscalSeries.deleteMany({
        where: { series: { in: [FACTURA_SERIES, BOLETA_SERIES] } },
      });

      if (createdSaleIds.length > 0) {
        // Las ventas directas ya postearon su asiento de reconocimiento
        // real (Fase 8): debe eliminarse antes que Sale.
        const ownedEntries = await prisma.accountingEntry.findMany({
          where: {
            sourceType: AccountingSourceType.SALE,
            sourceId: { in: createdSaleIds },
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
            sourceId: { in: createdSaleIds },
          },
        });

        // Las ventas directas (status ACTIVE, producto inventariable) ya
        // generaron su movimiento de salida real: debe eliminarse ANTES
        // que Sale/Product (onDelete: Restrict en ambos lados).
        const ownedMovements = await prisma.inventoryMovement.findMany({
          where: {
            referenceType: 'Sale',
            referenceId: { in: createdSaleIds },
          },
          select: { id: true },
        });
        const ownedMovementIds = ownedMovements.map((m) => m.id);
        if (ownedMovementIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: {
              entityType: 'InventoryMovement',
              entityId: { in: ownedMovementIds },
            },
          });
        }
        await prisma.inventoryMovement.deleteMany({
          where: {
            referenceType: 'Sale',
            referenceId: { in: createdSaleIds },
          },
        });

        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: createdSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: createdSaleIds } } });
      }

      // Guarda explícita: un `id`/`entityId: undefined` (si beforeAll lanzó
      // antes de asignar) haría que Prisma omita la condición —
      // deleteMany({}) borraría toda la tabla, o el auditLog perdería su
      // filtro por entityId y borraría TODOS los audits de Customer.
      if (rucCustomerId) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Customer', entityId: rucCustomerId },
        });
        await prisma.customer.deleteMany({ where: { id: rucCustomerId } });
      }
      if (productId) {
        await prisma.product.deleteMany({ where: { id: productId } });
      }
      if (unitId) {
        await prisma.unit.deleteMany({ where: { id: unitId } });
      }
      if (categoryId) {
        await prisma.category.deleteMany({ where: { id: categoryId } });
      }

      await prisma.companySettings.update({
        where: { id: companySettingsId },
        data: companySettingsBaseline,
      });

      // Mismo criterio defensivo que configuration-tax.e2e-spec.ts: esta
      // suite consume la secuencia compartida de SALE, así que se elimina
      // por completo (nunca se resetea currentNumber con UPDATE) para que
      // el próximo archivo la recree fresca en su propio upsert.
      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.SALE },
      });
    } finally {
      await app.close();
      await failingApp.close();
      await unknownOutcomeApp.close();
      await prisma.$disconnect();
    }
  });

  // ====================================================================
  // Camino feliz — prueba de integración real (issue -> ACCEPTED)
  // ====================================================================
  describe('emisión completa contra PostgreSQL real', () => {
    it('crea el documento, lo envía, y queda ACCEPTED con auditoría CREATED + ACCEPTED', async () => {
      const sale = await createFixtureSale();

      const doc = await electronicDocumentsService.issue({
        saleId: sale.id,
        documentType: FiscalDocumentType.FACTURA,
        series: FACTURA_SERIES,
        actorUserId: adminId,
        ipAddress: null,
      });
      createdDocumentIds.push(doc.id);

      expect(doc.status).toBe(ElectronicDocumentStatus.ACCEPTED);
      expect(doc.series).toBe(FACTURA_SERIES);
      expect(doc.number).toBe(1);
      expect(doc.saleId).toBe(sale.id);
      expect(doc.total).toBe(sale.total);
      expect(doc.items).toHaveLength(1);
      expect(doc.items[0].lineNumber).toBe(1);

      const createdAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.ELECTRONIC_DOCUMENT_CREATED,
          entityId: doc.id,
        },
      });
      expect(createdAudit).not.toBeNull();

      const acceptedAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.ELECTRONIC_DOCUMENT_ACCEPTED,
          entityId: doc.id,
        },
      });
      expect(acceptedAudit).not.toBeNull();
    }, 20000);
  });

  // ====================================================================
  // §41 Escenario A: misma venta, dos issue() concurrentes
  // ====================================================================
  describe('concurrencia — misma venta, dos issue() concurrentes (§41-A)', () => {
    it('exactamente un ElectronicDocument se crea; el otro recibe ConflictException; FiscalSeries incrementa SOLO +1', async () => {
      const sale = await createFixtureSale();

      const before = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });

      const attempt = () =>
        electronicDocumentsService.issue({
          saleId: sale.id,
          documentType: FiscalDocumentType.FACTURA,
          series: FACTURA_SERIES,
          actorUserId: adminId,
          ipAddress: null,
        });

      const results = await Promise.allSettled([attempt(), attempt()]);

      const fulfilled = results.filter(
        (r): r is PromiseFulfilledResult<Awaited<ReturnType<typeof attempt>>> =>
          r.status === 'fulfilled',
      );
      const rejected = results.filter(
        (r): r is PromiseRejectedResult => r.status === 'rejected',
      );

      // No se asume cuál de las dos solicitudes gana la carrera: solo que
      // exactamente una gana y exactamente una pierde limpiamente.
      expect(fulfilled).toHaveLength(1);
      expect(rejected).toHaveLength(1);
      expect(rejected[0].reason).toBeInstanceOf(ConflictException);

      createdDocumentIds.push(fulfilled[0].value.id);

      const docsForSale = await prisma.electronicDocument.findMany({
        where: { saleId: sale.id },
      });
      expect(docsForSale).toHaveLength(1);

      const after = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.FACTURA,
            series: FACTURA_SERIES,
          },
        },
      });
      // Prueba central del §19: aunque la transacción perdedora haya
      // alcanzado a asignar un número fiscal dentro de su propia
      // transacción antes de perder la carrera del índice único parcial,
      // el rollback de ESA transacción revierte también su incremento de
      // FiscalSeries. El incremento neto observable es exactamente +1.
      expect(after.currentNumber - before.currentNumber).toBe(1);
    }, 20000);
  });

  // ====================================================================
  // §41 Escenario B: dos ventas distintas, misma serie fiscal concurrente
  // ====================================================================
  describe('concurrencia — dos ventas distintas, misma serie fiscal (§41-B)', () => {
    it('ambos documentos se crean, con números fiscales secuenciales y distintos; FiscalSeries incrementa +2', async () => {
      const [saleA, saleB] = await Promise.all([
        createFixtureSale(),
        createFixtureSale(),
      ]);

      const before = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.BOLETA,
            series: BOLETA_SERIES,
          },
        },
      });

      const [docA, docB] = await Promise.all([
        electronicDocumentsService.issue({
          saleId: saleA.id,
          documentType: FiscalDocumentType.BOLETA,
          series: BOLETA_SERIES,
          actorUserId: adminId,
          ipAddress: null,
        }),
        electronicDocumentsService.issue({
          saleId: saleB.id,
          documentType: FiscalDocumentType.BOLETA,
          series: BOLETA_SERIES,
          actorUserId: adminId,
          ipAddress: null,
        }),
      ]);
      createdDocumentIds.push(docA.id, docB.id);

      expect(docA.number).not.toBe(docB.number);
      const numbers = [docA.number, docB.number].sort((x, y) => x - y);
      expect(numbers[1] - numbers[0]).toBe(1);
      expect(numbers[0]).toBeGreaterThan(before.currentNumber);

      const after = await prisma.fiscalSeries.findUniqueOrThrow({
        where: {
          documentType_series: {
            documentType: FiscalDocumentType.BOLETA,
            series: BOLETA_SERIES,
          },
        },
      });
      expect(after.currentNumber - before.currentNumber).toBe(2);

      // Sin colisión: identidad fiscal única a nivel de base de datos.
      const bothDocs = await prisma.electronicDocument.findMany({
        where: { id: { in: [docA.id, docB.id] } },
      });
      expect(new Set(bothDocs.map((d) => d.number)).size).toBe(2);
    }, 20000);
  });

  // ====================================================================
  // §28/§42: fallo técnico del proveedor
  // ====================================================================
  describe('fallo técnico del proveedor (§28/§42)', () => {
    it('el número queda consumido, el documento pasa a SUBMISSION_FAILED, y es reintentable sin asignar otro número', async () => {
      const sale = await createFixtureSale();

      await expect(
        failingElectronicDocumentsService.issue({
          saleId: sale.id,
          documentType: FiscalDocumentType.FACTURA,
          series: FACTURA_SERIES,
          actorUserId: adminId,
          ipAddress: null,
        }),
      ).rejects.toThrow(ServiceUnavailableException);

      const doc = await prisma.electronicDocument.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      createdDocumentIds.push(doc.id);
      expect(doc.status).toBe(ElectronicDocumentStatus.SUBMISSION_FAILED);
      const numberAfterFailure = doc.number;

      const failedAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
          entityId: doc.id,
        },
      });
      expect(failedAudit).not.toBeNull();
      expect(JSON.stringify(failedAudit?.metadata ?? {})).not.toContain(
        'ECONNREFUSED',
      );

      // Reintento con el proveedor REAL (MockProvider, app normal): retoma
      // EXACTAMENTE el mismo documento/número, nunca crea otro.
      const retried = await electronicDocumentsService.retrySubmission(
        doc.id,
        adminId,
        null,
      );
      expect(retried.id).toBe(doc.id);
      expect(retried.number).toBe(numberAfterFailure);
      expect(retried.status).toBe(ElectronicDocumentStatus.ACCEPTED);

      const docsForSale = await prisma.electronicDocument.findMany({
        where: { saleId: sale.id },
      });
      expect(docsForSale).toHaveLength(1);
    }, 20000);
  });

  // ====================================================================
  // Remediación final del Bloque 11C — resultado DESCONOCIDO (fail closed)
  // ====================================================================
  describe('resultado desconocido del proveedor — error genérico no clasificado (remediación 11C)', () => {
    it('permanece SUBMITTED (nunca SUBMISSION_FAILED), sin auditoría de fallo, sin reintento posible', async () => {
      const sale = await createFixtureSale();

      await expect(
        unknownOutcomeElectronicDocumentsService.issue({
          saleId: sale.id,
          documentType: FiscalDocumentType.FACTURA,
          series: FACTURA_SERIES,
          actorUserId: adminId,
          ipAddress: null,
        }),
      ).rejects.toThrow(ServiceUnavailableException);

      const doc = await prisma.electronicDocument.findFirstOrThrow({
        where: { saleId: sale.id },
      });
      createdDocumentIds.push(doc.id);

      // Nunca SUBMISSION_FAILED ante una excepción no clasificada: la
      // política "fail closed" deja el documento exactamente en SUBMITTED.
      expect(doc.status).toBe(ElectronicDocumentStatus.SUBMITTED);
      expect(doc.providerStatus).toBe('UNKNOWN_OUTCOME');
      expect(doc.providerMessage ?? '').not.toContain(
        'raw sensitive provider failure',
      );

      const failedAudit = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.ELECTRONIC_DOCUMENT_SUBMISSION_FAILED,
          entityId: doc.id,
        },
      });
      expect(failedAudit).toBeNull();

      // SUBMITTED nunca es reintentable: retrySubmission() solo admite
      // SUBMISSION_FAILED.
      await expect(
        electronicDocumentsService.retrySubmission(doc.id, adminId, null),
      ).rejects.toThrow(ConflictException);

      const docsForSale = await prisma.electronicDocument.findMany({
        where: { saleId: sale.id },
      });
      expect(docsForSale).toHaveLength(1);
    }, 20000);
  });
});
