import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSourceType,
  AccountingSystemKey,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
  RoleName,
  SupplierDocumentType,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
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
 * Fase A5.2a — Facturas de compra universales. Suite dedicada y aislada
 * (mismo criterio ya usado por accounting.e2e-spec.ts/
 * manual-journal-entries.e2e-spec.ts/suppliers.e2e-spec.ts): limpia
 * exclusivamente por los ids que ella misma crea.
 *
 * Los 7 AccountingSystemKey nuevos (ACCOUNTS_PAYABLE, VAT_RECEIVABLE,
 * PURCHASE_*) NUNCA tienen mapeo real en pos_db/pos_db_test fuera de esta
 * suite. Las pruebas de "camino feliz" activan mapeos SINTÉTICOS,
 * exclusivamente dentro de esta suite, a través del endpoint real
 * PATCH /api/v1/chart-of-accounts/system-keys/:systemKey — nunca mediante
 * un bypass de código ni un seed. afterAll() los retira (elimina las
 * cuentas fixture, lo que automáticamente libera el systemKey) para que
 * dos ejecuciones consecutivas de la suite completa partan siempre del
 * mismo estado "sin mapeo".
 */

interface SafePurchaseInvoiceLineBody {
  id: string;
  productId: string | null;
  descriptionSnapshot: string;
  unitCodeSnapshot: string | null;
  unitNameSnapshot: string | null;
  acquisitionKind: string;
  purchasePurpose: string;
  quantity: string;
  unitCost: string;
  taxCategory: string;
  taxBasis: string | null;
  taxRateSnapshot: string | null;
  taxableBaseAmount: string;
  taxAmount: string;
  creditableTaxAmount: string;
  lineTotal: string;
  isReceiptEligible: boolean | null;
}

interface SafePurchaseInvoiceBody {
  id: string;
  supplierId: string;
  documentType: string;
  documentSeries: string | null;
  documentNumber: string;
  issueDate: string;
  registrationDate: string;
  accountingDate: string;
  dueDate: string | null;
  paymentTermsDays: number | null;
  currencyCode: string;
  subtotal: string;
  taxAmount: string;
  totalAmount: string;
  status: 'DRAFT' | 'CONFIRMED' | 'CANCELLED';
  postedEntryId: string | null;
  createdByUserId: string;
  confirmedAt: string | null;
  cancelledAt: string | null;
  cancelledByUserId: string | null;
  cancellationReason: string | null;
  createdAt: string;
  updatedAt: string;
  lines: SafePurchaseInvoiceLineBody[];
}

interface SafeAccountBody {
  id: string;
  code: string;
}

interface SafeEntryListItem {
  id: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  eventType: 'ORIGINAL' | 'REVERSAL';
  journalNumber: number;
  accountingDate: string;
  reversesEntryId: string | null;
}

const ACCOUNTANT_USERNAME = 'e2e_a52a_accountant';
const MANAGEMENT_USERNAME = 'e2e_a52a_management';
const SELLER_USERNAME = 'e2e_a52a_seller';
const WAREHOUSE_USERNAME = 'e2e_a52a_warehouse';
const FIXTURE_PASSWORD = 'E2eA52aFixture2026Aa';
const NON_EXISTENT_UUID = '00000000-0000-4000-8000-000000000000';

const PURCHASE_SYSTEM_KEYS: AccountingSystemKey[] = [
  AccountingSystemKey.ACCOUNTS_PAYABLE,
  AccountingSystemKey.VAT_RECEIVABLE,
  AccountingSystemKey.PURCHASE_RESALE_INVENTORY,
  AccountingSystemKey.PURCHASE_INTERNAL_CONSUMPTION,
  AccountingSystemKey.PURCHASE_FIXED_ASSET,
  AccountingSystemKey.PURCHASE_OPERATING_EXPENSE,
  AccountingSystemKey.PURCHASE_OTHER,
];

