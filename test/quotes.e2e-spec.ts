import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  QuoteStatus,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import {
  businessToday,
  fromPrismaDate,
} from '../src/common/date/business-date';
import { DocumentSequenceService } from '../src/document-sequences/document-sequence.service';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

const SELLER_USERNAME = 'e2e_seller_quotes';
const SELLER_PASSWORD = 'SellerQuotes123';
const MANAGEMENT_USERNAME = 'e2e_management_quotes';
const MANAGEMENT_PASSWORD = 'ManagementQuotes123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_quotes';
const WAREHOUSE_PASSWORD = 'WarehouseQuotes123';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const INVALID_UUID = 'not-a-uuid';
const TEST_GENERIC_CODE = 'PUBLIC_GENERAL';

const SAFE_QUOTE_DETAIL_KEYS = [
  'id',
  'number',
  'status',
  'customerId',
  'customerType',
  'customerDocumentType',
  'customerDocumentNumber',
  'customerName',
  'customerAddress',
  'seller',
  'issueDate',
  'expirationDate',
  'subtotal',
  'discountAmount',
  'taxAmount',
  'total',
  'notes',
  'items',
  'createdAt',
  'updatedAt',
].sort();

const SAFE_QUOTE_LIST_ITEM_KEYS = [
  'id',
  'number',
  'status',
  'customerId',
  'customerName',
  'customerDocumentNumber',
  'sellerId',
  'issueDate',
  'expirationDate',
  'subtotal',
  'discountAmount',
  'taxAmount',
  'total',
  'itemCount',
  'createdAt',
  'updatedAt',
].sort();

const SAFE_QUOTE_ITEM_KEYS = [
  'id',
  'productId',
  'productSku',
  'productName',
  'unitCode',
  'unitName',
  'unitAbbreviation',
  'quantity',
  'unitPrice',
  'lineTotal',
  'stockInfo',
].sort();

const SAFE_QUOTE_SELLER_KEYS = [
  'id',
  'username',
  'firstName',
  'lastName',
].sort();
const SAFE_STOCK_INFO_KEYS = [
  'currentStock',
  'requestedQuantity',
  'sufficient',
].sort();

interface SafeQuoteStockInfoBody {
  currentStock: string;
  requestedQuantity: string;
  sufficient: boolean;
}

interface SafeQuoteItemBody {
  id: string;
  productId: string;
  productSku: string;
  productName: string;
  unitCode: string;
  unitName: string;
  unitAbbreviation: string;
  quantity: string;
  unitPrice: string;
  lineTotal: string;
  stockInfo: SafeQuoteStockInfoBody | null;
}

interface SafeQuoteSellerBody {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

interface SafeQuoteBody {
  id: string;
  number: string;
  status: QuoteStatus;
  customerId: string;
  customerType: CustomerType;
  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;
  seller: SafeQuoteSellerBody;
  issueDate: string;
  expirationDate: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  notes: string | null;
  items: SafeQuoteItemBody[];
  createdAt: string;
  updatedAt: string;
}

interface SafeQuoteListItemBody {
  id: string;
  number: string;
  status: QuoteStatus;
  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;
  sellerId: string;
  issueDate: string;
  expirationDate: string;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  itemCount: number;
  createdAt: string;
  updatedAt: string;
}

interface PaginatedBody<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

describe('Quotes (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let sellerCookie: string;
  let managementCookie: string;
  let warehouseCookie: string;
  let adminId: string;
  let sellerId: string;

  let categoryId: string;
  let categoryInactiveId: string;
  let unitDecimalId: string;
  let unitNoDecimalId: string;
  let unitInactiveId: string;
  let unitSnapshotId: string;

  // Productos fixture (todos ACTIVE salvo donde se indique lo contrario).
  let productA: { id: string; sku: string; salePrice: string };
  let productNoDecimal: { id: string; sku: string; salePrice: string };
  let productService: { id: string; sku: string; salePrice: string };
  let productNonInventory: { id: string; sku: string; salePrice: string };
  let productInactive: { id: string; sku: string; salePrice: string };
  let productBadCategory: { id: string; sku: string; salePrice: string };
  let productBadUnit: { id: string; sku: string; salePrice: string };
  let productStockLow: { id: string; sku: string; salePrice: string };
  let productStockHigh: { id: string; sku: string; salePrice: string };
  let productLiveStock: { id: string; sku: string; salePrice: string };
  let productSnapshot: { id: string; sku: string; salePrice: string };
  let productRounding: { id: string; sku: string; salePrice: string };
  let productOverflow: { id: string; sku: string; salePrice: string };

  // Clientes fixture.
  let personActive: { id: string; name: string };
  let companyActive: { id: string; name: string };
  let prospectCustomer: { id: string; name: string };
  let blockedCustomer: { id: string; name: string };
  let inactiveCustomer: { id: string; name: string };
  let genericCustomerId: string;
  let snapshotCustomer: {
    id: string;
    name: string;
    documentNumber: string;
    address: string;
  };
  let searchCustomer: { id: string; name: string; documentNumber: string };
  let paginationCustomer: { id: string };
  let xssCustomer: { id: string; name: string };

  const createdProductIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdQuoteIds: string[] = [];
  const directQuoteIds: string[] = [];
  // Limpieza por ID (nunca por código): §21 muta deliberadamente el código
  // en vivo de unitSnapshot, así que un deleteMany filtrado por el código
  // ORIGINAL dejaría esa fila huérfana tras la mutación.
  const ownedUnitIds: string[] = [];
  const ownedCategoryIds: string[] = [];

  // IDs compartidos entre secciones (creados una vez, reutilizados donde el
  // propio kickoff lo exige explícitamente: §28/§30 alimentan §33 y §43).
  let derivedExpiredQuoteId: string;
  let storedExpiredQuoteId: string;

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  function addDaysToDateOnly(dateOnly: string, delta: number): string {
    const [year, month, day] = dateOnly.split('-').map(Number);
    return fromPrismaDate(new Date(Date.UTC(year, month - 1, day + delta)));
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_quotes@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_quotes@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_quotes@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
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
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;

    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { username: E2E_ADMIN_USERNAME },
    });
    adminId = adminUser.id;
    const sellerUser = await prisma.user.findUniqueOrThrow({
      where: { username: SELLER_USERNAME },
    });
    sellerId = sellerUser.id;

    // ---------------------------------------------------------------
    // §7 Secuencia COT propia del spec: upsert defensivo (identidad por
    // documentType), pero SIEMPRE se elimina en el afterAll. currentNumber
    // solo se fija en la rama create; la rama update nunca lo reinicia.
    // ---------------------------------------------------------------
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

    // ---------------------------------------------------------------
    // §6 Catálogo fixture (identidad fija vía upsert; código no sufijado por
    // RUN_ID porque se limpia por completo en el afterAll de este archivo).
    // ---------------------------------------------------------------
    const category = await prisma.category.upsert({
      where: { code: 'E2EQUOCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2EQUOCAT', name: 'Categoria E2E Quotes' },
    });
    categoryId = category.id;
    ownedCategoryIds.push(categoryId);

    const categoryInactive = await prisma.category.upsert({
      where: { code: 'E2EQUOCATX' },
      update: { status: CategoryStatus.INACTIVE },
      create: {
        code: 'E2EQUOCATX',
        name: 'Categoria E2E Quotes Inactiva',
        status: CategoryStatus.INACTIVE,
      },
    });
    categoryInactiveId = categoryInactive.id;
    ownedCategoryIds.push(categoryInactiveId);

    const unitDecimal = await prisma.unit.upsert({
      where: { code: 'E2EQUOUD' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2EQUOUD',
        name: 'Unidad E2E Quotes decimal',
        abbreviation: 'uqd',
        allowDecimal: true,
      },
    });
    unitDecimalId = unitDecimal.id;
    ownedUnitIds.push(unitDecimalId);

    const unitNoDecimal = await prisma.unit.upsert({
      where: { code: 'E2EQUOUND' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2EQUOUND',
        name: 'Unidad E2E Quotes entera',
        abbreviation: 'uqn',
        allowDecimal: false,
      },
    });
    unitNoDecimalId = unitNoDecimal.id;
    ownedUnitIds.push(unitNoDecimalId);

    const unitInactive = await prisma.unit.upsert({
      where: { code: 'E2EQUOUX' },
      update: { status: UnitStatus.INACTIVE, allowDecimal: true },
      create: {
        code: 'E2EQUOUX',
        name: 'Unidad E2E Quotes inactiva',
        abbreviation: 'uqx',
        allowDecimal: true,
        status: UnitStatus.INACTIVE,
      },
    });
    unitInactiveId = unitInactive.id;
    ownedUnitIds.push(unitInactiveId);

    const unitSnapshot = await prisma.unit.upsert({
      where: { code: 'E2EQUOUS' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2EQUOUS',
        name: 'Unidad E2E Quotes snapshot',
        abbreviation: 'uqs',
        allowDecimal: true,
      },
    });
    unitSnapshotId = unitSnapshot.id;
    ownedUnitIds.push(unitSnapshotId);