describe('Purchase Invoices — Fase A5.2a (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let managementCookie: string;
  let accountantCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;

  let categoryId: string;
  let unitId: string;
  let trackedProductId: string;
  let nonTrackedProductId: string;
  let activeSupplierId: string;
  let inactiveSupplierId: string;
  let originalTaxEnabled: boolean;
  let originalTaxRate: Prisma.Decimal;

  const createdAccountIds: string[] = [];
  const createdPurchaseInvoiceIds: string[] = [];
  const createdSupplierIds: string[] = [];
  const createdProductIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  function createInvoice(
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/purchase-invoices')
      .set('Cookie', cookie)
      .send(body);
  }

  function updateInvoice(
    id: string,
    body: Record<string, unknown>,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .patch(`/api/v1/purchase-invoices/${id}`)
      .set('Cookie', cookie)
      .send(body);
  }

  function confirmInvoice(
    id: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/confirm`)
      .set('Cookie', cookie)
      .send({});
  }

  function cancelInvoice(
    id: string,
    reason: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/purchase-invoices/${id}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  function getInvoice(
    id: string,
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/purchase-invoices/${id}`)
      .set('Cookie', cookie);
  }

  function listInvoices(
    query: Record<string, unknown> = {},
    cookie: string = adminCookie,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/purchase-invoices')
      .query(query)
      .set('Cookie', cookie);
  }

  async function findJournalEntry(
    sourceId: string,
    eventType: 'ORIGINAL' | 'REVERSAL' = 'ORIGINAL',
  ): Promise<SafeEntryListItem | undefined> {
    const response = await request(app.getHttpServer())
      .get('/api/v1/accounting/entries')
      .query({ sourceId })
      .set('Cookie', adminCookie);
    const body = response.body as { data: SafeEntryListItem[] };
    return body.data.find((entry) => entry.eventType === eventType);
  }

  async function createTestAccount(
    code: string,
    name: string,
    type: AccountType = AccountType.ASSET,
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/chart-of-accounts')
      .set('Cookie', adminCookie)
      .send({ code, name, type, isPostable: true });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la cuenta fixture ${code}: ${JSON.stringify(response.body)}`,
      );
    }
    const created = response.body as SafeAccountBody;
    createdAccountIds.push(created.id);
    return created.id;
  }

  const PURCHASE_SYSTEM_KEY_SHORT_CODES: Readonly<
    Record<AccountingSystemKey, string>
  > = {
    ACCOUNTS_PAYABLE: 'AP',
    VAT_RECEIVABLE: 'VATR',
    PURCHASE_RESALE_INVENTORY: 'PRES',
    PURCHASE_INTERNAL_CONSUMPTION: 'PINT',
    PURCHASE_FIXED_ASSET: 'PFIX',
    PURCHASE_OPERATING_EXPENSE: 'POPE',
    PURCHASE_OTHER: 'POTH',
  } as Record<AccountingSystemKey, string>;

  async function activatePurchaseMappings(): Promise<void> {
    // Código corto (Account.code es VarChar(20)): a diferencia de otros
    // fixtures de esta suite (proveedores/documentos), aquí no cabe el
    // sufijo largo RUN_ID+counter — se usa el mismo criterio compacto que
    // manual-journal-entries.e2e-spec.ts (Date.now() % 1000000).
    const shortSuffix = Date.now() % 1000000;
    for (const systemKey of PURCHASE_SYSTEM_KEYS) {
      const accountId = await createTestAccount(
        `A52${PURCHASE_SYSTEM_KEY_SHORT_CODES[systemKey]}${shortSuffix}`,
        `Cuenta sintética E2E A5.2a — ${systemKey}`,
        systemKey === AccountingSystemKey.ACCOUNTS_PAYABLE
          ? AccountType.LIABILITY
          : AccountType.ASSET,
      );
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/chart-of-accounts/system-keys/${systemKey}`)
        .set('Cookie', adminCookie)
        .send({ accountId });
      if (response.status !== 200) {
        throw new Error(
          `No se pudo activar el mapeo sintético ${systemKey}: ${JSON.stringify(response.body)}`,
        );
      }
    }
  }

  function validSupplierBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    const suffix = nextSuffix();
    return {
      documentType: SupplierDocumentType.RUC,
      documentNumber: suffix.slice(-11).padStart(11, '0'),
      legalName: `Proveedor E2E A5.2a ${suffix}`,
      ...overrides,
    };
  }

  async function createSupplier(
    overrides: Record<string, unknown> = {},
  ): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/suppliers')
      .set('Cookie', adminCookie)
      .send(validSupplierBody(overrides));
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear el proveedor fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as { id: string };
    createdSupplierIds.push(body.id);
    return body.id;
  }

  function minimalLine(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      description: 'Servicio de mantenimiento',
      acquisitionKind: 'SERVICE',
      purchasePurpose: 'OPERATING_EXPENSE',
      quantity: '1.000',
      unitCost: '100.00',
      taxCategory: 'TAXED',
      taxBasis: 'TAX_EXCLUDED',
      creditableTaxAmount: '18.00',
      ...overrides,
    };
  }

  async function createMinimalDraft(
    overrides: Record<string, unknown> = {},
  ): Promise<SafePurchaseInvoiceBody> {
    const suffix = nextSuffix();
    const response = await createInvoice({
      supplierId: activeSupplierId,
      documentType: PurchaseInvoiceDocumentType.FACTURA,
      documentSeries: 'F001',
      documentNumber: suffix.slice(-8),
      issueDate: businessToday(),
      lines: [minimalLine()],
      ...overrides,
    });
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la factura fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafePurchaseInvoiceBody;
    createdPurchaseInvoiceIds.push(body.id);
    return body;
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
      username: MANAGEMENT_USERNAME,
      email: 'e2e_a52a_management@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: ACCOUNTANT_USERNAME,
      email: 'e2e_a52a_accountant@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.ACCOUNTANT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_a52a_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_a52a_warehouse@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    accountantCookie = (
      await login(app.getHttpServer(), ACCOUNTANT_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, FIXTURE_PASSWORD)
    ).cookie;

    const suffix = nextSuffix();
    // Category.code es VarChar(30) y Unit.code VarChar(15): a diferencia
    // del sufijo largo RUN_ID+counter (usado para documentos/proveedores,
    // con más margen), aquí se usa un sufijo numérico corto para no
    // exceder el límite de columna (mismo criterio ya usado por
    // manual-journal-entries.e2e-spec.ts para Account.code).
    const shortSuffix = Date.now() % 1000000;
    const category = await prisma.category.create({
      data: { code: `A52CAT${shortSuffix}`, name: 'Categoría E2E A5.2a' },
    });
    categoryId = category.id;
    const unit = await prisma.unit.create({
      data: {
        code: `A52UN${shortSuffix}`,
        name: 'Unidad E2E A5.2a',
        abbreviation: 'u52',
        allowDecimal: true,
      },
    });
    unitId = unit.id;

    const trackedProduct = await prisma.product.create({
      data: {
        sku: `A52A-T-${suffix}`,
        name: `Producto rastreado E2E A5.2a ${suffix}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: '50.00',
        isInventoryTracked: true,
        status: ProductStatus.ACTIVE,
      },
    });
    trackedProductId = trackedProduct.id;
    createdProductIds.push(trackedProductId);

    const nonTrackedProduct = await prisma.product.create({
      data: {
        sku: `A52A-NT-${suffix}`,
        name: `Servicio no rastreado E2E A5.2a ${suffix}`,
        productType: ProductType.SERVICE,
        categoryId,
        unitId,
        salePrice: '30.00',
        isInventoryTracked: false,
        status: ProductStatus.ACTIVE,
      },
    });
    nonTrackedProductId = nonTrackedProduct.id;
    createdProductIds.push(nonTrackedProductId);

    activeSupplierId = await createSupplier();
    inactiveSupplierId = await createSupplier();
    const deactivate = await request(app.getHttpServer())
      .post(`/api/v1/suppliers/${inactiveSupplierId}/deactivate`)
      .set('Cookie', adminCookie)
      .send({});
    if (deactivate.status !== 200) {
      throw new Error(
        `No se pudo desactivar el proveedor fixture: ${JSON.stringify(deactivate.body)}`,
      );
    }

    // Fixture de CompanySettings vía escritura DIRECTA de Prisma — mismo
    // criterio ya establecido por configuration-tax.e2e-spec.ts
    // (setCompanySettingsFixture): taxEnabled/taxRate no tienen ninguna
    // restricción de A0.2 (esa guardia es exclusiva de currencyCode). Esta
    // suite nunca prueba el endpoint PATCH /configuration en sí — solo
    // necesita un IGV conocido y activo para ejercitar taxCategory=TAXED.
    const settingsBefore = await prisma.companySettings.findUniqueOrThrow({
      where: { singleton: true },
    });
    originalTaxEnabled = settingsBefore.taxEnabled;
    originalTaxRate = settingsBefore.taxRate;
    await prisma.companySettings.update({
      where: { singleton: true },
      data: { taxEnabled: true, taxRate: new Prisma.Decimal('18.00') },
    });
  }, 60000);

  afterAll(async () => {
    try {
      await prisma.companySettings.update({
        where: { singleton: true },
        data: { taxEnabled: originalTaxEnabled, taxRate: originalTaxRate },
      });

      const posted = await prisma.purchaseInvoice.findMany({
        where: {
          id: { in: createdPurchaseInvoiceIds },
          postedEntryId: { not: null },
        },
        select: { postedEntryId: true },
      });
      const postedEntryIds = posted
        .map((row) => row.postedEntryId)
        .filter((id): id is string => id !== null);

      // PurchaseInvoiceLine.purchaseInvoiceId -> PurchaseInvoice es CASCADE
      // (schema A5.2a): basta con borrar la factura. El orden crítico es
      // soltar PurchaseInvoice.postedEntryId -> AccountingEntry (RESTRICT)
      // ANTES de poder borrar el propio AccountingEntry.
      await prisma.purchaseInvoice.deleteMany({
        where: { id: { in: createdPurchaseInvoiceIds } },
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

      await prisma.supplier.deleteMany({
        where: { id: { in: createdSupplierIds } },
      });
      await prisma.product.deleteMany({
        where: { id: { in: createdProductIds } },
      });
      await prisma.category.deleteMany({ where: { id: categoryId } });
      await prisma.unit.deleteMany({ where: { id: unitId } });

      // Borrar las cuentas fixture libera automáticamente el systemKey que
      // sostenían (columna nullable en Account) — una segunda ejecución de
      // esta suite vuelve a partir de "sin mapeo configurado".
      await prisma.account.deleteMany({
        where: { id: { in: createdAccountIds } },
      });

      await prisma.userRole.deleteMany({
        where: {
          user: {
            username: {
              in: [
                MANAGEMENT_USERNAME,
                ACCOUNTANT_USERNAME,
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
              MANAGEMENT_USERNAME,
              ACCOUNTANT_USERNAME,
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
  // RBAC
  // ====================================================================
  describe('RBAC', () => {
    it('SELLER/WAREHOUSE: 403 en todos los endpoints', async () => {
      for (const cookie of [sellerCookie, warehouseCookie]) {
        expect((await listInvoices({}, cookie)).status).toBe(403);
        expect((await getInvoice(NON_EXISTENT_UUID, cookie)).status).toBe(403);
        expect(
          (
            await createInvoice(
              {
                supplierId: activeSupplierId,
                documentType: 'FACTURA',
                documentNumber: 'X',
                issueDate: businessToday(),
                lines: [minimalLine()],
              },
              cookie,
            )
          ).status,
        ).toBe(403);
        expect((await confirmInvoice(NON_EXISTENT_UUID, cookie)).status).toBe(
          403,
        );
        expect(
          (await cancelInvoice(NON_EXISTENT_UUID, 'motivo', cookie)).status,
        ).toBe(403);
      }
    });

    it('MANAGEMENT/ACCOUNTANT: leen pero nunca escriben (solo ADMIN administra en A5.2a)', async () => {
      for (const cookie of [managementCookie, accountantCookie]) {
        expect((await listInvoices({}, cookie)).status).toBe(200);
        expect(
          (
            await createInvoice(
              {
                supplierId: activeSupplierId,
                documentType: 'FACTURA',
                documentNumber: 'X',
                issueDate: businessToday(),
                lines: [minimalLine()],
              },
              cookie,
            )
          ).status,
        ).toBe(403);
        expect((await confirmInvoice(NON_EXISTENT_UUID, cookie)).status).toBe(
          403,
        );
        expect(
          (await cancelInvoice(NON_EXISTENT_UUID, 'motivo', cookie)).status,
        ).toBe(403);
      }
    });

    it('ACCOUNTANT no adquiere acceso a módulos no relacionados', async () => {
      const sales = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Cookie', accountantCookie);
      expect(sales.status).toBe(403);
    });

    it('ADMIN: acceso completo', async () => {
      expect((await listInvoices({}, adminCookie)).status).toBe(200);
      const draft = await createMinimalDraft();
      expect(draft.status).toBe('DRAFT');
    });
  });

  // ====================================================================
  // Bloqueo por configuración contable incompleta (antes de activar mapeos)
  // ====================================================================
  describe('confirmación sin mapeo contable configurado', () => {
    it('falla con 409 (nunca 500), sin dejar ningún efecto persistente', async () => {
      const draft = await createMinimalDraft();

      const auditBefore = await prisma.auditLog.count();
      const entriesBefore = await prisma.accountingEntry.count();

      const response = await confirmInvoice(draft.id);
      expect(response.status).toBe(409);

      const auditAfter = await prisma.auditLog.count();
      const entriesAfter = await prisma.accountingEntry.count();
      expect(auditAfter).toBe(auditBefore);
      expect(entriesAfter).toBe(entriesBefore);

      const row = await prisma.purchaseInvoice.findUniqueOrThrow({
        where: { id: draft.id },
      });
      expect(row.status).toBe('DRAFT');
      expect(row.postedEntryId).toBeNull();
    });
  });

  // ====================================================================
  // Activación de mapeos sintéticos (solo dentro de esta suite)
  // ====================================================================
  describe('activación de mapeos sintéticos', () => {
    it('ADMIN activa los 7 AccountingSystemKey nuevos vía PATCH real, sin seed ni bypass', async () => {
      await activatePurchaseMappings();
      const accounts = await prisma.account.findMany({
        where: { systemKey: { in: PURCHASE_SYSTEM_KEYS } },
      });
      expect(accounts).toHaveLength(PURCHASE_SYSTEM_KEYS.length);
    });
  });

  // ====================================================================
  // Creación — validaciones y universalidad de línea
  // ====================================================================
  describe('create', () => {
    it('proveedor inexistente: 400', async () => {
      const response = await createInvoice({
        supplierId: NON_EXISTENT_UUID,
        documentType: 'FACTURA',
        documentNumber: nextSuffix(),
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(response.status).toBe(400);
    });

    it('proveedor INACTIVE: 409', async () => {
      const response = await createInvoice({
        supplierId: inactiveSupplierId,
        documentType: 'FACTURA',
        documentNumber: nextSuffix(),
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(response.status).toBe(409);
    });

    it('línea de producto de catálogo: copia descriptionSnapshot/unitCodeSnapshot/unitNameSnapshot del producto', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            productId: trackedProductId,
            acquisitionKind: 'GOOD',
            purchasePurpose: 'RESALE_INVENTORY',
            quantity: '5.000',
            unitCost: '20.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });
      expect(draft.lines).toHaveLength(1);
      expect(draft.lines[0].productId).toBe(trackedProductId);
      expect(draft.lines[0].unitCodeSnapshot).not.toBeNull();
    });

    it('línea libre (sin productId) sin description: 400', async () => {
      const response = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentNumber: nextSuffix(),
        issueDate: businessToday(),
        lines: [
          {
            acquisitionKind: 'OTHER',
            purchasePurpose: 'OTHER',
            quantity: '1.000',
            unitCost: '10.00',
            taxCategory: 'EXEMPT',
          },
        ],
      });
      expect(response.status).toBe(400);
    });

    it('factura universal mixta: línea de producto (GOOD) + línea de servicio libre (SERVICE) + línea OTHER libre, en un solo documento', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            productId: trackedProductId,
            acquisitionKind: 'GOOD',
            purchasePurpose: 'RESALE_INVENTORY',
            quantity: '2.000',
            unitCost: '15.00',
            taxCategory: 'TAXED',
            taxBasis: 'TAX_EXCLUDED',
            creditableTaxAmount: '5.40',
          },
          {
            description: 'Servicio de instalación',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '50.00',
            taxCategory: 'EXEMPT',
          },
          {
            description: 'Gasto menor sin clasificar',
            acquisitionKind: 'OTHER',
            purchasePurpose: 'OTHER',
            quantity: '1.000',
            unitCost: '10.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });
      expect(draft.lines).toHaveLength(3);
      expect(draft.subtotal).toBe('90.00');
      expect(draft.taxAmount).toBe('5.40');
      expect(draft.totalAmount).toBe('95.40');
    });

    it('documento extranjero sin serie (documentSeries omitida): se crea igual, documentSeries=null', async () => {
      const response = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'OTHER',
        documentNumber: `FOREIGN-${nextSuffix()}`,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(response.status).toBe(201);
      const body = response.body as SafePurchaseInvoiceBody;
      createdPurchaseInvoiceIds.push(body.id);
      expect(body.documentSeries).toBeNull();
    });

    it('currencyCode nunca es aceptado del cliente: siempre el vigente en CompanySettings', async () => {
      const draft = await createMinimalDraft();
      expect(draft.currencyCode).toBe('PEN');
    });
  });

  // ====================================================================
  // Unicidad de documento (DB-enforced, nunca DocumentSequenceService)
  // ====================================================================
  describe('unicidad de documento', () => {
    it('mismo proveedor+tipo+serie+número exacto: 409 en el segundo intento', async () => {
      const suffix = nextSuffix();
      const first = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentSeries: 'F010',
        documentNumber: suffix,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(first.status).toBe(201);
      createdPurchaseInvoiceIds.push(
        (first.body as SafePurchaseInvoiceBody).id,
      );

      const second = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentSeries: 'F010',
        documentNumber: suffix,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(second.status).toBe(409);
    });

    it('variante de mayúsculas/espacios del mismo documento: también 409 (normalización UPPER/BTRIM)', async () => {
      const suffix = nextSuffix();
      const first = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentSeries: 'f020',
        documentNumber: suffix,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(first.status).toBe(201);
      createdPurchaseInvoiceIds.push(
        (first.body as SafePurchaseInvoiceBody).id,
      );

      const second = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentSeries: '  F020  ',
        documentNumber: `  ${suffix}  `,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(second.status).toBe(409);
    });

    it('documento sin serie duplicado dos veces (COALESCE en el índice funcional): también 409', async () => {
      const suffix = nextSuffix();
      const first = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'OTHER',
        documentNumber: `NOSERIES-${suffix}`,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(first.status).toBe(201);
      createdPurchaseInvoiceIds.push(
        (first.body as SafePurchaseInvoiceBody).id,
      );

      const second = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'OTHER',
        documentNumber: `NOSERIES-${suffix}`,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(second.status).toBe(409);
    });

    it('mismo número con OTRO proveedor: no colisiona (la unicidad es por proveedor+tipo+serie+número)', async () => {
      const suffix = nextSuffix();
      const otherSupplierId = await createSupplier();
      const first = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentSeries: 'F030',
        documentNumber: suffix,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(first.status).toBe(201);
      createdPurchaseInvoiceIds.push(
        (first.body as SafePurchaseInvoiceBody).id,
      );

      const second = await createInvoice({
        supplierId: otherSupplierId,
        documentType: 'FACTURA',
        documentSeries: 'F030',
        documentNumber: suffix,
        issueDate: businessToday(),
        lines: [minimalLine()],
      });
      expect(second.status).toBe(201);
      createdPurchaseInvoiceIds.push(
        (second.body as SafePurchaseInvoiceBody).id,
      );
    });

    it('concurrencia real: dos POST simultáneos con el MISMO documento -> exactamente uno 201, el otro 409', async () => {
      const suffix = nextSuffix();
      const body = {
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentSeries: 'F040',
        documentNumber: suffix,
        issueDate: businessToday(),
        lines: [minimalLine()],
      };

      const [first, second] = await Promise.all([
        createInvoice(body),
        createInvoice(body),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const winner = first.status === 201 ? first : second;
      createdPurchaseInvoiceIds.push(
        (winner.body as SafePurchaseInvoiceBody).id,
      );

      const count = await prisma.purchaseInvoice.count({
        where: {
          supplierId: activeSupplierId,
          documentType: 'FACTURA',
          documentSeries: 'F040',
          documentNumber: suffix,
        },
      });
      expect(count).toBe(1);
    });
  });

  // ====================================================================
  // Tratamiento tributario por línea (nunca uno solo por documento)
  // ====================================================================
  describe('tratamiento tributario por línea', () => {
    it('TAX_INCLUDED: el importe de línea YA incluye el impuesto (residual, nunca base*tasa)', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            description: 'Línea IGV incluido',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '118.00',
            taxCategory: 'TAXED',
            taxBasis: 'TAX_INCLUDED',
            creditableTaxAmount: '18.00',
          },
        ],
      });
      const line = draft.lines[0];
      expect(line.lineTotal).toBe('118.00');
      expect(line.taxAmount).toBe('18.00');
      expect(line.taxableBaseAmount).toBe('100.00');
    });

    it('TAX_EXCLUDED: el impuesto se SUMA sobre la base', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            description: 'Línea IGV excluido',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '100.00',
            taxCategory: 'TAXED',
            taxBasis: 'TAX_EXCLUDED',
            creditableTaxAmount: '18.00',
          },
        ],
      });
      const line = draft.lines[0];
      expect(line.taxableBaseAmount).toBe('100.00');
      expect(line.taxAmount).toBe('18.00');
      expect(line.lineTotal).toBe('118.00');
    });

    it('EXEMPT y UNAFFECTED: sin impuesto, lineTotal=quantity*unitCost', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            description: 'Exonerado',
            acquisitionKind: 'OTHER',
            purchasePurpose: 'OTHER',
            quantity: '3.000',
            unitCost: '10.00',
            taxCategory: 'EXEMPT',
          },
          {
            description: 'Inafecto',
            acquisitionKind: 'OTHER',
            purchasePurpose: 'OTHER',
            quantity: '2.000',
            unitCost: '5.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });
      // Orden por (createdAt asc, id asc): ambas líneas nacen en la misma
      // transacción (mismo createdAt), así que el desempate real es por id
      // (UUID, no secuencial) — nunca el orden de envío. Se identifican por
      // descriptionSnapshot, no por índice de arreglo.
      const byDescription = new Map(
        draft.lines.map((l) => [l.descriptionSnapshot, l]),
      );
      expect(byDescription.get('Exonerado')?.taxAmount).toBe('0.00');
      expect(byDescription.get('Exonerado')?.lineTotal).toBe('30.00');
      expect(byDescription.get('Inafecto')?.taxAmount).toBe('0.00');
      expect(byDescription.get('Inafecto')?.lineTotal).toBe('10.00');
    });

    it('mezcla de tratamientos en el MISMO documento: los totales de cabecera son la suma de líneas ya calculadas', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            description: 'Gravado excluido',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '100.00',
            taxCategory: 'TAXED',
            taxBasis: 'TAX_EXCLUDED',
            creditableTaxAmount: '18.00',
          },
          {
            description: 'Exonerado',
            acquisitionKind: 'OTHER',
            purchasePurpose: 'OTHER',
            quantity: '1.000',
            unitCost: '50.00',
            taxCategory: 'EXEMPT',
          },
        ],
      });
      expect(draft.subtotal).toBe('150.00');
      expect(draft.taxAmount).toBe('18.00');
      expect(draft.totalAmount).toBe('168.00');
    });

    it('creditableTaxAmount > taxAmount de la línea: 400', async () => {
      const response = await createInvoice({
        supplierId: activeSupplierId,
        documentType: 'FACTURA',
        documentNumber: nextSuffix(),
        issueDate: businessToday(),
        lines: [
          {
            description: 'Crédito excesivo',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '100.00',
            taxCategory: 'TAXED',
            taxBasis: 'TAX_EXCLUDED',
            creditableTaxAmount: '19.00',
          },
        ],
      });
      expect(response.status).toBe(400);
    });

    it('creditableTaxAmount omitido: default 0.00 (nunca se infiere deducibilidad)', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            description: 'Sin crédito declarado',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '100.00',
            taxCategory: 'TAXED',
            taxBasis: 'TAX_EXCLUDED',
          },
        ],
      });
      expect(draft.lines[0].creditableTaxAmount).toBe('0.00');
    });
  });

  // ====================================================================
  // Confirmación — congelamiento de isReceiptEligible y posteo contable
  // ====================================================================
  describe('confirm', () => {
    it('no existe: 404', async () => {
      expect((await confirmInvoice(NON_EXISTENT_UUID)).status).toBe(404);
    });

    it('sin líneas: 400, nunca contabiliza', async () => {
      const draft = await createMinimalDraft({ lines: [] });
      const response = await confirmInvoice(draft.id);
      expect(response.status).toBe(400);
    });

    it('congela isReceiptEligible=true SOLO para GOOD+productId+Product.isInventoryTracked=true', async () => {
      const draft = await createMinimalDraft({
        lines: [
          {
            productId: trackedProductId,
            acquisitionKind: 'GOOD',
            purchasePurpose: 'RESALE_INVENTORY',
            quantity: '1.000',
            unitCost: '20.00',
            taxCategory: 'UNAFFECTED',
          },
          {
            productId: nonTrackedProductId,
            acquisitionKind: 'GOOD',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '15.00',
            taxCategory: 'UNAFFECTED',
          },
          {
            description: 'Servicio puro',
            acquisitionKind: 'SERVICE',
            purchasePurpose: 'OPERATING_EXPENSE',
            quantity: '1.000',
            unitCost: '10.00',
            taxCategory: 'UNAFFECTED',
          },
        ],
      });

      const confirmed = await confirmInvoice(draft.id);
      expect(confirmed.status).toBe(200);
      const body = confirmed.body as SafePurchaseInvoiceBody;
      const byProduct = new Map(
        body.lines.map((l) => [l.productId, l.isReceiptEligible]),
      );
      expect(byProduct.get(trackedProductId)).toBe(true);
      expect(byProduct.get(nonTrackedProductId)).toBe(false);
      const serviceLine = body.lines.find((l) => l.productId === null);
      expect(serviceLine?.isReceiptEligible).toBe(false);
    });

    it('camino feliz: postea un AccountingEntry ORIGINAL sourceType=PURCHASE balanceado, marca CONFIRMED', async () => {
      const draft = await createMinimalDraft();
      const response = await confirmInvoice(draft.id);
      expect(response.status).toBe(200);
      const body = response.body as SafePurchaseInvoiceBody;
      expect(body.status).toBe('CONFIRMED');
      expect(body.postedEntryId).not.toBeNull();
      expect(body.confirmedAt).not.toBeNull();

      const entry = await findJournalEntry(draft.id, 'ORIGINAL');
      expect(entry).toBeDefined();
      expect(entry?.sourceType).toBe(AccountingSourceType.PURCHASE);

      const lines = await prisma.accountingEntryLine.findMany({
        where: { entryId: entry?.id },
      });
      const totalDebit = lines.reduce(
        (sum, l) => sum.plus(l.debitAmount),
        new Prisma.Decimal(0),
      );
      const totalCredit = lines.reduce(
        (sum, l) => sum.plus(l.creditAmount),
        new Prisma.Decimal(0),
      );
      expect(totalDebit.toFixed(2)).toBe(totalCredit.toFixed(2));
    });

    it('ya no está en DRAFT (doble confirmación): 409, nunca un segundo asiento', async () => {
      const draft = await createMinimalDraft();
      const first = await confirmInvoice(draft.id);
      expect(first.status).toBe(200);
      const second = await confirmInvoice(draft.id);
      expect(second.status).toBe(409);

      const count = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PURCHASE,
          sourceId: draft.id,
        },
      });
      expect(count).toBe(1);
    });

    it('fecha contable en un mes histórico sin periodo creado: 404, nunca auto-crea un periodo histórico', async () => {
      const draft = await createMinimalDraft({ accountingDate: '2020-01-15' });
      const response = await confirmInvoice(draft.id);
      expect(response.status).toBe(404);
    });

    it('PATCH sobre una factura ya CONFIRMED: 409 (inmutable, se anula en vez de editarse)', async () => {
      const draft = await createMinimalDraft();
      await confirmInvoice(draft.id);
      const response = await updateInvoice(draft.id, { documentNumber: 'X' });
      expect(response.status).toBe(409);
    });

    it('confirmación concurrente de la MISMA factura: exactamente una gana, un solo ORIGINAL', async () => {
      const draft = await createMinimalDraft();

      const [first, second] = await Promise.all([
        confirmInvoice(draft.id),
        confirmInvoice(draft.id),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const count = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PURCHASE,
          sourceId: draft.id,
        },
      });
      expect(count).toBe(1);
    });
  });

  // ====================================================================
  // Anulación — reversión contable, nunca inventario
  // ====================================================================
  describe('cancel', () => {
    it('no existe: 404', async () => {
      expect((await cancelInvoice(NON_EXISTENT_UUID, 'motivo')).status).toBe(
        404,
      );
    });

    it('reason en blanco: 400', async () => {
      const draft = await createMinimalDraft();
      await confirmInvoice(draft.id);
      const response = await cancelInvoice(draft.id, '   ');
      expect(response.status).toBe(400);
    });

    it('todavía DRAFT (nunca CONFIRMED): 409', async () => {
      const draft = await createMinimalDraft();
      const response = await cancelInvoice(draft.id, 'motivo');
      expect(response.status).toBe(409);
    });

    it('camino feliz: crea el REVERSAL, marca CANCELLED, audita el motivo', async () => {
      const draft = await createMinimalDraft();
      await confirmInvoice(draft.id);

      const response = await cancelInvoice(
        draft.id,
        'Factura registrada con el proveedor incorrecto',
      );
      expect(response.status).toBe(200);
      const body = response.body as SafePurchaseInvoiceBody;
      expect(body.status).toBe('CANCELLED');
      expect(body.cancellationReason).toBe(
        'Factura registrada con el proveedor incorrecto',
      );

      const reversal = await findJournalEntry(draft.id, 'REVERSAL');
      expect(reversal).toBeDefined();
    });

    it('doble anulación: 409 en el segundo intento, un solo REVERSAL', async () => {
      const draft = await createMinimalDraft();
      await confirmInvoice(draft.id);
      const first = await cancelInvoice(draft.id, 'primer motivo');
      expect(first.status).toBe(200);
      const second = await cancelInvoice(draft.id, 'segundo motivo');
      expect(second.status).toBe(409);

      const originalEntry = await findJournalEntry(draft.id, 'ORIGINAL');
      const reversalCount = await prisma.accountingEntry.count({
        where: { reversesEntryId: originalEntry?.id },
      });
      expect(reversalCount).toBe(1);
    });
  });

  // ====================================================================
  // Regresión — módulos preexistentes siguen intactos
  // ====================================================================
  describe('regresión', () => {
    it('GET /api/v1/accounting/entries y GET /api/v1/sales siguen respondiendo normalmente', async () => {
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/accounting/entries')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(app.getHttpServer())
            .get('/api/v1/sales')
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
    });
  });
});