    // ---------------------------------------------------------------
    // §6 Productos fixture (frescos cada corrida, limpiados en afterAll).
    // ---------------------------------------------------------------
    async function createProduct(
      data: Partial<Prisma.ProductUncheckedCreateInput> = {},
    ): Promise<{ id: string; sku: string; salePrice: string }> {
      const suffix = nextSuffix();
      const row = await prisma.product.create({
        data: {
          sku: `E2EQ-${suffix}`,
          name: `Producto E2E Quotes ${suffix}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('19.99'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('1000.000'),
          status: ProductStatus.ACTIVE,
          ...data,
        },
      });
      createdProductIds.push(row.id);
      return { id: row.id, sku: row.sku, salePrice: row.salePrice.toFixed(2) };
    }

    productA = await createProduct();
    productNoDecimal = await createProduct({
      unitId: unitNoDecimalId,
      salePrice: new Prisma.Decimal('5.00'),
    });
    productService = await createProduct({
      productType: ProductType.SERVICE,
      isInventoryTracked: false,
      salePrice: new Prisma.Decimal('50.00'),
      stockCurrent: new Prisma.Decimal('0.000'),
    });
    productNonInventory = await createProduct({
      isInventoryTracked: false,
      salePrice: new Prisma.Decimal('15.00'),
      stockCurrent: new Prisma.Decimal('0.000'),
    });
    productInactive = await createProduct({ status: ProductStatus.INACTIVE });
    productBadCategory = await createProduct({
      categoryId: categoryInactiveId,
    });
    productBadUnit = await createProduct({ unitId: unitInactiveId });
    productStockLow = await createProduct({
      stockCurrent: new Prisma.Decimal('2.000'),
    });
    productStockHigh = await createProduct({
      stockCurrent: new Prisma.Decimal('100.000'),
    });
    productLiveStock = await createProduct({
      stockCurrent: new Prisma.Decimal('10.000'),
    });
    productSnapshot = await createProduct({
      unitId: unitSnapshotId,
      salePrice: new Prisma.Decimal('25.00'),
    });
    productRounding = await createProduct({
      salePrice: new Prisma.Decimal('0.01'),
    });
    productOverflow = await createProduct({
      salePrice: new Prisma.Decimal('999999999999.99'),
    });

    // ---------------------------------------------------------------
    // §6/§8 Clientes fixture.
    // ---------------------------------------------------------------
    async function createCustomer(
      data: Partial<Prisma.CustomerUncheckedCreateInput>,
    ): Promise<{ id: string; name: string }> {
      const row = await prisma.customer.create({
        data: {
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          ...data,
        } as Prisma.CustomerUncheckedCreateInput,
      });
      createdCustomerIds.push(row.id);
      return { id: row.id, name: row.name };
    }

    const personSuffix = nextSuffix();
    personActive = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `Cliente Persona E2E ${personSuffix}`,
    });

    const companySuffix = nextSuffix();
    companyActive = await createCustomer({
      customerType: CustomerType.COMPANY,
      name: `Cliente Empresa E2E ${companySuffix}`,
    });

    const prospectSuffix = nextSuffix();
    prospectCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
      name: `Prospecto E2E ${prospectSuffix}`,
    });

    const blockedSuffix = nextSuffix();
    blockedCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      status: CustomerStatus.BLOCKED,
      name: `Cliente Bloqueado E2E ${blockedSuffix}`,
    });

    const inactiveSuffix = nextSuffix();
    inactiveCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      status: CustomerStatus.INACTIVE,
      name: `Cliente Inactivo E2E ${inactiveSuffix}`,
    });

    const snapshotSuffix = nextSuffix();
    snapshotCustomer = {
      ...(await createCustomer({
        customerType: CustomerType.PERSON,
        name: `Cliente Snapshot E2E ${snapshotSuffix}`,
        documentType: CustomerDocumentType.DNI,
        documentNumber: `SNP${snapshotSuffix}`,
        address: `Direccion original ${snapshotSuffix}`,
      })),
      documentNumber: `SNP${snapshotSuffix}`,
      address: `Direccion original ${snapshotSuffix}`,
    };

    const searchSuffix = nextSuffix();
    searchCustomer = {
      ...(await createCustomer({
        customerType: CustomerType.PERSON,
        name: `Cliente Busqueda E2E ${searchSuffix}`,
        documentType: CustomerDocumentType.DNI,
        documentNumber: `SRCH${searchSuffix}`,
      })),
      documentNumber: `SRCH${searchSuffix}`,
    };

    paginationCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `Cliente Paginacion E2E ${nextSuffix()}`,
    });

    xssCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `XSS <script>alert(1)</script> A&B "Q" O'Brien ${nextSuffix()}`,
    });

    // Ficha propia del genérico de prueba: mismos invariantes del seed real
    // (Fase 4), identidad exclusivamente por `code`.
    const generic = await prisma.customer.upsert({
      where: { code: TEST_GENERIC_CODE },
      update: {
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
      create: {
        code: TEST_GENERIC_CODE,
        name: 'Público general',
        isGeneric: true,
        customerType: null,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        documentType: null,
        documentNumber: null,
      },
    });
    genericCustomerId = generic.id;
  }, 60000);

  afterAll(async () => {
    try {
      const allQuoteIds = [...createdQuoteIds, ...directQuoteIds];

      if (allQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: allQuoteIds } },
        });
        await prisma.quote.deleteMany({ where: { id: { in: allQuoteIds } } });
      }

      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.QUOTE },
      });

      if (createdProductIds.length > 0) {
        await prisma.product.deleteMany({
          where: { id: { in: createdProductIds } },
        });
      }

      await prisma.unit.deleteMany({ where: { id: { in: ownedUnitIds } } });
      await prisma.category.deleteMany({
        where: { id: { in: ownedCategoryIds } },
      });

      if (createdCustomerIds.length > 0) {
        await prisma.customer.deleteMany({
          where: { id: { in: createdCustomerIds } },
        });
      }
      await prisma.customer.deleteMany({ where: { id: genericCustomerId } });
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 60000);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function validCreateBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      customerId: personActive.id,
      expirationDate: addDaysToDateOnly(businessToday(), 10),
      items: [{ productId: productA.id, quantity: '1.000' }],
      ...overrides,
    };
  }

  async function createQuote(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeQuoteBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/quotes')
      .set('Cookie', cookie)
      .send(validCreateBody(overrides));
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la cotización fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeQuoteBody;
    createdQuoteIds.push(body.id);
    return body;
  }

  async function fetchQuoteAuditRows(
    action: AuditAction,
    quoteId: string,
  ): Promise<
    {
      metadata: unknown;
      description: string;
      userId: string | null;
      module: string;
    }[]
  > {
    return prisma.auditLog.findMany({
      where: { action, entityType: 'Quote', entityId: quoteId },
    });
  }

  async function currentSequenceNumber(): Promise<number> {
    const row = await prisma.documentSequence.findUniqueOrThrow({
      where: { documentType: DocumentType.QUOTE },
    });
    return row.currentNumber;
  }

  /**
   * Inserta directamente en `quotes` (bypass total del servicio) para
   * verificar que PostgreSQL rechaza la fila mediante el CHECK/índice
   * indicado. Solo se acopla al SQLSTATE (23514 = check_violation,
   * 23505 = unique_violation), nunca al texto completo del error, igual que
   * en customers.e2e-spec.ts / inventory.e2e-spec.ts.
   */
  async function expectPgRejection(
    insert: () => Promise<unknown>,
    sqlstate: '23514' | '23505',
  ): Promise<void> {
    let caught = false;
    try {
      await insert();
    } catch (error) {
      caught = true;
      const pgError = error as { code?: string; meta?: { code?: string } };
      expect(pgError.code).toBe('P2010');
      expect(pgError.meta?.code).toBe(sqlstate);
    }
    expect(caught).toBe(true);
  }

  async function expectClientFkRejection(
    op: () => Promise<unknown>,
  ): Promise<void> {
    let caught = false;
    try {
      await op();
    } catch (error) {
      caught = true;
      const prismaError = error as { code?: string };
      expect(prismaError.code).toBe('P2003');
    }
    expect(caught).toBe(true);
  }

  function assertNoLeakage(response: { body: unknown }): void {
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/prisma/i);
    expect(serialized).not.toMatch(/P2002/);
    expect(serialized).not.toMatch(/P2010/);
    expect(serialized).not.toMatch(/23505/);
    expect(serialized).not.toMatch(/23514/);
    expect(serialized).not.toMatch(/constraint/i);
    expect(serialized).not.toMatch(/quotes_/);
    expect(serialized).not.toMatch(/quote_items_/);
    expect(serialized).not.toMatch(/at Object/); // stack traces
  }

  async function rawInsertQuote(overrides: {
    number: string;
    subtotal: string;
    discountAmount: string;
    taxAmount: string;
    total: string;
    issueDate: string;
    expirationDate: string;
    customerDocumentType?: CustomerDocumentType | null;
    customerDocumentNumber?: string | null;
  }): Promise<void> {
    const docType = overrides.customerDocumentType ?? null;
    const docNumber = overrides.customerDocumentNumber ?? null;
    await prisma.$executeRaw`
      INSERT INTO quotes
        (id, number, status, customer_id, customer_type, customer_document_type,
         customer_document_number, customer_name, customer_address, seller_id,
         issue_date, expiration_date, subtotal, discount_amount, tax_amount,
         total, notes, created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${overrides.number}, 'PENDING', ${personActive.id}::uuid,
         'PERSON', ${docType}::"CustomerDocumentType", ${docNumber},
         'Cliente Check', NULL, ${adminId}::uuid,
         ${overrides.issueDate}::date, ${overrides.expirationDate}::date,
         ${overrides.subtotal}::numeric, ${overrides.discountAmount}::numeric,
         ${overrides.taxAmount}::numeric, ${overrides.total}::numeric,
         NULL, now(), now())
    `;
  }

  async function rawInsertQuoteItem(overrides: {
    quoteId: string;
    productId: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO quote_items
        (id, quote_id, product_id, product_sku, product_name, unit_code,
         unit_name, unit_abbreviation, quantity, unit_price, line_total, created_at)
      VALUES
        (gen_random_uuid(), ${overrides.quoteId}::uuid, ${overrides.productId}::uuid,
         'SKU-CHK', 'Producto Check', 'UND', 'Unidad', 'und',
         ${overrides.quantity}::numeric, ${overrides.unitPrice}::numeric,
         ${overrides.lineTotal}::numeric, now())
    `;
  }

  /** Cotización válida creada directamente (sin ítems), para pruebas de unicidad de producto. */
  async function directValidQuote(number: string): Promise<string> {
    const row = await prisma.quote.create({
      data: {
        number,
        status: QuoteStatus.PENDING,
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: 'Cliente Check',
        sellerId: adminId,
        issueDate: new Date(`${businessToday()}T00:00:00.000Z`),
        expirationDate: new Date(`${businessToday()}T00:00:00.000Z`),
        subtotal: new Prisma.Decimal('0.00'),
        total: new Prisma.Decimal('0.00'),
      },
    });
    directQuoteIds.push(row.id);
    return row.id;
  }

  // ==================================================================
  // §62 Rutas no soportadas
  // ==================================================================
  describe('rutas no soportadas', () => {
    it('DELETE/PUT/convert-to-sale/expire responden 404', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server)
          .delete(`/api/v1/quotes/${id}`)
          .set('Cookie', adminCookie),
        request(server).put(`/api/v1/quotes/${id}`).set('Cookie', adminCookie),
        request(server)
          .post(`/api/v1/quotes/${id}/convert-to-sale`)
          .set('Cookie', adminCookie),
        request(server)
          .post(`/api/v1/quotes/${id}/expire`)
          .set('Cookie', adminCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
      }
    });
  });

  // ==================================================================
  // §11 Autenticación (401 en los 7 endpoints)
  // ==================================================================
  describe('autenticación', () => {
    it('sin cookie: los 7 endpoints responden 401', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server).post('/api/v1/quotes').send(validCreateBody()),
        request(server).get('/api/v1/quotes'),
        request(server).get(`/api/v1/quotes/${id}`),
        request(server).patch(`/api/v1/quotes/${id}`).send({ notes: 'x' }),
        request(server).post(`/api/v1/quotes/${id}/accept`),
        request(server).post(`/api/v1/quotes/${id}/reject`),
        request(server).get(`/api/v1/quotes/${id}/print`),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(401);
      }
    });
  });

  // ==================================================================
  // §61 Validación de UUID
  // ==================================================================
  describe('validación de UUID', () => {
    it('GET /quotes/:id con UUID inválido → 400 sin ejecutar el servicio', async () => {
      const server = app.getHttpServer();
      const responses = await Promise.all([
        request(server)
          .get(`/api/v1/quotes/${INVALID_UUID}`)
          .set('Cookie', adminCookie),
        request(server)
          .patch(`/api/v1/quotes/${INVALID_UUID}`)
          .set('Cookie', adminCookie)
          .send({ notes: 'x' }),
        request(server)
          .post(`/api/v1/quotes/${INVALID_UUID}/accept`)
          .set('Cookie', adminCookie),
        request(server)
          .post(`/api/v1/quotes/${INVALID_UUID}/reject`)
          .set('Cookie', adminCookie),
        request(server)
          .get(`/api/v1/quotes/${INVALID_UUID}/print`)
          .set('Cookie', adminCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(400);
      }
    });
  });

  // ==================================================================
  // §13 Primera cotización / formato COT
  // ==================================================================
  describe('primera cotización y formato COT', () => {
    it('currentNumber es 0 antes de la primera cotización; la primera es COT-000001', async () => {
      const before = await currentSequenceNumber();
      expect(before).toBe(0);

      const body = await createQuote(adminCookie);
      expect(body.number).toBe('COT-000001');

      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row.number).toBe('COT-000001');

      const after = await currentSequenceNumber();
      expect(after).toBe(1);
    });
  });

  // ==================================================================
  // §14 sellerId
  // ==================================================================
  describe('sellerId', () => {
    it('sellerId proviene del actor autenticado, nunca del payload', async () => {
      const asSeller = await createQuote(sellerCookie);
      expect(asSeller.seller.id).toBe(sellerId);

      const asAdmin = await createQuote(adminCookie);
      expect(asAdmin.seller.id).toBe(adminId);
    });

    it('sellerId en el payload → 400 (whitelist)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ sellerId: adminId }));
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // §15 PERSON / COMPANY / PROSPECT
  // ==================================================================
  describe('creación PERSON / COMPANY / PROSPECT', () => {
    it('cliente PERSON: snapshot customerType=PERSON', async () => {
      const body = await createQuote(adminCookie, {
        customerId: personActive.id,
      });
      expect(body.customerType).toBe(CustomerType.PERSON);
      expect(body.customerName).toBe(personActive.name);
    });

    it('cliente COMPANY: snapshot customerType=COMPANY', async () => {
      const body = await createQuote(adminCookie, {
        customerId: companyActive.id,
      });
      expect(body.customerType).toBe(CustomerType.COMPANY);
      expect(body.customerName).toBe(companyActive.name);
    });

    it('cliente con customerStage=PROSPECT es aceptado, sin auto-conversión a CUSTOMER', async () => {
      const body = await createQuote(adminCookie, {
        customerId: prospectCustomer.id,
      });
      expect(body.status).toBe(QuoteStatus.PENDING);

      const customerRow = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectCustomer.id },
      });
      expect(customerRow.customerStage).toBe(CustomerStage.PROSPECT);
    });
  });

  // ==================================================================
  // §16 Elegibilidad de cliente
  // ==================================================================
  describe('elegibilidad de cliente', () => {
    it('cliente inexistente → 404; genérico → 409; inactivo → 409, sin consumir secuencia', async () => {
      const before = await currentSequenceNumber();

      const missing = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerId: NON_EXISTENT_UUID }));
      expect(missing.status).toBe(404);

      const generic = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerId: genericCustomerId }));
      expect(generic.status).toBe(409);

      const inactive = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerId: inactiveCustomer.id }));
      expect(inactive.status).toBe(409);

      const after = await currentSequenceNumber();
      expect(after).toBe(before);
    });

    it('cliente BLOCKED → 201 (D3: puede cotizar); ACTIVE → 201', async () => {
      const blocked = await createQuote(adminCookie, {
        customerId: blockedCustomer.id,
      });
      expect(blocked.status).toBe(QuoteStatus.PENDING);

      const active = await createQuote(adminCookie, {
        customerId: personActive.id,
      });
      expect(active.status).toBe(QuoteStatus.PENDING);
    });
  });

  // ==================================================================
  // §17 Snapshot histórico de cliente
  // ==================================================================
  describe('snapshot histórico de cliente', () => {
    let quoteId: string;

    it('crea la cotización y registra el snapshot original', async () => {
      const body = await createQuote(adminCookie, {
        customerId: snapshotCustomer.id,
      });
      quoteId = body.id;
      expect(body.customerName).toBe(snapshotCustomer.name);
      expect(body.customerDocumentNumber).toBe(snapshotCustomer.documentNumber);
      expect(body.customerAddress).toBe(snapshotCustomer.address);
    });

    it('tras mutar el Customer vivo, la cotización conserva el snapshot original', async () => {
      await prisma.customer.update({
        where: { id: snapshotCustomer.id },
        data: {
          name: 'Nombre Cambiado Vivo',
          documentNumber: 'CAMBIADO999',
          address: 'Direccion Cambiada Viva',
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${quoteId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as SafeQuoteBody;
      expect(body.customerName).toBe(snapshotCustomer.name);
      expect(body.customerDocumentNumber).toBe(snapshotCustomer.documentNumber);
      expect(body.customerAddress).toBe(snapshotCustomer.address);
      expect(body.customerName).not.toBe('Nombre Cambiado Vivo');
    });

    it('el print también renderiza el snapshot original, no el cliente vivo', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${quoteId}/print`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(response.text).toContain(snapshotCustomer.name);
      expect(response.text).not.toContain('Nombre Cambiado Vivo');
    });
  });

  // ==================================================================
  // §18 Ítems vacíos / duplicados
  // ==================================================================
  describe('ítems vacíos y duplicados', () => {
    it('items=[] → 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ items: [] }));
      expect(response.status).toBe(400);
    });

    it('producto repetido → 400 (nunca 409), sin persistir nada ni avanzar la secuencia', async () => {
      const before = await currentSequenceNumber();
      const totalBefore = await prisma.quote.count();

      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [
              { productId: productA.id, quantity: '1.000' },
              { productId: productA.id, quantity: '2.000' },
            ],
          }),
        );
      expect(response.status).toBe(400);

      const after = await currentSequenceNumber();
      expect(after).toBe(before);
      expect(await prisma.quote.count()).toBe(totalBefore);
    });
  });

  // ==================================================================
  // §19 Elegibilidad de producto
  // ==================================================================
  describe('elegibilidad de producto', () => {
    it('producto inexistente → 404; inactivo → 409; categoría inactiva → 409; unidad inactiva → 409, sin consumir secuencia', async () => {
      const before = await currentSequenceNumber();

      const missing = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: NON_EXISTENT_UUID, quantity: '1.000' }],
          }),
        );
      expect(missing.status).toBe(404);

      const inactive = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: productInactive.id, quantity: '1.000' }],
          }),
        );
      expect(inactive.status).toBe(409);

      const badCategory = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: productBadCategory.id, quantity: '1.000' }],
          }),
        );
      expect(badCategory.status).toBe(409);

      const badUnit = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: productBadUnit.id, quantity: '1.000' }],
          }),
        );
      expect(badUnit.status).toBe(409);

      const after = await currentSequenceNumber();
      expect(after).toBe(before);
    });

    it('PRODUCT activo → 201; SERVICE activo → 201', async () => {
      const productQuote = await createQuote(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(productQuote.items[0].productId).toBe(productA.id);

      const serviceQuote = await createQuote(adminCookie, {
        items: [{ productId: productService.id, quantity: '1.000' }],
      });
      expect(serviceQuote.items[0].productId).toBe(productService.id);
      expect(serviceQuote.items[0].stockInfo).toBeNull();
    });
  });

  // ==================================================================
  // §20 Reglas de cantidad
  // ==================================================================
  describe('reglas de cantidad', () => {
    it('unidad allowDecimal=false: entero OK, fraccionario 400', async () => {
      const ok = await createQuote(adminCookie, {
        items: [{ productId: productNoDecimal.id, quantity: '1' }],
      });
      expect(ok.items[0].quantity).toBe('1.000');

      const rejected = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: productNoDecimal.id, quantity: '1.5' }],
          }),
        );
      expect(rejected.status).toBe(400);
    });

    it('unidad allowDecimal=true: "1.250" es válido', async () => {
      const body = await createQuote(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.250' }],
      });
      expect(body.items[0].quantity).toBe('1.250');
    });

    it.each([
      ['cero', '0'],
      ['negativa', '-1'],
      ['notación científica', '1e3'],
      ['coma decimal', '1,5'],
      ['más de 3 decimales', '1.2345'],
      ['desborda 11 enteros', '999999999999'],
    ])('cantidad malformada (%s) → 400', async (_label, quantity) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({ items: [{ productId: productA.id, quantity }] }),
        );
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // §21 Snapshot de producto/unidad/precio
  // ==================================================================
  describe('snapshot de producto, unidad y precio', () => {
    let quoteId: string;
    let originalSku: string;
    let originalName: string;
    let originalUnitCode: string;
    let originalUnitName: string;
    let originalUnitAbbreviation: string;
    let originalUnitPrice: string;

    it('crea la cotización y registra el snapshot original del ítem', async () => {
      const body = await createQuote(adminCookie, {
        items: [{ productId: productSnapshot.id, quantity: '2.000' }],
      });
      quoteId = body.id;
      const item = body.items[0];
      originalSku = item.productSku;
      originalName = item.productName;
      originalUnitCode = item.unitCode;
      originalUnitName = item.unitName;
      originalUnitAbbreviation = item.unitAbbreviation;
      originalUnitPrice = item.unitPrice;
      expect(originalUnitPrice).toBe('25.00');
    });

    it('tras mutar Product/Unit vivos, el snapshot del ítem permanece igual', async () => {
      await prisma.product.update({
        where: { id: productSnapshot.id },
        data: {
          sku: `${productSnapshot.sku}-CAMBIADO`,
          name: 'Nombre Producto Cambiado Vivo',
          salePrice: new Prisma.Decimal('999.99'),
        },
      });
      await prisma.unit.update({
        where: { id: unitSnapshotId },
        data: {
          code: 'CAMBIADOU',
          name: 'Unidad Cambiada',
          abbreviation: 'cmb',
        },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${quoteId}`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const item = (response.body as SafeQuoteBody).items[0];
      expect(item.productSku).toBe(originalSku);
      expect(item.productName).toBe(originalName);
      expect(item.unitCode).toBe(originalUnitCode);
      expect(item.unitName).toBe(originalUnitName);
      expect(item.unitAbbreviation).toBe(originalUnitAbbreviation);
      expect(item.unitPrice).toBe(originalUnitPrice);
    });

    it('el print también usa los valores del snapshot, no los vivos', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${quoteId}/print`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(response.text).toContain(originalName);
      expect(response.text).not.toContain('Nombre Producto Cambiado Vivo');
    });
  });

  // ==================================================================
  // §22 Autoridad de precio del backend
  // ==================================================================
  describe('autoridad de precio del backend', () => {
    it('unitPrice/lineTotal en el payload → 400 (whitelist)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [
              {
                productId: productA.id,
                quantity: '1.000',
                unitPrice: '999.00',
                lineTotal: '999.00',
              },
            ],
          }),
        );
      expect(response.status).toBe(400);
    });

    it('sin precio en el payload, unitPrice = Product.salePrice leído al crear', async () => {
      const body = await createQuote(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.items[0].unitPrice).toBe(productA.salePrice);
    });
  });

  // ==================================================================
  // §23 Cálculo decimal
  // ==================================================================
  describe('cálculo decimal', () => {
    it('HALF_UP de línea, subtotal, descuento y total exactos (sin punto flotante)', async () => {
      const body = await createQuote(adminCookie, {
        discountAmount: '10.00',
        items: [
          { productId: productRounding.id, quantity: '0.500' }, // 0.500 * 0.01 = 0.005 -> HALF_UP -> 0.01
          { productId: productA.id, quantity: '2.000' }, // 2.000 * 19.99 = 39.98
        ],
      });
      const roundedItem = body.items.find(
        (item) => item.productId === productRounding.id,
      );
      const baseItem = body.items.find(
        (item) => item.productId === productA.id,
      );
      expect(roundedItem?.lineTotal).toBe('0.01');
      expect(baseItem?.lineTotal).toBe('39.98');
      expect(body.subtotal).toBe('39.99');
      expect(body.discountAmount).toBe('10.00');
      expect(body.taxAmount).toBe('0.00');
      expect(body.total).toBe('29.99');
    });

    it('discountAmount ausente → "0.00"; total = subtotal', async () => {
      const body = await createQuote(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.discountAmount).toBe('0.00');
      expect(body.total).toBe(body.subtotal);
    });

    it('discountAmount = subtotal → total = "0.00"', async () => {
      const body = await createQuote(adminCookie, {
        discountAmount: productA.salePrice,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.total).toBe('0.00');
    });

    it('discountAmount > subtotal → 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            discountAmount: '999999.00',
            items: [{ productId: productA.id, quantity: '1.000' }],
          }),
        );
      expect(response.status).toBe(400);
    });

    it.each([
      ['negativo', '-5.00'],
      ['notación científica', '1e2'],
      ['coma decimal', '10,00'],
      ['más de 2 decimales', '10.999'],
    ])(
      'discountAmount malformado (%s) → 400',
      async (_label, discountAmount) => {
        const response = await request(app.getHttpServer())
          .post('/api/v1/quotes')
          .set('Cookie', adminCookie)
          .send(validCreateBody({ discountAmount }));
        expect(response.status).toBe(400);
      },
    );

    it('desbordamiento monetario (quantity × salePrice máximo) → 409 controlado, sin escritura ni consumo de secuencia', async () => {
      const before = await currentSequenceNumber();
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: productOverflow.id, quantity: '2.000' }],
          }),
        );
      expect(response.status).toBe(409);
      assertNoLeakage(response);
      const after = await currentSequenceNumber();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // §24 Stock informativo
  // ==================================================================
  describe('stock informativo (nunca reserva ni descuenta)', () => {
    it('stock insuficiente: 201 con sufficient=false, sin mutar Product.stockCurrent ni crear InventoryMovement', async () => {
      const movementsBefore = await prisma.inventoryMovement.count({
        where: { productId: productStockLow.id },
      });
      const body = await createQuote(adminCookie, {
        items: [{ productId: productStockLow.id, quantity: '5.000' }],
      });
      const item = body.items[0];
      expect(item.stockInfo).toEqual({
        currentStock: '2.000',
        requestedQuantity: '5.000',
        sufficient: false,
      });

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productStockLow.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('2.000');

      const movementsAfter = await prisma.inventoryMovement.count({
        where: { productId: productStockLow.id },
      });
      expect(movementsAfter).toBe(movementsBefore);
    });

    it('stock suficiente: sufficient=true', async () => {
      const body = await createQuote(adminCookie, {
        items: [{ productId: productStockHigh.id, quantity: '5.000' }],
      });
      expect(body.items[0].stockInfo?.sufficient).toBe(true);
    });

    it('producto no inventariable / servicio: stockInfo = null', async () => {
      const nonInventory = await createQuote(adminCookie, {
        items: [{ productId: productNonInventory.id, quantity: '1.000' }],
      });
      expect(nonInventory.items[0].stockInfo).toBeNull();

      const service = await createQuote(adminCookie, {
        items: [{ productId: productService.id, quantity: '1.000' }],
      });
      expect(service.items[0].stockInfo).toBeNull();
    });
  });

  // ==================================================================
  // §25 stockInfo es en vivo (nunca persistido)
  // ==================================================================
  describe('stockInfo es en vivo', () => {
    it('tras mutar Product.stockCurrent directamente, stockInfo refleja el valor vivo y el snapshot permanece igual', async () => {
      const body = await createQuote(adminCookie, {
        items: [{ productId: productLiveStock.id, quantity: '1.000' }],
      });
      expect(body.items[0].stockInfo?.currentStock).toBe('10.000');
      const originalProductName = body.items[0].productName;

      await prisma.product.update({
        where: { id: productLiveStock.id },
        data: { stockCurrent: new Prisma.Decimal('50.000') },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${body.id}`)
        .set('Cookie', adminCookie);
      const item = (response.body as SafeQuoteBody).items[0];
      expect(item.stockInfo?.currentStock).toBe('50.000');
      expect(item.productName).toBe(originalProductName);
    });
  });

  // ==================================================================
  // §26 Fecha de emisión / negocio
  // ==================================================================
  describe('fecha de emisión / negocio', () => {
    it('issueDate = businessToday() (America/Lima), no el huso del servidor', async () => {
      const body = await createQuote(adminCookie);
      expect(body.issueDate).toBe(businessToday());
    });
  });

  // ==================================================================
  // §27 Validación de vencimiento
  // ==================================================================
  describe('validación de vencimiento', () => {
    it('expirationDate == issueDate (hoy) → 201', async () => {
      const body = await createQuote(adminCookie, {
        expirationDate: businessToday(),
      });
      expect(body.expirationDate).toBe(businessToday());
    });

    it('expirationDate anterior a issueDate → 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            expirationDate: addDaysToDateOnly(businessToday(), -1),
          }),
        );
      expect(response.status).toBe(400);
    });

    it.each([
      ['30 de febrero', '2026-02-30'],
      ['con timestamp', '2026-08-09T12:00:00Z'],
      ['separador incorrecto', '2026/08/09'],
    ])('expirationDate inválida (%s) → 400', async (_label, expirationDate) => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ expirationDate }));
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // §28 EXPIRED efectivo — HTTP real
  // ==================================================================
  describe('estado efectivo EXPIRED (derivado, nunca persistido)', () => {
    it('vigencia históricamente vencida vía ajuste directo → efectivo EXPIRED, almacenado sigue PENDING', async () => {
      const created = await createQuote(adminCookie);
      derivedExpiredQuoteId = created.id;

      const issueDate = addDaysToDateOnly(businessToday(), -2);
      const expirationDate = addDaysToDateOnly(businessToday(), -1);
      await prisma.quote.update({
        where: { id: derivedExpiredQuoteId },
        data: {
          issueDate: new Date(`${issueDate}T00:00:00.000Z`),
          expirationDate: new Date(`${expirationDate}T00:00:00.000Z`),
        },
      });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${derivedExpiredQuoteId}`)
        .set('Cookie', adminCookie);
      expect(detail.status).toBe(200);
      expect((detail.body as SafeQuoteBody).status).toBe(QuoteStatus.EXPIRED);

      const listExpired = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.EXPIRED, limit: 100 })
        .set('Cookie', adminCookie);
      expect(
        (listExpired.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === derivedExpiredQuoteId,
        ),
      ).toBe(true);

      const listPending = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.PENDING, limit: 100 })
        .set('Cookie', adminCookie);
      expect(
        (listPending.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === derivedExpiredQuoteId,
        ),
      ).toBe(false);

      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${derivedExpiredQuoteId}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'no debería aplicarse' });
      expect(patch.status).toBe(409);

      const accept = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${derivedExpiredQuoteId}/accept`)
        .set('Cookie', adminCookie);
      expect(accept.status).toBe(409);

      const reject = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${derivedExpiredQuoteId}/reject`)
        .set('Cookie', adminCookie);
      expect(reject.status).toBe(409);

      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: derivedExpiredQuoteId },
      });
      expect(row.status).toBe(QuoteStatus.PENDING);
    });
  });

  // ==================================================================
  // §29 Frontera de vencimiento
  // ==================================================================
  describe('frontera de vencimiento (día calendario)', () => {
    it('expirationDate == businessToday() no está vencida', async () => {
      const body = await createQuote(adminCookie, {
        expirationDate: businessToday(),
      });
      expect(body.status).toBe(QuoteStatus.PENDING);
    });
  });

  // ==================================================================
  // §30 EXPIRED almacenado (compatibilidad futura)
  // ==================================================================
  describe('estado EXPIRED almacenado físicamente (compatibilidad futura)', () => {
    it('status=EXPIRED persistido directamente sigue siendo compatible con filtros y mutaciones', async () => {
      const created = await createQuote(adminCookie);
      storedExpiredQuoteId = created.id;
      await prisma.quote.update({
        where: { id: storedExpiredQuoteId },
        data: { status: QuoteStatus.EXPIRED },
      });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${storedExpiredQuoteId}`)
        .set('Cookie', adminCookie);
      expect((detail.body as SafeQuoteBody).status).toBe(QuoteStatus.EXPIRED);

      const listExpired = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.EXPIRED, limit: 100 })
        .set('Cookie', adminCookie);
      expect(
        (listExpired.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === storedExpiredQuoteId,
        ),
      ).toBe(true);

      const patch = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${storedExpiredQuoteId}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'x' });
      expect(patch.status).toBe(409);
      const accept = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${storedExpiredQuoteId}/accept`)
        .set('Cookie', adminCookie);
      expect(accept.status).toBe(409);
      const reject = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${storedExpiredQuoteId}/reject`)
        .set('Cookie', adminCookie);
      expect(reject.status).toBe(409);
    });
  });

  // ==================================================================
  // §31 Actualización (PATCH)
  // ==================================================================
  describe('actualización (PATCH)', () => {
    it('PENDIENTE efectivo: notes/expirationDate/discountAmount se actualizan; identidad y snapshot no cambian', async () => {
      const created = await createQuote(adminCookie);
      const newExpiration = addDaysToDateOnly(businessToday(), 20);

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({
          notes: 'Nota actualizada',
          expirationDate: newExpiration,
          discountAmount: '1.00',
        });
      expect(response.status).toBe(200);
      const body = response.body as SafeQuoteBody;
      expect(body.notes).toBe('Nota actualizada');
      expect(body.expirationDate).toBe(newExpiration);
      expect(body.discountAmount).toBe('1.00');

      expect(body.number).toBe(created.number);
      expect(body.customerId).toBe(created.customerId);
      expect(body.seller.id).toBe(created.seller.id);
      expect(body.issueDate).toBe(created.issueDate);
      expect(body.customerName).toBe(created.customerName);
      expect(body.status).toBe(created.status);
    });

    it('cuerpo vacío → 400', async () => {
      const created = await createQuote(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(response.status).toBe(400);
    });

    it.each([
      'number',
      'status',
      'sellerId',
      'customerId',
      'subtotal',
      'taxAmount',
      'total',
    ])('campo prohibido "%s" en PATCH → 400', async (field) => {
      const created = await createQuote(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ [field]: 'x' });
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // §32 Reemplazo completo de ítems
  // ==================================================================
  describe('reemplazo completo de ítems', () => {
    it('PATCH con items=[B] elimina A, crea B, recalcula totales, sin efecto en inventario', async () => {
      const created = await createQuote(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const movementsBefore = await prisma.inventoryMovement.count();

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ items: [{ productId: productNoDecimal.id, quantity: '3' }] });
      expect(response.status).toBe(200);
      const body = response.body as SafeQuoteBody;

      expect(body.items).toHaveLength(1);
      expect(body.items[0].productId).toBe(productNoDecimal.id);
      expect(body.items[0].unitPrice).toBe(productNoDecimal.salePrice);
      expect(body.subtotal).toBe('15.00'); // 3 * 5.00
      expect(body.total).toBe('15.00');

      const itemsInDb = await prisma.quoteItem.findMany({
        where: { quoteId: created.id },
      });
      expect(itemsInDb).toHaveLength(1);
      expect(itemsInDb[0].productId).toBe(productNoDecimal.id);

      expect(body.number).toBe(created.number);
      expect(body.customerId).toBe(created.customerId);
      expect(body.seller.id).toBe(created.seller.id);
      expect(body.customerName).toBe(created.customerName);

      const movementsAfter = await prisma.inventoryMovement.count();
      expect(movementsAfter).toBe(movementsBefore);
    });
  });

  // ==================================================================
  // §33 Editabilidad por estado
  // ==================================================================
  describe('editabilidad por estado', () => {
    it('PENDIENTE efectivo → 200', async () => {
      const created = await createQuote(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'edit' });
      expect(response.status).toBe(200);
    });

    it('ACCEPTED → 409', async () => {
      const created = await createQuote(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'edit' });
      expect(response.status).toBe(409);
    });

    it('REJECTED → 409', async () => {
      const created = await createQuote(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/reject`)
        .set('Cookie', adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'edit' });
      expect(response.status).toBe(409);
    });

    it('EXPIRED derivado y EXPIRED almacenado → 409 (fixtures de §28/§30)', async () => {
      const derived = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${derivedExpiredQuoteId}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'edit' });
      expect(derived.status).toBe(409);

      const stored = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${storedExpiredQuoteId}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'edit' });
      expect(stored.status).toBe(409);
    });

    it('CONVERTED (ajuste directo, sin endpoint de conversión) → 409', async () => {
      const created = await createQuote(adminCookie);
      await prisma.quote.update({
        where: { id: created.id },
        data: { status: QuoteStatus.CONVERTED },
      });
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'edit' });
      expect(response.status).toBe(409);
    });
  });

  // ==================================================================
  // §34 Aceptar
  // ==================================================================
  describe('aceptar', () => {
    it('PENDIENTE → 200, ACCEPTED; segundo accept → 409; reject tras accept → 409; update tras accept → 409; auditoría exacta', async () => {
      const created = await createQuote(adminCookie);

      const accept = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', adminCookie);
      expect(accept.status).toBe(200);
      expect((accept.body as SafeQuoteBody).status).toBe(QuoteStatus.ACCEPTED);

      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(QuoteStatus.ACCEPTED);

      const secondAccept = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', adminCookie);
      expect(secondAccept.status).toBe(409);

      const rejectAfterAccept = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/reject`)
        .set('Cookie', adminCookie);
      expect(rejectAfterAccept.status).toBe(409);

      const updateAfterAccept = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'x' });
      expect(updateAfterAccept.status).toBe(409);

      const auditRows = await fetchQuoteAuditRows(
        AuditAction.QUOTE_ACCEPTED,
        created.id,
      );
      expect(auditRows).toHaveLength(1);
      const metadata = auditRows[0].metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        ['previousStatus', 'quoteNumber'].sort(),
      );
      expect(metadata.quoteNumber).toBe(created.number);
      expect(metadata.previousStatus).toBe(QuoteStatus.PENDING);
      assertAuditRowHasNoSecrets({
        description: auditRows[0].description,
        metadata: auditRows[0].metadata,
      });
    });
  });

  // ==================================================================
  // §35 Rechazar
  // ==================================================================
  describe('rechazar', () => {
    it('PENDIENTE → 200, REJECTED; segundo reject → 409; accept tras reject → 409; update tras reject → 409; auditoría exacta', async () => {
      const created = await createQuote(adminCookie);

      const reject = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/reject`)
        .set('Cookie', adminCookie);
      expect(reject.status).toBe(200);
      expect((reject.body as SafeQuoteBody).status).toBe(QuoteStatus.REJECTED);

      const secondReject = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/reject`)
        .set('Cookie', adminCookie);
      expect(secondReject.status).toBe(409);

      const acceptAfterReject = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', adminCookie);
      expect(acceptAfterReject.status).toBe(409);

      const updateAfterReject = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'x' });
      expect(updateAfterReject.status).toBe(409);

      const auditRows = await fetchQuoteAuditRows(
        AuditAction.QUOTE_REJECTED,
        created.id,
      );
      expect(auditRows).toHaveLength(1);
      const metadata = auditRows[0].metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        ['previousStatus', 'quoteNumber'].sort(),
      );
      expect(metadata.previousStatus).toBe(QuoteStatus.PENDING);
    });
  });

  // ==================================================================
  // §36 Concurrencia: accept vs reject
  // ==================================================================
  describe('concurrencia: accept vs reject sobre la misma cotización', () => {
    it('exactamente uno gana (200), el otro pierde (409); estado final consistente; una sola auditoría de ciclo de vida', async () => {
      const created = await createQuote(adminCookie);

      const [acceptResult, rejectResult] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/quotes/${created.id}/accept`)
          .set('Cookie', adminCookie),
        request(app.getHttpServer())
          .post(`/api/v1/quotes/${created.id}/reject`)
          .set('Cookie', adminCookie),
      ]);

      const statuses = [acceptResult.status, rejectResult.status].sort();
      expect(statuses).toEqual([200, 409]);

      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect([QuoteStatus.ACCEPTED, QuoteStatus.REJECTED]).toContain(
        row.status,
      );

      const acceptedAudits = await fetchQuoteAuditRows(
        AuditAction.QUOTE_ACCEPTED,
        created.id,
      );
      const rejectedAudits = await fetchQuoteAuditRows(
        AuditAction.QUOTE_REJECTED,
        created.id,
      );
      const totalLifecycleAudits =
        acceptedAudits.length + rejectedAudits.length;
      expect(totalLifecycleAudits).toBe(1);

      if (row.status === QuoteStatus.ACCEPTED) {
        expect(acceptedAudits).toHaveLength(1);
        expect(rejectedAudits).toHaveLength(0);
      } else {
        expect(rejectedAudits).toHaveLength(1);
        expect(acceptedAudits).toHaveLength(0);
      }
    }, 30000);
  });

  // ==================================================================
  // §37 Concurrencia: doble accept
  // ==================================================================
  describe('concurrencia: doble accept sobre la misma cotización', () => {
    it('uno gana (200), el otro pierde (409); estado final ACCEPTED; una sola auditoría QUOTE_ACCEPTED', async () => {
      const created = await createQuote(adminCookie);

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/quotes/${created.id}/accept`)
          .set('Cookie', adminCookie),
        request(app.getHttpServer())
          .post(`/api/v1/quotes/${created.id}/accept`)
          .set('Cookie', adminCookie),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(QuoteStatus.ACCEPTED);

      const audits = await fetchQuoteAuditRows(
        AuditAction.QUOTE_ACCEPTED,
        created.id,
      );
      expect(audits).toHaveLength(1);
    }, 30000);
  });

  // ==================================================================
  // §38 Rollback de secuencia
  // ==================================================================
  describe('rollback de secuencia (instancia real de DocumentSequenceService)', () => {
    it('un error dentro de la transacción revierte el incremento del correlativo', async () => {
      const before = await currentSequenceNumber();
      const documentSequenceService = app.get(DocumentSequenceService);

      await expect(
        prisma.$transaction(async (tx) => {
          await documentSequenceService.next(tx, DocumentType.QUOTE);
          throw new Error('forced rollback for E2E');
        }),
      ).rejects.toThrow('forced rollback for E2E');

      const after = await currentSequenceNumber();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // §39 Generación concurrente de COT
  // ==================================================================
  describe('generación concurrente de COT — HTTP real', () => {
    it('dos cotizaciones concurrentes obtienen números distintos y consecutivos (before+1, before+2)', async () => {
      const before = await currentSequenceNumber();

      const [responseA, responseB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/quotes')
          .set('Cookie', adminCookie)
          .send(validCreateBody()),
        request(app.getHttpServer())
          .post('/api/v1/quotes')
          .set('Cookie', sellerCookie)
          .send(validCreateBody()),
      ]);

      expect(responseA.status).toBe(201);
      expect(responseB.status).toBe(201);
      createdQuoteIds.push((responseA.body as SafeQuoteBody).id);
      createdQuoteIds.push((responseB.body as SafeQuoteBody).id);

      const numberA = (responseA.body as SafeQuoteBody).number;
      const numberB = (responseB.body as SafeQuoteBody).number;
      expect(numberA).not.toBe(numberB);

      const expectedSet = new Set([
        `COT-${String(before + 1).padStart(6, '0')}`,
        `COT-${String(before + 2).padStart(6, '0')}`,
      ]);
      expect(expectedSet.has(numberA)).toBe(true);
      expect(expectedSet.has(numberB)).toBe(true);

      const after = await currentSequenceNumber();
      expect(after).toBe(before + 2);

      const rows = await prisma.quote.findMany({
        where: {
          id: {
            in: [
              (responseA.body as SafeQuoteBody).id,
              (responseB.body as SafeQuoteBody).id,
            ],
          },
        },
      });
      expect(rows).toHaveLength(2);
      expect(new Set(rows.map((row) => row.number)).size).toBe(2);
    }, 30000);
  });

  // ==================================================================
  // §40 No consumo de secuencia en solicitudes rechazadas
  // ==================================================================
  describe('no consumo de secuencia en solicitudes rechazadas', () => {
    it('cliente genérico, cliente inactivo, productos duplicados, producto inactivo y cantidad inválida no avanzan currentNumber', async () => {
      const before = await currentSequenceNumber();

      await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerId: genericCustomerId }));
      await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerId: inactiveCustomer.id }));
      await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [
              { productId: productA.id, quantity: '1.000' },
              { productId: productA.id, quantity: '2.000' },
            ],
          }),
        );
      await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: productInactive.id, quantity: '1.000' }],
          }),
        );
      await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(
          validCreateBody({
            items: [{ productId: productA.id, quantity: '0' }],
          }),
        );

      const after = await currentSequenceNumber();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // §41 Paginación
  // ==================================================================
  describe('paginación', () => {
    beforeAll(async () => {
      for (let i = 0; i < 5; i += 1) {
        await createQuote(adminCookie, { customerId: paginationCustomer.id });
      }
    });

    it('default page/limit, explícitos, total/totalPages y página vacía, todo filtrado por customerId', async () => {
      const defaults = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ customerId: paginationCustomer.id })
        .set('Cookie', adminCookie);
      const defaultsBody =
        defaults.body as PaginatedBody<SafeQuoteListItemBody>;
      expect(defaultsBody.page).toBe(1);
      expect(defaultsBody.limit).toBe(20);
      expect(defaultsBody.total).toBe(5);
      expect(defaultsBody.totalPages).toBe(1);
      expect(defaultsBody.data).toHaveLength(5);

      const limited = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ customerId: paginationCustomer.id, page: 2, limit: 2 })
        .set('Cookie', adminCookie);
      const limitedBody = limited.body as PaginatedBody<SafeQuoteListItemBody>;
      expect(limitedBody.page).toBe(2);
      expect(limitedBody.limit).toBe(2);
      expect(limitedBody.total).toBe(5);
      expect(limitedBody.totalPages).toBe(3);
      expect(limitedBody.data).toHaveLength(2);

      const lastPage = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ customerId: paginationCustomer.id, page: 3, limit: 2 })
        .set('Cookie', adminCookie);
      expect(
        (lastPage.body as PaginatedBody<SafeQuoteListItemBody>).data,
      ).toHaveLength(1);

      const emptyPage = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ customerId: paginationCustomer.id, page: 10, limit: 2 })
        .set('Cookie', adminCookie);
      const emptyBody = emptyPage.body as PaginatedBody<SafeQuoteListItemBody>;
      expect(emptyBody.data).toEqual([]);
      expect(emptyBody.total).toBe(5);

      // Orden determinista: createdAt desc, id desc.
      const rows = defaultsBody.data;
      for (let i = 1; i < rows.length; i += 1) {
        expect(
          new Date(rows[i - 1].createdAt).getTime(),
        ).toBeGreaterThanOrEqual(new Date(rows[i].createdAt).getTime());
      }
    });
  });

  // ==================================================================
  // §42 Búsqueda
  // ==================================================================
  describe('búsqueda', () => {
    let searchQuoteId: string;
    let searchQuoteNumber: string;

    beforeAll(async () => {
      const body = await createQuote(adminCookie, {
        customerId: searchCustomer.id,
      });
      searchQuoteId = body.id;
      searchQuoteNumber = body.number;
    });

    it('búsqueda case-insensitive por número, nombre de cliente y documento', async () => {
      const byNumber = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ search: searchQuoteNumber.toLowerCase() })
        .set('Cookie', adminCookie);
      expect(
        (byNumber.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === searchQuoteId,
        ),
      ).toBe(true);

      const byName = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ search: searchCustomer.name.toUpperCase() })
        .set('Cookie', adminCookie);
      expect(
        (byName.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === searchQuoteId,
        ),
      ).toBe(true);

      const byDocument = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ search: searchCustomer.documentNumber.toLowerCase() })
        .set('Cookie', adminCookie);
      expect(
        (byDocument.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === searchQuoteId,
        ),
      ).toBe(true);
    });

    it('search en blanco produce el mismo total que omitirlo (para el mismo filtro de cliente)', async () => {
      const withBlankSearch = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ customerId: searchCustomer.id, search: '   ' })
        .set('Cookie', adminCookie);
      const withoutSearch = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ customerId: searchCustomer.id })
        .set('Cookie', adminCookie);
      expect(
        (withBlankSearch.body as PaginatedBody<SafeQuoteListItemBody>).total,
      ).toBe(
        (withoutSearch.body as PaginatedBody<SafeQuoteListItemBody>).total,
      );
    });
  });

  // ==================================================================
  // §43 Filtros
  // ==================================================================
  describe('filtros', () => {
    it('customerId y sellerId filtran correctamente', async () => {
      const byCustomer = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ customerId: companyActive.id })
        .set('Cookie', adminCookie);
      const rows = (byCustomer.body as PaginatedBody<SafeQuoteListItemBody>)
        .data;
      expect(rows.length).toBeGreaterThan(0);
      expect(rows.every((row) => row.customerId === companyActive.id)).toBe(
        true,
      );

      const bySeller = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ sellerId })
        .set('Cookie', adminCookie);
      const sellerRows = (bySeller.body as PaginatedBody<SafeQuoteListItemBody>)
        .data;
      expect(sellerRows.every((row) => row.sellerId === sellerId)).toBe(true);
    });

    it('rango de fechas de emisión y vencimiento; combinación inválida → 400', async () => {
      const today = businessToday();
      const inRange = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({
          issueDateFrom: addDaysToDateOnly(today, -1),
          issueDateTo: addDaysToDateOnly(today, 1),
        })
        .set('Cookie', adminCookie);
      expect(inRange.status).toBe(200);

      const invalidIssueRange = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({
          issueDateFrom: addDaysToDateOnly(today, 5),
          issueDateTo: addDaysToDateOnly(today, 1),
        })
        .set('Cookie', adminCookie);
      expect(invalidIssueRange.status).toBe(400);

      const invalidExpirationRange = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({
          expirationDateFrom: addDaysToDateOnly(today, 5),
          expirationDateTo: addDaysToDateOnly(today, 1),
        })
        .set('Cookie', adminCookie);
      expect(invalidExpirationRange.status).toBe(400);
    });

    it('status EXPIRED incluye lo derivado y lo almacenado; PENDING excluye lo vencido; REJECTED no se ve afectado por el vencimiento', async () => {
      const listExpired = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.EXPIRED, limit: 100 })
        .set('Cookie', adminCookie);
      const expiredIds = (
        listExpired.body as PaginatedBody<SafeQuoteListItemBody>
      ).data.map((row) => row.id);
      expect(expiredIds).toContain(derivedExpiredQuoteId);
      expect(expiredIds).toContain(storedExpiredQuoteId);

      const listPending = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.PENDING, limit: 100 })
        .set('Cookie', adminCookie);
      const pendingIds = (
        listPending.body as PaginatedBody<SafeQuoteListItemBody>
      ).data.map((row) => row.id);
      expect(pendingIds).not.toContain(derivedExpiredQuoteId);

      // ACCEPTED que ya venció: excluido de status=ACCEPTED, incluido en status=EXPIRED.
      const acceptedThenExpired = await createQuote(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/quotes/${acceptedThenExpired.id}/accept`)
        .set('Cookie', adminCookie);
      await prisma.quote.update({
        where: { id: acceptedThenExpired.id },
        data: {
          issueDate: new Date(
            `${addDaysToDateOnly(businessToday(), -2)}T00:00:00.000Z`,
          ),
          expirationDate: new Date(
            `${addDaysToDateOnly(businessToday(), -1)}T00:00:00.000Z`,
          ),
        },
      });
      const listAccepted = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.ACCEPTED, limit: 100 })
        .set('Cookie', adminCookie);
      expect(
        (listAccepted.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === acceptedThenExpired.id,
        ),
      ).toBe(false);
      const listExpiredAgain = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.EXPIRED, limit: 100 })
        .set('Cookie', adminCookie);
      expect(
        (
          listExpiredAgain.body as PaginatedBody<SafeQuoteListItemBody>
        ).data.some((row) => row.id === acceptedThenExpired.id),
      ).toBe(true);

      // REJECTED con fecha de vencimiento pasada sigue apareciendo en status=REJECTED.
      const rejectedThenExpired = await createQuote(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/quotes/${rejectedThenExpired.id}/reject`)
        .set('Cookie', adminCookie);
      await prisma.quote.update({
        where: { id: rejectedThenExpired.id },
        data: {
          issueDate: new Date(
            `${addDaysToDateOnly(businessToday(), -2)}T00:00:00.000Z`,
          ),
          expirationDate: new Date(
            `${addDaysToDateOnly(businessToday(), -1)}T00:00:00.000Z`,
          ),
        },
      });
      const listRejected = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .query({ status: QuoteStatus.REJECTED, limit: 100 })
        .set('Cookie', adminCookie);
      expect(
        (listRejected.body as PaginatedBody<SafeQuoteListItemBody>).data.some(
          (row) => row.id === rejectedThenExpired.id,
        ),
      ).toBe(true);
    });
  });

  // ==================================================================
  // §12 / §44 / §45 / §46 Matriz de roles — HTTP real
  // ==================================================================
  describe('matriz de roles (HTTP real)', () => {
    it('ADMIN: permitido en los 7', async () => {
      const created = await createQuote(adminCookie);
      const server = app.getHttpServer();
      expect(
        (await request(server).get('/api/v1/quotes').set('Cookie', adminCookie))
          .status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/quotes/${created.id}`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .patch(`/api/v1/quotes/${created.id}`)
            .set('Cookie', adminCookie)
            .send({ notes: 'admin' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/quotes/${created.id}/print`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/quotes/${created.id}/accept`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);

      const another = await createQuote(adminCookie);
      expect(
        (
          await request(server)
            .post(`/api/v1/quotes/${another.id}/reject`)
            .set('Cookie', adminCookie)
        ).status,
      ).toBe(200);
    });

    it('SELLER: acceso Total en los 7, sin restricción de propiedad (opera cotizaciones creadas por otro emisor)', async () => {
      const createdByAdmin = await createQuote(adminCookie);
      const server = app.getHttpServer();

      expect(
        (
          await request(server)
            .get('/api/v1/quotes')
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/quotes/${createdByAdmin.id}`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .patch(`/api/v1/quotes/${createdByAdmin.id}`)
            .set('Cookie', sellerCookie)
            .send({ notes: 'seller opera sobre admin' })
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/quotes/${createdByAdmin.id}/print`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .post(`/api/v1/quotes/${createdByAdmin.id}/accept`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);

      const createByAdminForReject = await createQuote(adminCookie);
      expect(
        (
          await request(server)
            .post(`/api/v1/quotes/${createByAdminForReject.id}/reject`)
            .set('Cookie', sellerCookie)
        ).status,
      ).toBe(200);

      const createdBySeller = await createQuote(sellerCookie);
      expect(createdBySeller.seller.id).toBe(sellerId);
    });

    it('MANAGEMENT: list/detail/print → 200; create/update/accept/reject → 403 sin mutar nada', async () => {
      const created = await createQuote(adminCookie);
      const server = app.getHttpServer();

      expect(
        (
          await request(server)
            .get('/api/v1/quotes')
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/quotes/${created.id}`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(200);
      expect(
        (
          await request(server)
            .get(`/api/v1/quotes/${created.id}/print`)
            .set('Cookie', managementCookie)
        ).status,
      ).toBe(200);

      const createAttempt = await request(server)
        .post('/api/v1/quotes')
        .set('Cookie', managementCookie)
        .send(validCreateBody());
      expect(createAttempt.status).toBe(403);

      const updateAttempt = await request(server)
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', managementCookie)
        .send({ notes: 'no debería aplicarse' });
      expect(updateAttempt.status).toBe(403);

      const acceptAttempt = await request(server)
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', managementCookie);
      expect(acceptAttempt.status).toBe(403);

      const rejectAttempt = await request(server)
        .post(`/api/v1/quotes/${created.id}/reject`)
        .set('Cookie', managementCookie);
      expect(rejectAttempt.status).toBe(403);

      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(row.status).toBe(QuoteStatus.PENDING);
      expect(row.notes).not.toBe('no debería aplicarse');
    });

    it('WAREHOUSE: 403 en los 7', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server)
          .post('/api/v1/quotes')
          .set('Cookie', warehouseCookie)
          .send(validCreateBody()),
        request(server).get('/api/v1/quotes').set('Cookie', warehouseCookie),
        request(server)
          .get(`/api/v1/quotes/${id}`)
          .set('Cookie', warehouseCookie),
        request(server)
          .patch(`/api/v1/quotes/${id}`)
          .set('Cookie', warehouseCookie)
          .send({ notes: 'x' }),
        request(server)
          .post(`/api/v1/quotes/${id}/accept`)
          .set('Cookie', warehouseCookie),
        request(server)
          .post(`/api/v1/quotes/${id}/reject`)
          .set('Cookie', warehouseCookie),
        request(server)
          .get(`/api/v1/quotes/${id}/print`)
          .set('Cookie', warehouseCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(403);
      }
    });
  });

  // ==================================================================
  // §47 Contrato de respuesta seguro
  // ==================================================================
  describe('contrato de respuesta seguro', () => {
    it('create/detail/update/accept/reject exponen exactamente las claves de SafeQuote', async () => {
      const created = await createQuote(adminCookie);
      expect(Object.keys(created).sort()).toEqual(SAFE_QUOTE_DETAIL_KEYS);
      expect(Object.keys(created.seller).sort()).toEqual(
        SAFE_QUOTE_SELLER_KEYS,
      );
      expect(Object.keys(created.items[0]).sort()).toEqual(
        SAFE_QUOTE_ITEM_KEYS,
      );
      if (created.items[0].stockInfo !== null) {
        expect(Object.keys(created.items[0].stockInfo).sort()).toEqual(
          SAFE_STOCK_INFO_KEYS,
        );
      }
      assertNoLeakage({ body: created });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie);
      expect(Object.keys(detail.body as object).sort()).toEqual(
        SAFE_QUOTE_DETAIL_KEYS,
      );

      const update = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'contrato' });
      expect(Object.keys(update.body as object).sort()).toEqual(
        SAFE_QUOTE_DETAIL_KEYS,
      );

      const accept = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', adminCookie);
      expect(Object.keys(accept.body as object).sort()).toEqual(
        SAFE_QUOTE_DETAIL_KEYS,
      );

      const another = await createQuote(adminCookie);
      const reject = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${another.id}/reject`)
        .set('Cookie', adminCookie);
      expect(Object.keys(reject.body as object).sort()).toEqual(
        SAFE_QUOTE_DETAIL_KEYS,
      );
    });

    it('list item expone exactamente las claves de SafeQuoteListItem, sin items ni seller completo', async () => {
      await createQuote(adminCookie);
      const list = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .set('Cookie', adminCookie);
      const body = list.body as PaginatedBody<SafeQuoteListItemBody>;
      expect(body.data.length).toBeGreaterThan(0);
      expect(Object.keys(body.data[0]).sort()).toEqual(
        SAFE_QUOTE_LIST_ITEM_KEYS,
      );
      expect(Object.keys(body.data[0])).not.toContain('items');
      expect(Object.keys(body.data[0])).not.toContain('seller');
    });
  });

  // ==================================================================
  // §48/§49/§50 Auditoría — create / update
  // ==================================================================
  describe('auditoría — create', () => {
    it('metadata exactamente quoteNumber/customerId/itemCount, sin PII ni montos', async () => {
      const created = await createQuote(adminCookie);
      const rows = await fetchQuoteAuditRows(
        AuditAction.QUOTE_CREATED,
        created.id,
      );
      expect(rows).toHaveLength(1);
      const row = rows[0];
      expect(row.userId).toBe(adminId);
      expect(row.module).toBe('QUOTES');
      const metadata = row.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        ['customerId', 'itemCount', 'quoteNumber'].sort(),
      );
      expect(metadata.quoteNumber).toBe(created.number);
      expect(metadata.customerId).toBe(created.customerId);
      expect(metadata.itemCount).toBe(1);

      const serialized = JSON.stringify({
        description: row.description,
        metadata: row.metadata,
      });
      expect(serialized).not.toContain(created.customerName);
      expect(serialized).not.toContain('notes');
      expect(serialized).not.toContain('subtotal');
      expect(serialized).not.toContain('discountAmount');
      expect(serialized).not.toContain('taxAmount');
      assertAuditRowHasNoSecrets({
        description: row.description,
        metadata: row.metadata,
      });
    });
  });

  describe('auditoría — update', () => {
    it('metadata exactamente quoteNumber/updatedFields/itemCount; updatedFields solo nombres; incluye "items" al reemplazar', async () => {
      const created = await createQuote(adminCookie);
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({
          notes: 'auditoría',
          items: [{ productId: productA.id, quantity: '2.000' }],
        });
      expect(response.status).toBe(200);

      const rows = await fetchQuoteAuditRows(
        AuditAction.QUOTE_UPDATED,
        created.id,
      );
      expect(rows).toHaveLength(1);
      const metadata = rows[0].metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        ['quoteNumber', 'updatedFields', 'itemCount'].sort(),
      );
      expect(metadata.updatedFields).toContain('notes');
      expect(metadata.updatedFields).toContain('items');
      expect(
        (metadata.updatedFields as string[]).every(
          (v) => typeof v === 'string',
        ),
      ).toBe(true);
      expect(metadata).not.toHaveProperty('subtotal');
      expect(metadata).not.toHaveProperty('taxAmount');
      expect(metadata).not.toHaveProperty('total');
    });
  });

  describe('auditoría — sin rastro para operaciones de solo lectura', () => {
    it('list/detail/print no generan filas de AuditLog', async () => {
      const created = await createQuote(adminCookie);
      const beforeCount = await prisma.auditLog.count({
        where: { entityType: 'Quote', entityId: created.id },
      });
      await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}/print`)
        .set('Cookie', adminCookie);
      const afterCount = await prisma.auditLog.count({
        where: { entityType: 'Quote', entityId: created.id },
      });
      expect(afterCount).toBe(beforeCount);
    });
  });

  // ==================================================================
  // §51 Atomicidad de mutaciones fallidas
  // ==================================================================
  describe('atomicidad de mutaciones fallidas', () => {
    it('transición inválida (accept sobre REJECTED) no altera la fila ni genera auditoría nueva', async () => {
      const created = await createQuote(adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/reject`)
        .set('Cookie', adminCookie);
      const before = await prisma.quote.findUniqueOrThrow({
        where: { id: created.id },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);

      const after = await prisma.quote.findUniqueOrThrow({
        where: { id: created.id },
      });
      expect(after.status).toBe(before.status);
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      const acceptAudits = await fetchQuoteAuditRows(
        AuditAction.QUOTE_ACCEPTED,
        created.id,
      );
      expect(acceptAudits).toHaveLength(0);
    });

    it('PATCH sobre EXPIRED efectivo no altera notes/discountAmount ni genera auditoría nueva', async () => {
      const before = await prisma.quote.findUniqueOrThrow({
        where: { id: derivedExpiredQuoteId },
      });
      const auditCountBefore = await prisma.auditLog.count({
        where: {
          action: AuditAction.QUOTE_UPDATED,
          entityType: 'Quote',
          entityId: derivedExpiredQuoteId,
        },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${derivedExpiredQuoteId}`)
        .set('Cookie', adminCookie)
        .send({ notes: 'no debería aplicarse', discountAmount: '5.00' });
      expect(response.status).toBe(409);

      const after = await prisma.quote.findUniqueOrThrow({
        where: { id: derivedExpiredQuoteId },
      });
      expect(after.notes).toBe(before.notes);
      expect(after.discountAmount.toFixed(2)).toBe(
        before.discountAmount.toFixed(2),
      );
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      const auditCountAfter = await prisma.auditLog.count({
        where: {
          action: AuditAction.QUOTE_UPDATED,
          entityType: 'Quote',
          entityId: derivedExpiredQuoteId,
        },
      });
      expect(auditCountAfter).toBe(auditCountBefore);
    });

    it('cliente genérico rechazado no crea Quote ni consume secuencia', async () => {
      const before = await currentSequenceNumber();
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerId: genericCustomerId }));
      expect(response.status).toBe(409);
      const after = await currentSequenceNumber();
      expect(after).toBe(before);
      const orphanQuotes = await prisma.quote.count({
        where: { customerId: genericCustomerId },
      });
      expect(orphanQuotes).toBe(0);
    });
  });

  // ==================================================================
  // §52/§53/§54 Endpoint de impresión
  // ==================================================================
  describe('endpoint de impresión', () => {
    it('200, Content-Type text/html, cuerpo no vacío con número/cliente/producto/totales, sin stockInfo ni notas internas', async () => {
      const created = await createQuote(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}/print`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.text).toContain(created.number);
      expect(response.text).toContain(created.customerName);
      expect(response.text).toContain(created.items[0].productName);
      expect(response.text).toContain(created.total);
      expect(response.text.toLowerCase()).not.toMatch(
        /currentstock|requestedquantity|sufficient/,
      );
      expect(response.text).not.toMatch(/internalNotes/i);
    });

    it('MANAGEMENT → 200; WAREHOUSE → 403', async () => {
      const created = await createQuote(adminCookie);
      const managementResponse = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}/print`)
        .set('Cookie', managementCookie);
      expect(managementResponse.status).toBe(200);

      const warehouseResponse = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}/print`)
        .set('Cookie', warehouseCookie);
      expect(warehouseResponse.status).toBe(403);
    });

    it('conserva el snapshot histórico incluso tras mutar Customer/Product/Unit vivos', async () => {
      const created = await createQuote(adminCookie, {
        customerId: personActive.id,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const originalCustomerName = created.customerName;
      const originalProductName = created.items[0].productName;

      await prisma.customer.update({
        where: { id: personActive.id },
        data: { name: 'Cliente Vivo Cambiado Print' },
      });
      await prisma.product.update({
        where: { id: productA.id },
        data: { name: 'Producto Vivo Cambiado Print' },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}/print`)
        .set('Cookie', adminCookie);
      expect(response.text).toContain(originalCustomerName);
      expect(response.text).toContain(originalProductName);
      expect(response.text).not.toContain('Cliente Vivo Cambiado Print');
      expect(response.text).not.toContain('Producto Vivo Cambiado Print');

      // Restaura para no afectar otras secciones que reutilizan personActive/productA por nombre.
      await prisma.customer.update({
        where: { id: personActive.id },
        data: { name: originalCustomerName },
      });
      await prisma.product.update({
        where: { id: productA.id },
        data: { name: originalProductName },
      });
    });

    it('escapa HTML: XSS en snapshot de cliente y en notas, sin etiquetas ejecutables', async () => {
      const created = await createQuote(adminCookie, {
        customerId: xssCustomer.id,
        notes: `<script>alert(1)</script> A&B "quoted" O'Brien <danger>`,
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${created.id}/print`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);

      expect(response.text).not.toContain('<script>alert(1)</script>');
      expect(response.text).not.toContain('<danger>');
      expect(response.text.toLowerCase()).not.toContain('<script>alert');

      expect(response.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(response.text).toContain('A&amp;B');
      expect(response.text).toContain('&quot;quoted&quot;');
      expect(response.text).toContain('O&#39;Brien');
      expect(response.text).toContain('&lt;danger&gt;');
    });
  });

  // ==================================================================
  // §55 Restricciones directas de PostgreSQL — 16 CHECK
  // ==================================================================
  describe('restricciones directas de PostgreSQL — 16 CHECK constraints', () => {
    let checkQuoteId: string;

    beforeAll(async () => {
      checkQuoteId = await directValidQuote(`CHK-BASE-${nextSuffix()}`);
    });

    it('1. quotes_subtotal_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK1-${nextSuffix()}`,
            subtotal: '-1',
            discountAmount: '0',
            taxAmount: '0',
            total: '-1',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23514',
      );
    });

    it('2. quotes_discount_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK2-${nextSuffix()}`,
            subtotal: '100',
            discountAmount: '-1',
            taxAmount: '0',
            total: '101',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23514',
      );
    });

    it('3. quotes_tax_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK3-${nextSuffix()}`,
            subtotal: '100',
            discountAmount: '0',
            taxAmount: '-1',
            total: '99',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23514',
      );
    });

    it('4. quotes_total_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK4-${nextSuffix()}`,
            subtotal: '5',
            discountAmount: '0',
            taxAmount: '0',
            total: '-5',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23514',
      );
    });

    it('5. quotes_discount_within_subtotal', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK5-${nextSuffix()}`,
            subtotal: '10',
            discountAmount: '20',
            taxAmount: '0',
            total: '-10',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23514',
      );
    });

    it('6. quotes_total_arithmetic', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK6-${nextSuffix()}`,
            subtotal: '100',
            discountAmount: '0',
            taxAmount: '0',
            total: '999',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23514',
      );
    });

    it('7. quotes_expiration_after_issue', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK7-${nextSuffix()}`,
            subtotal: '100',
            discountAmount: '0',
            taxAmount: '0',
            total: '100',
            issueDate: businessToday(),
            expirationDate: addDaysToDateOnly(businessToday(), -1),
          }),
        '23514',
      );
    });

    it('8. quotes_number_not_blank', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: '   ',
            subtotal: '100',
            discountAmount: '0',
            taxAmount: '0',
            total: '100',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23514',
      );
    });

    it('9. quotes_customer_document_pair', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuote({
            number: `CHK9-${nextSuffix()}`,
            subtotal: '100',
            discountAmount: '0',
            taxAmount: '0',
            total: '100',
            issueDate: businessToday(),
            expirationDate: businessToday(),
            customerDocumentType: CustomerDocumentType.DNI,
            customerDocumentNumber: null,
          }),
        '23514',
      );
    });

    it('10. quote_items_quantity_positive', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuoteItem({
            quoteId: checkQuoteId,
            productId: productA.id,
            quantity: '0',
            unitPrice: '10.00',
            lineTotal: '0.00',
          }),
        '23514',
      );
    });

    it('11. quote_items_unit_price_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuoteItem({
            quoteId: checkQuoteId,
            productId: productA.id,
            quantity: '1',
            unitPrice: '-5.00',
            lineTotal: '-5.00',
          }),
        '23514',
      );
    });

    it('12. quote_items_line_total_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuoteItem({
            quoteId: checkQuoteId,
            productId: productA.id,
            quantity: '1',
            unitPrice: '5.00',
            lineTotal: '-5.00',
          }),
        '23514',
      );
    });

    it('13. quote_items_line_arithmetic', async () => {
      await expectPgRejection(
        () =>
          rawInsertQuoteItem({
            quoteId: checkQuoteId,
            productId: productA.id,
            quantity: '2',
            unitPrice: '5.00',
            lineTotal: '999.00',
          }),
        '23514',
      );
    });

    it('ninguna de las 4 pruebas anteriores dejó QuoteItem persistido', async () => {
      const count = await prisma.quoteItem.count({
        where: { quoteId: checkQuoteId },
      });
      expect(count).toBe(0);
    });

    it('14. document_sequences_current_number_non_negative', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO document_sequences (id, document_type, prefix, current_number, padding, updated_at)
            VALUES (gen_random_uuid(), 'SALE', 'NV-', -1, 6, now())
          `,
        '23514',
      );
      expect(
        await prisma.documentSequence.count({
          where: { documentType: DocumentType.SALE },
        }),
      ).toBe(0);
    });

    it('15. document_sequences_padding_range', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO document_sequences (id, document_type, prefix, current_number, padding, updated_at)
            VALUES (gen_random_uuid(), 'SALE', 'NV-', 0, 0, now())
          `,
        '23514',
      );
      expect(
        await prisma.documentSequence.count({
          where: { documentType: DocumentType.SALE },
        }),
      ).toBe(0);
    });

    it('16. document_sequences_prefix_not_blank', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO document_sequences (id, document_type, prefix, current_number, padding, updated_at)
            VALUES (gen_random_uuid(), 'SALE', '   ', 0, 6, now())
          `,
        '23514',
      );
      expect(
        await prisma.documentSequence.count({
          where: { documentType: DocumentType.SALE },
        }),
      ).toBe(0);
    });

    it('la conexión sigue siendo utilizable tras los 16 rechazos anteriores', async () => {
      const result = await prisma.$queryRaw<{ ok: number }[]>`SELECT 1 AS ok`;
      expect(result[0].ok).toBe(1);
    });
  });

  // ==================================================================
  // §56/§57/§58 Unicidad directa
  // ==================================================================
  describe('unicidad directa: número de cotización, producto por cotización, tipo de documento', () => {
    it('§56 número de cotización único: segundo INSERT con el mismo number → 23505, limpiado de inmediato', async () => {
      const number = `CHK-NUM-${nextSuffix()}`;
      const firstId = await directValidQuote(number);

      await expectPgRejection(
        () =>
          rawInsertQuote({
            number,
            subtotal: '0',
            discountAmount: '0',
            taxAmount: '0',
            total: '0',
            issueDate: businessToday(),
            expirationDate: businessToday(),
          }),
        '23505',
      );

      await prisma.quote.delete({ where: { id: firstId } });
      directQuoteIds.splice(directQuoteIds.indexOf(firstId), 1);
      expect(await prisma.quote.count({ where: { number } })).toBe(0);
    });

    it('§57 UNIQUE(quote_id, product_id): segundo ítem del mismo producto en la misma cotización → 23505; el mismo producto SÍ puede estar en otra cotización', async () => {
      const quoteOneId = await directValidQuote(`CHK-DUP-A-${nextSuffix()}`);
      await rawInsertQuoteItem({
        quoteId: quoteOneId,
        productId: productA.id,
        quantity: '1',
        unitPrice: '10.00',
        lineTotal: '10.00',
      });

      await expectPgRejection(
        () =>
          rawInsertQuoteItem({
            quoteId: quoteOneId,
            productId: productA.id,
            quantity: '2',
            unitPrice: '10.00',
            lineTotal: '20.00',
          }),
        '23505',
      );

      const quoteTwoId = await directValidQuote(`CHK-DUP-B-${nextSuffix()}`);
      await rawInsertQuoteItem({
        quoteId: quoteTwoId,
        productId: productA.id,
        quantity: '1',
        unitPrice: '10.00',
        lineTotal: '10.00',
      });
      expect(
        await prisma.quoteItem.count({
          where: { quoteId: quoteTwoId, productId: productA.id },
        }),
      ).toBe(1);
    });

    it('§58 DocumentSequence.documentType único: un segundo QUOTE → 23505; sin fila SALE remanente', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO document_sequences (id, document_type, prefix, current_number, padding, updated_at)
            VALUES (gen_random_uuid(), 'QUOTE', 'COT-', 0, 6, now())
          `,
        '23505',
      );
      expect(
        await prisma.documentSequence.count({
          where: { documentType: DocumentType.QUOTE },
        }),
      ).toBe(1);
      expect(
        await prisma.documentSequence.count({
          where: { documentType: DocumentType.SALE },
        }),
      ).toBe(0);
    });
  });

  // ==================================================================
  // §59 Comportamiento FK
  // ==================================================================
  describe('comportamiento de claves foráneas', () => {
    it('eliminar una Quote propia elimina en cascada sus QuoteItems', async () => {
      const created = await createQuote(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const itemsBefore = await prisma.quoteItem.count({
        where: { quoteId: created.id },
      });
      expect(itemsBefore).toBeGreaterThan(0);

      await prisma.quote.delete({ where: { id: created.id } });

      const itemsAfter = await prisma.quoteItem.count({
        where: { quoteId: created.id },
      });
      expect(itemsAfter).toBe(0);
    });

    it('no se puede eliminar un Customer referenciado por una Quote existente', async () => {
      const created = await createQuote(adminCookie, {
        customerId: companyActive.id,
      });
      await expectClientFkRejection(() =>
        prisma.customer.delete({ where: { id: companyActive.id } }),
      );
      // La cotización creada para esta prueba permanece; se limpia en el afterAll global.
      expect(
        (await prisma.quote.findUnique({ where: { id: created.id } }))?.id,
      ).toBe(created.id);
    });

    it('no se puede eliminar un Product referenciado por un QuoteItem existente', async () => {
      const dedicatedProduct = await prisma.product.create({
        data: {
          sku: `E2EQ-FK-${nextSuffix()}`,
          name: `Producto FK E2E ${nextSuffix()}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('9.99'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('100.000'),
        },
      });
      createdProductIds.push(dedicatedProduct.id);

      await createQuote(adminCookie, {
        items: [{ productId: dedicatedProduct.id, quantity: '1.000' }],
      });

      await expectClientFkRejection(() =>
        prisma.product.delete({ where: { id: dedicatedProduct.id } }),
      );
    });
  });

  // ==================================================================
  // §60 Seguridad de errores HTTP
  // ==================================================================
  describe('seguridad de errores HTTP', () => {
    it('400/403/404/409 no filtran códigos Prisma, SQLSTATE, nombres de constraint ni SQL crudo', async () => {
      const badPayload = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send({});
      expect(badPayload.status).toBe(400);
      assertNoLeakage(badPayload);

      const forbidden = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', warehouseCookie)
        .send(validCreateBody());
      expect(forbidden.status).toBe(403);
      assertNoLeakage(forbidden);

      const notFound = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie);
      expect(notFound.status).toBe(404);
      assertNoLeakage(notFound);

      const conflict = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send(validCreateBody({ customerId: genericCustomerId }));
      expect(conflict.status).toBe(409);
      assertNoLeakage(conflict);
    });
  });

  // ==================================================================
  // §63 Regresión de Swagger
  // ==================================================================
  describe('regresión de Swagger', () => {
    it('7 operaciones Quotes en 5 paths únicos; sin DELETE/PUT/convert; print documenta text/html', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');
      expect(response.status).toBe(200);
      const doc = response.body as {
        tags: { name: string }[];
        paths: Record<string, Record<string, unknown>>;
      };
      expect(doc.tags.some((tag) => tag.name === 'Quotes')).toBe(true);

      const quotePaths = Object.keys(doc.paths).filter((path) =>
        path.includes('quotes'),
      );
      expect(new Set(quotePaths).size).toBe(5);
      let totalOps = 0;
      for (const path of quotePaths) {
        totalOps += Object.keys(doc.paths[path]).length;
        expect(Object.keys(doc.paths[path])).not.toContain('delete');
        expect(Object.keys(doc.paths[path])).not.toContain('put');
      }
      expect(totalOps).toBe(7);
      expect(quotePaths.some((path) => path.includes('convert'))).toBe(false);

      const printOp = doc.paths['/api/v1/quotes/{id}/print']?.get as
        | { responses?: Record<string, { content?: Record<string, unknown> }> }
        | undefined;
      const printContentTypes = Object.keys(
        printOp?.responses?.['200']?.content ?? {},
      );
      expect(printContentTypes).toContain('text/html');
    });
  });

  // ==================================================================
  // §64 No efecto en inventario
  // ==================================================================
  describe('no efecto en inventario', () => {
    it('crear, actualizar, aceptar y rechazar cotizaciones nunca crea InventoryMovement ni referencia Quote', async () => {
      const before = await prisma.inventoryMovement.count();

      const created = await createQuote(adminCookie, {
        items: [{ productId: productStockHigh.id, quantity: '5.000' }],
      });
      await request(app.getHttpServer())
        .patch(`/api/v1/quotes/${created.id}`)
        .set('Cookie', adminCookie)
        .send({
          items: [{ productId: productStockHigh.id, quantity: '10.000' }],
        });
      await request(app.getHttpServer())
        .post(`/api/v1/quotes/${created.id}/accept`)
        .set('Cookie', adminCookie);

      const another = await createQuote(adminCookie, {
        items: [{ productId: productStockHigh.id, quantity: '1.000' }],
      });
      await request(app.getHttpServer())
        .post(`/api/v1/quotes/${another.id}/reject`)
        .set('Cookie', adminCookie);

      const after = await prisma.inventoryMovement.count();
      expect(after).toBe(before);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productStockHigh.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('100.000');

      const quoteReferencedMovements = await prisma.inventoryMovement.count({
        where: { OR: [{ referenceType: 'Quote' }, { referenceType: 'QUOTE' }] },
      });
      expect(quoteReferencedMovements).toBe(0);
    });
  });
});
