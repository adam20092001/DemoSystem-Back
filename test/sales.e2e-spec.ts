import { INestApplication } from '@nestjs/common';
import {
  CategoryStatus,
  CustomerDocumentType,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  InventoryMovementOrigin,
  InventoryMovementType,
  PaymentCancellationSource,
  PaymentMethod,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  QuoteStatus,
  RoleName,
  SaleDeliveryStatus,
  SalePaymentStatus,
  SaleStatus,
  UnitStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import {
  businessToday,
  endOfBusinessDayExclusiveUtc,
  fromPrismaDate,
  startOfBusinessDayUtc,
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

const SELLER_USERNAME = 'e2e_seller_sales';
const SELLER_PASSWORD = 'SellerSales123';
const MANAGEMENT_USERNAME = 'e2e_management_sales';
const MANAGEMENT_PASSWORD = 'ManagementSales123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_sales';
const WAREHOUSE_PASSWORD = 'WarehouseSales123';
const FK_USER_USERNAME = 'e2e_fkuser_sales';
const FK_USER_PASSWORD = 'FkUserSales123';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const INVALID_UUID = 'not-a-uuid';
const TEST_GENERIC_CODE = 'PUBLIC_GENERAL';

const SAFE_SALE_DETAIL_KEYS = [
  'id',
  'number',
  'status',
  'paymentStatus',
  'deliveryStatus',
  'customerId',
  'customerIsGeneric',
  'customerType',
  'customerDocumentType',
  'customerDocumentNumber',
  'customerName',
  'customerAddress',
  'seller',
  'quote',
  'subtotal',
  'discountAmount',
  'taxAmount',
  'total',
  'currencyCode',
  'taxEnabled',
  'taxRate',
  // R2-B4: contrato aditivo del detalle (el listado no cambia).
  'pricesIncludeTax',
  'itemsTotal',
  'customerDiscountAmount',
  'taxableBase',
  'paidAmount',
  'balanceDue',
  'items',
  'inventoryMovements',
  // Fase 7, Bloque B: SafeSale gana `payments[]` (historial ACTIVE +
  // CANCELLED). Ningún DTO HTTP acepta `payment` todavía (llega en el
  // Bloque C), así que en todas las ventas de este spec queda `[]`.
  'payments',
  'confirmedAt',
  'cancelledAt',
  'cancellationReason',
  'cancelledBy',
  'createdAt',
  'updatedAt',
].sort();

const SAFE_SALE_LIST_ITEM_KEYS = [
  'id',
  'number',
  'status',
  'paymentStatus',
  'deliveryStatus',
  'customerId',
  'customerName',
  'customerDocumentNumber',
  'sellerId',
  'seller',
  'subtotal',
  'discountAmount',
  'taxAmount',
  'total',
  'currencyCode',
  'taxEnabled',
  'taxRate',
  'paidAmount',
  'balanceDue',
  'itemCount',
  'confirmedAt',
  'createdAt',
  'updatedAt',
].sort();

const SAFE_SALE_ITEM_KEYS = [
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
].sort();

const SAFE_SALE_MOVEMENT_KEYS = [
  'id',
  'productId',
  'movementType',
  'origin',
  'quantity',
  'previousStock',
  'newStock',
  'createdAt',
].sort();

const SAFE_SALE_SELLER_KEYS = [
  'id',
  'username',
  'firstName',
  'lastName',
].sort();

interface SafeSaleSellerBody {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

interface SafeSaleItemBody {
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
}

interface SafeSaleMovementBody {
  id: string;
  productId: string;
  movementType: InventoryMovementType;
  origin: InventoryMovementOrigin;
  quantity: string;
  previousStock: string;
  newStock: string;
  createdAt: string;
}

interface SafeSaleBody {
  id: string;
  number: string;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  deliveryStatus: SaleDeliveryStatus;
  customerId: string;
  customerIsGeneric: boolean;
  customerType: CustomerType | null;
  customerDocumentType: CustomerDocumentType | null;
  customerDocumentNumber: string | null;
  customerName: string;
  customerAddress: string | null;
  seller: SafeSaleSellerBody;
  quote: { id: string; number: string } | null;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  balanceDue: string;
  items: SafeSaleItemBody[];
  inventoryMovements: SafeSaleMovementBody[];
  // Fase 7, Bloque B: siempre [] en este spec (sin DTO HTTP para poblarlo
  // todavía). Tipado laxo a propósito: el contrato completo de pago llega
  // en Block C/D con su propio spec.
  payments: unknown[];
  confirmedAt: string;
  cancelledAt: string | null;
  cancellationReason: string | null;
  cancelledBy: SafeSaleSellerBody | null;
  createdAt: string;
  updatedAt: string;
}

interface SafeSaleListItemBody {
  id: string;
  number: string;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  deliveryStatus: SaleDeliveryStatus;
  customerId: string;
  customerName: string;
  customerDocumentNumber: string | null;
  sellerId: string;
  // Fase 9, Bloque A (R1): proyección segura adicional retrocompatible.
  seller: SafeSaleSellerBody;
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  balanceDue: string;
  itemCount: number;
  confirmedAt: string;
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

/** Forma segura de un pago anidado en `SafeSaleBody.payments` (Fase 7, Bloque D). Espejo de PaymentResponseDto. */
interface SafeSalePaymentItem {
  id: string;
  saleId: string;
  method: PaymentMethod;
  amount: string;
  reference: string | null;
  status: PaymentStatus;
  paidAt: string;
  createdBy: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
  };
  cancelledAt: string | null;
  cancellationReason: string | null;
  cancellationSource: PaymentCancellationSource | null;
  cancelledBy: {
    id: string;
    username: string;
    firstName: string;
    lastName: string;
  } | null;
  createdAt: string;
  updatedAt: string;
}

interface FixtureProduct {
  id: string;
  sku: string;
  name: string;
  salePrice: string;
}

interface FixtureCustomer {
  id: string;
  name: string;
}

describe('Sales (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let sellerCookie: string;
  let managementCookie: string;
  let warehouseCookie: string;
  let adminId: string;
  let sellerId: string;
  let fkUserId: string;

  let categoryId: string;
  let categoryInactiveId: string;
  let categoryMutableCancelId: string;
  let categoryMutableConversionId: string;

  let unitDecimalId: string;
  let unitDecimalCode: string;
  let unitDecimalName: string;
  let unitDecimalAbbr: string;
  let unitNoDecimalId: string;
  let unitInactiveId: string;
  let unitMutableCancelId: string;
  let unitMutableConversionId: string;
  let unitAllowDecimalMutableId: string;

  let productA: FixtureProduct;
  let productNoDecimal: FixtureProduct;
  let productService: FixtureProduct;
  let productNonInventory: FixtureProduct;
  let productInactive: FixtureProduct;
  let productBadCategory: FixtureProduct;
  let productBadUnit: FixtureProduct;
  let productRounding: FixtureProduct;
  let productOverflow: FixtureProduct;
  let productOversale: FixtureProduct;
  let productMultiA: FixtureProduct;
  let productMultiB: FixtureProduct;
  let productRaceStock: FixtureProduct;
  let productCancelUnrelatedStock: FixtureProduct;
  let productCancelProductInactive: FixtureProduct;
  let productCancelCategoryInactive: FixtureProduct;
  let productCancelUnitInactive: FixtureProduct;
  let productCancelTrackingChange: FixtureProduct;
  let productCancelFractional: FixtureProduct;
  let productCancelNonInventory: FixtureProduct;
  let productRevalProductInactive: FixtureProduct;
  let productRevalCategoryInactive: FixtureProduct;
  let productRevalUnitInactive: FixtureProduct;
  let productRevalAllowDecimalChange: FixtureProduct;
  let productRevalStockInsufficient: FixtureProduct;
  let productQuoteItemSnapshot: FixtureProduct;
  let productXss: FixtureProduct;
  let productBusinessDate: FixtureProduct;
  let productMixedTracked: FixtureProduct;
  let productMixedNonTracked: FixtureProduct;

  let personActive: FixtureCustomer;
  let companyActive: FixtureCustomer;
  let prospectCustomer: FixtureCustomer;
  let prospectConcurrencyCustomer: FixtureCustomer;
  let prospectFailedCustomer: FixtureCustomer;
  let blockedCustomer: FixtureCustomer;
  let inactiveCustomer: FixtureCustomer;
  let genericCustomerId: string;
  let customerQuoteSnapshot: {
    id: string;
    name: string;
    documentNumber: string;
    address: string;
  };
  let searchCustomer: { id: string; name: string; documentNumber: string };
  let paginationCustomer: FixtureCustomer;
  let xssCustomer: FixtureCustomer;
  let businessDateCustomer: FixtureCustomer;

  const createdProductIds: string[] = [];
  const createdCustomerIds: string[] = [];
  const createdQuoteIds: string[] = [];
  const directQuoteIds: string[] = [];
  const createdSaleIds: string[] = [];
  const directSaleIds: string[] = [];
  // Limpieza siempre por ID, nunca por código/nombre: varias pruebas mutan
  // deliberadamente el código/status en vivo de estas filas (lección de
  // quotes.e2e-spec.ts, §21 de ese archivo).
  const ownedUnitIds: string[] = [];
  const ownedCategoryIds: string[] = [];

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
      email: 'e2e_seller_sales@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_sales@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_sales@demosystem.test',
      password: WAREHOUSE_PASSWORD,
      roleName: RoleName.WAREHOUSE,
    });
    await upsertFixtureUser(prisma, {
      username: FK_USER_USERNAME,
      email: 'e2e_fkuser_sales@demosystem.test',
      password: FK_USER_PASSWORD,
      roleName: RoleName.SELLER,
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
    const fkUser = await prisma.user.findUniqueOrThrow({
      where: { username: FK_USER_USERNAME },
    });
    fkUserId = fkUser.id;

    // ---------------------------------------------------------------
    // Secuencia NV propia del spec: upsert defensivo, eliminada en afterAll.
    // ---------------------------------------------------------------
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

    // ---------------------------------------------------------------
    // Catálogo fixture.
    // ---------------------------------------------------------------
    const category = await prisma.category.upsert({
      where: { code: 'E2ESALCAT' },
      update: { status: CategoryStatus.ACTIVE },
      create: { code: 'E2ESALCAT', name: 'Categoria E2E Sales' },
    });
    categoryId = category.id;
    ownedCategoryIds.push(categoryId);

    const categoryInactive = await prisma.category.upsert({
      where: { code: 'E2ESALCATX' },
      update: { status: CategoryStatus.INACTIVE },
      create: {
        code: 'E2ESALCATX',
        name: 'Categoria E2E Sales Inactiva',
        status: CategoryStatus.INACTIVE,
      },
    });
    categoryInactiveId = categoryInactive.id;
    ownedCategoryIds.push(categoryInactiveId);

    const categoryMutableCancel = await prisma.category.upsert({
      where: { code: 'E2ESALCATMC' },
      update: { status: CategoryStatus.ACTIVE },
      create: {
        code: 'E2ESALCATMC',
        name: 'Categoria E2E Sales Mutable Cancel',
      },
    });
    categoryMutableCancelId = categoryMutableCancel.id;
    ownedCategoryIds.push(categoryMutableCancelId);

    const categoryMutableConversion = await prisma.category.upsert({
      where: { code: 'E2ESALCATMV' },
      update: { status: CategoryStatus.ACTIVE },
      create: {
        code: 'E2ESALCATMV',
        name: 'Categoria E2E Sales Mutable Conversion',
      },
    });
    categoryMutableConversionId = categoryMutableConversion.id;
    ownedCategoryIds.push(categoryMutableConversionId);

    const unitDecimal = await prisma.unit.upsert({
      where: { code: 'E2ESALUD' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2ESALUD',
        name: 'Unidad E2E Sales decimal',
        abbreviation: 'usd',
        allowDecimal: true,
      },
    });
    unitDecimalId = unitDecimal.id;
    unitDecimalCode = unitDecimal.code;
    unitDecimalName = unitDecimal.name;
    unitDecimalAbbr = unitDecimal.abbreviation;
    ownedUnitIds.push(unitDecimalId);

    const unitNoDecimal = await prisma.unit.upsert({
      where: { code: 'E2ESALUND' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: false },
      create: {
        code: 'E2ESALUND',
        name: 'Unidad E2E Sales entera',
        abbreviation: 'usn',
        allowDecimal: false,
      },
    });
    unitNoDecimalId = unitNoDecimal.id;
    ownedUnitIds.push(unitNoDecimalId);

    const unitInactive = await prisma.unit.upsert({
      where: { code: 'E2ESALUX' },
      update: { status: UnitStatus.INACTIVE, allowDecimal: true },
      create: {
        code: 'E2ESALUX',
        name: 'Unidad E2E Sales inactiva',
        abbreviation: 'usx',
        allowDecimal: true,
        status: UnitStatus.INACTIVE,
      },
    });
    unitInactiveId = unitInactive.id;
    ownedUnitIds.push(unitInactiveId);

    const unitMutableCancel = await prisma.unit.upsert({
      where: { code: 'E2ESALUMC' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2ESALUMC',
        name: 'Unidad E2E Sales Mutable Cancel',
        abbreviation: 'umc',
        allowDecimal: true,
      },
    });
    unitMutableCancelId = unitMutableCancel.id;
    ownedUnitIds.push(unitMutableCancelId);

    const unitMutableConversion = await prisma.unit.upsert({
      where: { code: 'E2ESALUMV' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2ESALUMV',
        name: 'Unidad E2E Sales Mutable Conversion',
        abbreviation: 'umv',
        allowDecimal: true,
      },
    });
    unitMutableConversionId = unitMutableConversion.id;
    ownedUnitIds.push(unitMutableConversionId);

    const unitAllowDecimalMutable = await prisma.unit.upsert({
      where: { code: 'E2ESALUAD' },
      update: { status: UnitStatus.ACTIVE, allowDecimal: true },
      create: {
        code: 'E2ESALUAD',
        name: 'Unidad E2E Sales AllowDecimal Mutable',
        abbreviation: 'uad',
        allowDecimal: true,
      },
    });
    unitAllowDecimalMutableId = unitAllowDecimalMutable.id;
    ownedUnitIds.push(unitAllowDecimalMutableId);

    // ---------------------------------------------------------------
    // Productos fixture.
    // ---------------------------------------------------------------
    async function createProduct(
      data: Partial<Prisma.ProductUncheckedCreateInput> = {},
    ): Promise<FixtureProduct> {
      const suffix = nextSuffix();
      const row = await prisma.product.create({
        data: {
          sku: `E2ES-${suffix}`,
          name: `Producto E2E Sales ${suffix}`,
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
      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        salePrice: row.salePrice.toFixed(2),
      };
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
    productRounding = await createProduct({
      salePrice: new Prisma.Decimal('0.01'),
    });
    productOverflow = await createProduct({
      salePrice: new Prisma.Decimal('999999999999.99'),
    });
    productOversale = await createProduct({
      stockCurrent: new Prisma.Decimal('5.000'),
    });
    productMultiA = await createProduct({
      stockCurrent: new Prisma.Decimal('500.000'),
    });
    productMultiB = await createProduct({
      stockCurrent: new Prisma.Decimal('500.000'),
    });
    productRaceStock = await createProduct({
      stockCurrent: new Prisma.Decimal('3.000'),
    });
    productCancelUnrelatedStock = await createProduct({
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productCancelProductInactive = await createProduct({
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productCancelCategoryInactive = await createProduct({
      categoryId: categoryMutableCancelId,
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productCancelUnitInactive = await createProduct({
      unitId: unitMutableCancelId,
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productCancelTrackingChange = await createProduct({
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productCancelFractional = await createProduct({
      stockCurrent: new Prisma.Decimal('10.500'),
    });
    productCancelNonInventory = await createProduct({
      isInventoryTracked: false,
      salePrice: new Prisma.Decimal('12.00'),
      stockCurrent: new Prisma.Decimal('0.000'),
    });
    productRevalProductInactive = await createProduct({
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productRevalCategoryInactive = await createProduct({
      categoryId: categoryMutableConversionId,
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productRevalUnitInactive = await createProduct({
      unitId: unitMutableConversionId,
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productRevalAllowDecimalChange = await createProduct({
      unitId: unitAllowDecimalMutableId,
      stockCurrent: new Prisma.Decimal('20.000'),
    });
    productRevalStockInsufficient = await createProduct({
      stockCurrent: new Prisma.Decimal('1.000'),
    });
    productQuoteItemSnapshot = await createProduct({
      salePrice: new Prisma.Decimal('25.00'),
    });
    productXss = await createProduct({
      sku: `E2ES-XSS-${nextSuffix()}`,
      name: `<script>alert(1)</script> A&B "Q" O'Brien ${nextSuffix()}`,
    });
    productBusinessDate = await createProduct({
      stockCurrent: new Prisma.Decimal('100.000'),
    });
    productMixedTracked = await createProduct({
      stockCurrent: new Prisma.Decimal('50.000'),
    });
    productMixedNonTracked = await createProduct({
      isInventoryTracked: false,
      salePrice: new Prisma.Decimal('8.00'),
      stockCurrent: new Prisma.Decimal('0.000'),
    });

    // ---------------------------------------------------------------
    // Clientes fixture.
    // ---------------------------------------------------------------
    async function createCustomer(
      data: Partial<Prisma.CustomerUncheckedCreateInput>,
    ): Promise<FixtureCustomer> {
      const row = await prisma.customer.create({
        data: {
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          // NR-02A: todos los clientes fixture de este archivo representan
          // clientes PRE-EXISTENTES a NR-02A (nunca uno creado para probar
          // el baseline false de clientes nuevos, que vive en su propio
          // describe dedicado con su propio fixture explícito) — mismo
          // criterio que el backfill real de la migración
          // (20261018221500_add_customer_credit_enabled: todo cliente no
          // genérico ya existente pasa a true). Sin esto, cientos de tests
          // preexistentes de pago parcial/sin pago inicial sobre
          // personActive y el resto de clientes de este bloque romperían
          // en cuanto la migración se aplique. Irrelevante para
          // blockedCustomer/inactiveCustomer (bloqueados por su propio
          // status antes de llegar a evaluarse creditEnabled).
          creditEnabled: true,
          ...data,
        } as Prisma.CustomerUncheckedCreateInput,
      });
      createdCustomerIds.push(row.id);
      return { id: row.id, name: row.name };
    }

    personActive = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `Cliente Persona E2E ${nextSuffix()}`,
    });
    companyActive = await createCustomer({
      customerType: CustomerType.COMPANY,
      name: `Cliente Empresa E2E ${nextSuffix()}`,
    });
    prospectCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
      name: `Prospecto E2E ${nextSuffix()}`,
    });
    prospectConcurrencyCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
      name: `Prospecto Concurrencia E2E ${nextSuffix()}`,
    });
    prospectFailedCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.PROSPECT,
      name: `Prospecto Fallido E2E ${nextSuffix()}`,
    });
    blockedCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      status: CustomerStatus.BLOCKED,
      name: `Cliente Bloqueado E2E ${nextSuffix()}`,
    });
    inactiveCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      status: CustomerStatus.INACTIVE,
      name: `Cliente Inactivo E2E ${nextSuffix()}`,
    });

    const snapshotSuffix = nextSuffix();
    customerQuoteSnapshot = {
      ...(await createCustomer({
        customerType: CustomerType.PERSON,
        name: `Cliente Snapshot Venta E2E ${snapshotSuffix}`,
        documentType: CustomerDocumentType.DNI,
        documentNumber: `SNPV${snapshotSuffix}`,
        address: `Direccion original venta ${snapshotSuffix}`,
      })),
      documentNumber: `SNPV${snapshotSuffix}`,
      address: `Direccion original venta ${snapshotSuffix}`,
    };

    const searchSuffix = nextSuffix();
    searchCustomer = {
      ...(await createCustomer({
        customerType: CustomerType.PERSON,
        name: `Cliente Busqueda Venta E2E ${searchSuffix}`,
        documentType: CustomerDocumentType.DNI,
        documentNumber: `SRCHV${searchSuffix}`,
      })),
      documentNumber: `SRCHV${searchSuffix}`,
    };

    paginationCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `Cliente Paginacion Venta E2E ${nextSuffix()}`,
    });

    xssCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `XSS <script>alert(1)</script> A&B "Q" O'Brien ${nextSuffix()}`,
    });

    businessDateCustomer = await createCustomer({
      customerType: CustomerType.PERSON,
      name: `Cliente Frontera Fecha E2E ${nextSuffix()}`,
    });

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
  }, 120000);

  afterAll(async () => {
    try {
      // P6-B2: una prueba que falla ANTES de registrar su venta en
      // createdSaleIds dejaba una Sale que referencia una cotización propia;
      // su FK (sales_quote_id_fkey) abortaba quote.deleteMany y el resto de
      // la limpieza. Se incluyen también las ventas que referencian
      // cotizaciones PROPIAS de esta suite (propiedad exacta, nunca global).
      const ownedQuoteIdsForSales = [...createdQuoteIds, ...directQuoteIds];
      const salesFromOwnedQuotes =
        ownedQuoteIdsForSales.length > 0
          ? await prisma.sale.findMany({
              where: { quoteId: { in: ownedQuoteIdsForSales } },
              select: { id: true },
            })
          : [];
      const allSaleIds = [
        ...new Set([
          ...createdSaleIds,
          ...directSaleIds,
          ...salesFromOwnedQuotes.map((sale) => sale.id),
        ]),
      ];
      if (allSaleIds.length > 0) {
        // Fase 7, Bloque D: varias ventas propias ahora tienen Payment
        // asociado (pago inicial / posterior). Payment -> Sale es RESTRICT,
        // así que hay que retirar primero el AuditLog de cada Payment propio
        // y luego los propios Payment, antes de poder borrar la Sale.
        const ownedPayments = await prisma.payment.findMany({
          where: { saleId: { in: allSaleIds } },
          select: { id: true },
        });
        const ownedPaymentIds = ownedPayments.map((p) => p.id);
        if (ownedPaymentIds.length > 0) {
          await prisma.auditLog.deleteMany({
            where: { entityType: 'Payment', entityId: { in: ownedPaymentIds } },
          });
        }
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: allSaleIds } },
        });
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: allSaleIds } },
        });

        // Fase 8, Bloque B: cada Sale/Payment propio puede tener asientos
        // contables ORIGINAL (SalesService.postSaleRecognition/
        // PaymentEngine.postPaymentCollection) y REVERSAL (anulación real
        // durante la prueba). Sin FK de accounting_entries hacia sales/
        // payments (source polimórfico deliberado), así que borrar Sale/
        // Payment nunca falla ni arrastra estas filas: hay que retirarlas a
        // mano ANTES para no dejar historial contable huérfano. REVERSAL
        // primero (self-FK reversesEntryId hacia su ORIGINAL), luego
        // ORIGINAL; las líneas se van solas por CASCADE.
        const accountingWhere = {
          OR: [
            { sourceType: 'SALE' as const, sourceId: { in: allSaleIds } },
            ...(ownedPaymentIds.length > 0
              ? [
                  {
                    sourceType: 'PAYMENT' as const,
                    sourceId: { in: ownedPaymentIds },
                  },
                ]
              : []),
          ],
        };
        await prisma.accountingEntry.deleteMany({
          where: { ...accountingWhere, eventType: 'REVERSAL' },
        });
        await prisma.accountingEntry.deleteMany({
          where: { ...accountingWhere, eventType: 'ORIGINAL' },
        });

        await prisma.payment.deleteMany({
          where: { saleId: { in: allSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: allSaleIds } } });
      }

      const allQuoteIds = [...createdQuoteIds, ...directQuoteIds];
      if (allQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: allQuoteIds } },
        });
        await prisma.quote.deleteMany({ where: { id: { in: allQuoteIds } } });
      }

      if (createdCustomerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'Customer',
            entityId: { in: createdCustomerIds },
          },
        });
      }

      await prisma.documentSequence.deleteMany({
        where: { documentType: DocumentType.SALE },
      });

      if (createdProductIds.length > 0) {
        // Además de las reversas ligadas a Sale (ya borradas arriba), el
        // §61 (cambio de stock no relacionado antes de anular) crea un
        // movimiento MANUAL vía el endpoint real de Inventario, sin
        // referenceType='Sale': hay que limpiarlo por productId o el FK
        // inventory_movements_product_id_fkey bloquea el DELETE del producto.
        await prisma.inventoryMovement.deleteMany({
          where: { productId: { in: createdProductIds } },
        });
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
      // Guarda explícita: un `id: undefined` (si beforeAll lanzó antes de
      // asignar) haría que Prisma omita la condición y deleteMany({})
      // borrara toda la tabla — mismo criterio que createdCustomerIds arriba.
      if (genericCustomerId) {
        await prisma.customer.deleteMany({ where: { id: genericCustomerId } });
      }

      // El usuario fkUser solo se elimina si ninguna Sale lo referencia ya
      // (las propias de este spec se limpiaron arriba); nunca se tocan los
      // usuarios admin/seller/management/warehouse compartidos.
      if (fkUserId) {
        await prisma.user.deleteMany({ where: { id: fkUserId } });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 60000);

  // ------------------------------------------------------------------
  // Helpers
  // ------------------------------------------------------------------

  function validCreateSaleBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      customerId: personActive.id,
      items: [{ productId: productA.id, quantity: '1.000' }],
      ...overrides,
    };
  }

  async function createDirectSale(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeSaleBody> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send(validCreateSaleBody(overrides));
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la venta fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeSaleBody;
    createdSaleIds.push(body.id);
    return body;
  }

  async function convertQuote(
    cookie: string,
    quoteId: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/from-quote/${quoteId}`)
      .set('Cookie', cookie)
      .send();
  }

  async function convertQuoteOrThrow(
    cookie: string,
    quoteId: string,
  ): Promise<SafeSaleBody> {
    const response = await convertQuote(cookie, quoteId);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo convertir la cotización fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeSaleBody;
    createdSaleIds.push(body.id);
    return body;
  }

  interface DirectQuoteItemInput {
    productId: string;
    productSku: string;
    productName: string;
    unitCode: string;
    unitName: string;
    unitAbbreviation: string;
    quantity: string;
    unitPrice: string;
  }

  async function createDirectQuote(overrides: {
    number?: string;
    customerId: string;
    customerType: CustomerType;
    customerDocumentType?: CustomerDocumentType | null;
    customerDocumentNumber?: string | null;
    customerName: string;
    customerAddress?: string | null;
    sellerId?: string;
    status?: QuoteStatus;
    issueDate?: string;
    expirationDate?: string;
    discountAmount?: string;
    items: DirectQuoteItemInput[];
  }): Promise<{ id: string; number: string }> {
    const number = overrides.number ?? `COT-DIRECT-${nextSuffix()}`;
    const issueDate = overrides.issueDate ?? businessToday();
    const expirationDate =
      overrides.expirationDate ?? addDaysToDateOnly(businessToday(), 10);
    const discountAmount = new Prisma.Decimal(
      overrides.discountAmount ?? '0.00',
    );

    const itemsWithTotals = overrides.items.map((item) => {
      const lineTotal = new Prisma.Decimal(item.quantity)
        .mul(new Prisma.Decimal(item.unitPrice))
        .toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
      return { ...item, lineTotal };
    });
    const subtotal = itemsWithTotals.reduce(
      (acc, item) => acc.plus(item.lineTotal),
      new Prisma.Decimal(0),
    );
    const total = subtotal.minus(discountAmount);

    const row = await prisma.quote.create({
      data: {
        number,
        status: overrides.status ?? QuoteStatus.PENDING,
        customerId: overrides.customerId,
        customerType: overrides.customerType,
        customerDocumentType: overrides.customerDocumentType ?? null,
        customerDocumentNumber: overrides.customerDocumentNumber ?? null,
        customerName: overrides.customerName,
        customerAddress: overrides.customerAddress ?? null,
        sellerId: overrides.sellerId ?? adminId,
        issueDate: new Date(`${issueDate}T00:00:00.000Z`),
        expirationDate: new Date(`${expirationDate}T00:00:00.000Z`),
        subtotal,
        discountAmount,
        taxAmount: new Prisma.Decimal(0),
        total,
        currencyCode: 'PEN',
        taxEnabled: false,
        taxRate: new Prisma.Decimal('18.00'),
        pricesIncludeTax: false,
        items: {
          create: itemsWithTotals.map((item) => ({
            productId: item.productId,
            productSku: item.productSku,
            productName: item.productName,
            unitCode: item.unitCode,
            unitName: item.unitName,
            unitAbbreviation: item.unitAbbreviation,
            quantity: new Prisma.Decimal(item.quantity),
            unitPrice: new Prisma.Decimal(item.unitPrice),
            lineTotal: item.lineTotal,
          })),
        },
      },
    });
    createdQuoteIds.push(row.id);
    return { id: row.id, number: row.number };
  }

  /** Ítem de cotización directa usando el snapshot ACTUAL de un FixtureProduct + unidad decimal fixture. */
  function quoteItemFor(
    product: FixtureProduct,
    quantity: string,
    unitPrice?: string,
  ): DirectQuoteItemInput {
    return {
      productId: product.id,
      productSku: product.sku,
      productName: product.name,
      unitCode: unitDecimalCode,
      unitName: unitDecimalName,
      unitAbbreviation: unitDecimalAbbr,
      quantity,
      unitPrice: unitPrice ?? product.salePrice,
    };
  }

  async function currentSaleSequenceNumber(): Promise<number> {
    const row = await prisma.documentSequence.findUniqueOrThrow({
      where: { documentType: DocumentType.SALE },
    });
    return row.currentNumber;
  }

  async function fetchAuditRows(
    action: AuditAction,
    entityType: string,
    entityId: string,
  ): Promise<
    {
      metadata: unknown;
      description: string;
      userId: string | null;
      module: string;
    }[]
  > {
    return prisma.auditLog.findMany({
      where: { action, entityType, entityId },
    });
  }

  /** Fila de Sale mínima pero válida frente a las 18 CHECK de cabecera, para pruebas de unicidad/FK. */
  async function directValidSale(number: string): Promise<string> {
    const row = await prisma.sale.create({
      data: {
        number,
        status: SaleStatus.ACTIVE,
        paymentStatus: SalePaymentStatus.PAID,
        deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
        customerId: personActive.id,
        customerIsGeneric: false,
        customerType: CustomerType.PERSON,
        customerName: 'Cliente Check',
        sellerId: adminId,
        subtotal: new Prisma.Decimal('0.00'),
        discountAmount: new Prisma.Decimal('0.00'),
        taxAmount: new Prisma.Decimal('0.00'),
        total: new Prisma.Decimal('0.00'),
        currencyCode: 'PEN',
        taxEnabled: false,
        taxRate: new Prisma.Decimal('18.00'),
        pricesIncludeTax: false,
        paidAmount: new Prisma.Decimal('0.00'),
        balanceDue: new Prisma.Decimal('0.00'),
        confirmedAt: new Date(),
      },
    });
    directSaleIds.push(row.id);
    return row.id;
  }

  interface RawSaleOverrides {
    number: string;
    status?: SaleStatus;
    paymentStatus?: SalePaymentStatus;
    deliveryStatus?: SaleDeliveryStatus;
    customerId?: string;
    customerIsGeneric?: boolean;
    customerType?: CustomerType | null;
    customerDocumentType?: CustomerDocumentType | null;
    customerDocumentNumber?: string | null;
    customerName?: string;
    customerAddress?: string | null;
    sellerId?: string;
    quoteId?: string | null;
    subtotal?: string;
    discountAmount?: string;
    taxAmount?: string;
    total?: string;
    paidAmount?: string;
    balanceDue?: string;
    cancelledAt?: Date | null;
    cancellationReason?: string | null;
    cancelledByUserId?: string | null;
  }

  /**
   * INSERT crudo (bypass total del servicio) para verificar que PostgreSQL
   * rechaza la fila mediante el CHECK/índice indicado. Mismo criterio que
   * quotes.e2e-spec.ts/inventory.e2e-spec.ts: solo se acopla al SQLSTATE.
   */
  async function rawInsertSale(overrides: RawSaleOverrides): Promise<void> {
    const o = {
      status: SaleStatus.ACTIVE,
      paymentStatus: SalePaymentStatus.PAID,
      deliveryStatus: SaleDeliveryStatus.NOT_APPLICABLE,
      customerId: personActive.id,
      customerIsGeneric: false,
      customerType: CustomerType.PERSON as CustomerType | null,
      customerDocumentType: null as CustomerDocumentType | null,
      customerDocumentNumber: null as string | null,
      customerName: 'Cliente Check',
      customerAddress: null as string | null,
      sellerId: adminId,
      quoteId: null as string | null,
      subtotal: '0.00',
      discountAmount: '0.00',
      taxAmount: '0.00',
      total: '0.00',
      paidAmount: '0.00',
      balanceDue: '0.00',
      cancelledAt: null as Date | null,
      cancellationReason: null as string | null,
      cancelledByUserId: null as string | null,
      ...overrides,
    };
    await prisma.$executeRaw`
      INSERT INTO sales
        (id, number, status, payment_status, delivery_status, customer_id,
         customer_is_generic, customer_type, customer_document_type,
         customer_document_number, customer_name, customer_address, seller_id,
         quote_id, subtotal, discount_amount, tax_amount, total, currency_code,
         tax_enabled, tax_rate, prices_include_tax, paid_amount, balance_due,
         confirmed_at, cancelled_at, cancellation_reason, cancelled_by_user_id,
         created_at, updated_at)
      VALUES
        (gen_random_uuid(), ${o.number}, ${o.status}::"SaleStatus", ${o.paymentStatus}::"SalePaymentStatus",
         ${o.deliveryStatus}::"SaleDeliveryStatus", ${o.customerId}::uuid,
         ${o.customerIsGeneric}, ${o.customerType}::"CustomerType", ${o.customerDocumentType}::"CustomerDocumentType",
         ${o.customerDocumentNumber}, ${o.customerName}, ${o.customerAddress}, ${o.sellerId}::uuid,
         ${o.quoteId}::uuid, ${o.subtotal}::numeric, ${o.discountAmount}::numeric, ${o.taxAmount}::numeric,
         ${o.total}::numeric, 'PEN', false, 18.00, false, ${o.paidAmount}::numeric, ${o.balanceDue}::numeric,
         now(), ${o.cancelledAt}::timestamp, ${o.cancellationReason}, ${o.cancelledByUserId}::uuid,
         now(), now())
    `;
  }

  async function rawInsertSaleItem(overrides: {
    saleId: string;
    productId: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }): Promise<void> {
    await prisma.$executeRaw`
      INSERT INTO sale_items
        (id, sale_id, product_id, product_sku, product_name, unit_code, unit_name,
         unit_abbreviation, quantity, unit_price, line_total, created_at)
      VALUES
        (gen_random_uuid(), ${overrides.saleId}::uuid, ${overrides.productId}::uuid,
         'SKU-CHK', 'Producto Check', 'UND', 'Unidad', 'und',
         ${overrides.quantity}::numeric, ${overrides.unitPrice}::numeric,
         ${overrides.lineTotal}::numeric, now())
    `;
  }

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
    expect(serialized).not.toMatch(/sales_/);
    expect(serialized).not.toMatch(/sale_items_/);
    expect(serialized).not.toMatch(/at Object/);
  }

  // ==================================================================
  // Rutas no soportadas
  // ==================================================================
  describe('rutas no soportadas', () => {
    it('DELETE/PUT/PATCH sobre /sales/:id responden 404', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server)
          .delete(`/api/v1/sales/${id}`)
          .set('Cookie', adminCookie),
        request(server).put(`/api/v1/sales/${id}`).set('Cookie', adminCookie),
        request(server)
          .patch(`/api/v1/sales/${id}`)
          .set('Cookie', adminCookie)
          .send({}),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
      }
    });
  });

  // ==================================================================
  // Autenticación (401 en los 8 endpoints)
  // ==================================================================
  describe('autenticación', () => {
    it('sin cookie: los 8 endpoints responden 401', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server).post('/api/v1/sales').send(validCreateSaleBody()),
        request(server).post(`/api/v1/sales/from-quote/${id}`),
        request(server).get('/api/v1/sales'),
        request(server).get(`/api/v1/sales/${id}`),
        request(server)
          .post(`/api/v1/sales/${id}/cancel`)
          .send({ reason: 'x' }),
        request(server).post(`/api/v1/sales/${id}/mark-delivered`),
        request(server).post(`/api/v1/sales/${id}/mark-observed`),
        request(server).get(`/api/v1/sales/${id}/print`),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(401);
      }
    });
  });

  // ==================================================================
  // Validación de UUID
  // ==================================================================
  describe('validación de UUID', () => {
    it('UUID inválido en :id/:quoteId → 400 sin ejecutar el servicio', async () => {
      const server = app.getHttpServer();
      const responses = await Promise.all([
        request(server)
          .post(`/api/v1/sales/from-quote/${INVALID_UUID}`)
          .set('Cookie', adminCookie),
        request(server)
          .get(`/api/v1/sales/${INVALID_UUID}`)
          .set('Cookie', adminCookie),
        request(server)
          .post(`/api/v1/sales/${INVALID_UUID}/cancel`)
          .set('Cookie', adminCookie)
          .send({ reason: 'x' }),
        request(server)
          .post(`/api/v1/sales/${INVALID_UUID}/mark-delivered`)
          .set('Cookie', adminCookie),
        request(server)
          .post(`/api/v1/sales/${INVALID_UUID}/mark-observed`)
          .set('Cookie', adminCookie),
        request(server)
          .get(`/api/v1/sales/${INVALID_UUID}/print`)
          .set('Cookie', adminCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(400);
      }
    });
  });

  // ==================================================================
  // Primera venta y formato NV
  // ==================================================================
  describe('primera venta y formato NV', () => {
    it('currentNumber es 0 antes de la primera venta; la primera es NV-000001', async () => {
      const before = await currentSaleSequenceNumber();
      expect(before).toBe(0);

      const body = await createDirectSale(adminCookie);
      expect(body.number).toBe('NV-000001');
      expect(body.status).toBe(SaleStatus.ACTIVE);

      const row = await prisma.sale.findUniqueOrThrow({
        where: { id: body.id },
      });
      expect(row.number).toBe('NV-000001');

      const after = await currentSaleSequenceNumber();
      expect(after).toBe(1);
    });
  });

  // ==================================================================
  // sellerId
  // ==================================================================
  describe('sellerId', () => {
    it('en venta directa, sellerId proviene del actor autenticado, nunca del payload', async () => {
      const asSeller = await createDirectSale(sellerCookie);
      expect(asSeller.seller.id).toBe(sellerId);

      const asAdmin = await createDirectSale(adminCookie);
      expect(asAdmin.seller.id).toBe(adminId);
    });

    it('sellerId en el payload → 400 (whitelist)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ sellerId: adminId }));
      expect(response.status).toBe(400);
    });

    it('notes en el payload → 400 (D16: sin campo notes en venta directa)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ notes: 'nota interna' }));
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // Matriz de roles (HTTP real) — sin restricción de propiedad
  // ==================================================================
  describe('matriz de roles', () => {
    it('create: ADMIN 201, SELLER 201, MANAGEMENT 403, WAREHOUSE 403', async () => {
      const server = app.getHttpServer();
      const admin = await request(server)
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody());
      expect(admin.status).toBe(201);
      createdSaleIds.push((admin.body as SafeSaleBody).id);

      const seller = await request(server)
        .post('/api/v1/sales')
        .set('Cookie', sellerCookie)
        .send(validCreateSaleBody());
      expect(seller.status).toBe(201);
      createdSaleIds.push((seller.body as SafeSaleBody).id);

      const management = await request(server)
        .post('/api/v1/sales')
        .set('Cookie', managementCookie)
        .send(validCreateSaleBody());
      expect(management.status).toBe(403);

      const warehouse = await request(server)
        .post('/api/v1/sales')
        .set('Cookie', warehouseCookie)
        .send(validCreateSaleBody());
      expect(warehouse.status).toBe(403);
    });

    it('list/findOne/print: ADMIN/SELLER/MANAGEMENT 200 sobre una venta del SELLER (propia para él), WAREHOUSE 403', async () => {
      // P2: el SELLER solo lee sus ventas; la fixture es suya, y ADMIN/
      // MANAGEMENT conservan la lectura completa.
      const sale = await createDirectSale(sellerCookie);
      const server = app.getHttpServer();

      for (const cookie of [adminCookie, sellerCookie, managementCookie]) {
        const list = await request(server)
          .get('/api/v1/sales')
          .set('Cookie', cookie);
        expect(list.status).toBe(200);
        const detail = await request(server)
          .get(`/api/v1/sales/${sale.id}`)
          .set('Cookie', cookie);
        expect(detail.status).toBe(200);
        const print = await request(server)
          .get(`/api/v1/sales/${sale.id}/print`)
          .set('Cookie', cookie);
        expect(print.status).toBe(200);
      }

      const listWarehouse = await request(server)
        .get('/api/v1/sales')
        .set('Cookie', warehouseCookie);
      expect(listWarehouse.status).toBe(403);
      const detailWarehouse = await request(server)
        .get(`/api/v1/sales/${sale.id}`)
        .set('Cookie', warehouseCookie);
      expect(detailWarehouse.status).toBe(403);
      const printWarehouse = await request(server)
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', warehouseCookie);
      expect(printWarehouse.status).toBe(403);
    });

    it('SELLER no lee ventas creadas por ADMIN (P2: 404 en detalle)', async () => {
      const sale = await createDirectSale(adminCookie);
      const response = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Cookie', sellerCookie);
      expect(response.status).toBe(404);
    });

    it('markDelivered/markObserved: ADMIN 200, SELLER 200 (sobre su propia venta; P6-D), MANAGEMENT 403, WAREHOUSE 403', async () => {
      const server = app.getHttpServer();
      const saleForAdmin = await createDirectSale(adminCookie);
      const deliveredByAdmin = await request(server)
        .post(`/api/v1/sales/${saleForAdmin.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      expect(deliveredByAdmin.status).toBe(200);

      // P6-D: SELLER solo puede observar sus PROPIAS ventas (antes de este
      // bloque, esta prueba usaba una venta del ADMIN; ver también el
      // describe() dedicado "permisos por vendedor — observación (P6-D)"
      // para la cobertura de propiedad completa, incluida la inversión
      // explícita del supuesto heredado).
      const saleForSeller = await createDirectSale(sellerCookie);
      const observedBySeller = await request(server)
        .post(`/api/v1/sales/${saleForSeller.id}/mark-observed`)
        .set('Cookie', sellerCookie);
      expect(observedBySeller.status).toBe(200);

      const saleForManagement = await createDirectSale(adminCookie);
      const byManagement = await request(server)
        .post(`/api/v1/sales/${saleForManagement.id}/mark-delivered`)
        .set('Cookie', managementCookie);
      expect(byManagement.status).toBe(403);

      const saleForWarehouse = await createDirectSale(adminCookie);
      const byWarehouse = await request(server)
        .post(`/api/v1/sales/${saleForWarehouse.id}/mark-delivered`)
        .set('Cookie', warehouseCookie);
      expect(byWarehouse.status).toBe(403);
    });

    it('cancel: solo ADMIN (200); SELLER/MANAGEMENT/WAREHOUSE → 403', async () => {
      const server = app.getHttpServer();

      const saleSeller = await createDirectSale(adminCookie);
      const bySeller = await request(server)
        .post(`/api/v1/sales/${saleSeller.id}/cancel`)
        .set('Cookie', sellerCookie)
        .send({ reason: 'intento seller' });
      expect(bySeller.status).toBe(403);

      const saleManagement = await createDirectSale(adminCookie);
      const byManagement = await request(server)
        .post(`/api/v1/sales/${saleManagement.id}/cancel`)
        .set('Cookie', managementCookie)
        .send({ reason: 'intento management' });
      expect(byManagement.status).toBe(403);

      const saleWarehouse = await createDirectSale(adminCookie);
      const byWarehouse = await request(server)
        .post(`/api/v1/sales/${saleWarehouse.id}/cancel`)
        .set('Cookie', warehouseCookie)
        .send({ reason: 'intento warehouse' });
      expect(byWarehouse.status).toBe(403);

      const saleAdmin = await createDirectSale(adminCookie);
      const byAdmin = await request(server)
        .post(`/api/v1/sales/${saleAdmin.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación admin válida' });
      expect(byAdmin.status).toBe(200);
    });

    it('fromQuote: ADMIN 201, SELLER 201, MANAGEMENT/WAREHOUSE 403', async () => {
      const quoteForAdmin = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const admin = await convertQuote(adminCookie, quoteForAdmin.id);
      expect(admin.status).toBe(201);
      createdSaleIds.push((admin.body as SafeSaleBody).id);

      const quoteForSeller = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        // P6-B2: el SELLER convierte una cotización propia.
        sellerId,
        items: [quoteItemFor(productA, '1.000')],
      });
      const seller = await convertQuote(sellerCookie, quoteForSeller.id);
      expect(seller.status).toBe(201);
      createdSaleIds.push((seller.body as SafeSaleBody).id);

      const quoteForManagement = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const management = await convertQuote(
        managementCookie,
        quoteForManagement.id,
      );
      expect(management.status).toBe(403);

      const quoteForWarehouse = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const warehouse = await convertQuote(
        warehouseCookie,
        quoteForWarehouse.id,
      );
      expect(warehouse.status).toBe(403);
    });
  });

  // ==================================================================
  // Permisos por vendedor — lectura (P2)
  // ==================================================================
  describe('permisos por vendedor — lectura (P2)', () => {
    const MULTI_ROLE_USERNAME = 'e2e_multirole_sales_p2';
    const MULTI_ROLE_PASSWORD = 'MultiRoleSales123';

    async function listSales(
      cookie: string,
      query: Record<string, string | number> = {},
    ): Promise<request.Response> {
      return request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ limit: 100, ...query })
        .set('Cookie', cookie);
    }

    function rowsOf(
      response: request.Response,
    ): PaginatedBody<SafeSaleListItemBody> {
      return response.body as PaginatedBody<SafeSaleListItemBody>;
    }

    it('SELLER lista únicamente sus ventas: incluye la propia, excluye la de ADMIN, total = sus ventas reales', async () => {
      const own = await createDirectSale(sellerCookie);
      const foreign = await createDirectSale(adminCookie);

      const response = await listSales(sellerCookie);
      expect(response.status).toBe(200);
      const body = rowsOf(response);
      const ids = body.data.map((row) => row.id);
      expect(ids).toContain(own.id);
      expect(ids).not.toContain(foreign.id);
      expect(body.data.every((row) => row.sellerId === sellerId)).toBe(true);
      expect(body.total).toBe(await prisma.sale.count({ where: { sellerId } }));
    });

    it('SELLER que filtra por el sellerId de otro vendedor obtiene una lista vacía (sin error)', async () => {
      await createDirectSale(adminCookie);
      const response = await listSales(sellerCookie, { sellerId: adminId });
      expect(response.status).toBe(200);
      expect(rowsOf(response).data).toEqual([]);
      expect(rowsOf(response).total).toBe(0);
    });

    it('SELLER que filtra por su propio sellerId ve sus ventas', async () => {
      const own = await createDirectSale(sellerCookie);
      const response = await listSales(sellerCookie, { sellerId });
      expect(response.status).toBe(200);
      expect(rowsOf(response).data.map((row) => row.id)).toContain(own.id);
    });

    it('SELLER: detalle e impresión propios 200; ajenos 404 idéntico a una venta inexistente', async () => {
      const server = app.getHttpServer();
      const own = await createDirectSale(sellerCookie);
      const foreign = await createDirectSale(adminCookie);

      const ownDetail = await request(server)
        .get(`/api/v1/sales/${own.id}`)
        .set('Cookie', sellerCookie);
      expect(ownDetail.status).toBe(200);
      expect((ownDetail.body as SafeSaleBody).id).toBe(own.id);
      const ownPrint = await request(server)
        .get(`/api/v1/sales/${own.id}/print`)
        .set('Cookie', sellerCookie);
      expect(ownPrint.status).toBe(200);
      expect(ownPrint.text).toContain(own.number);

      const foreignDetail = await request(server)
        .get(`/api/v1/sales/${foreign.id}`)
        .set('Cookie', sellerCookie);
      const foreignPrint = await request(server)
        .get(`/api/v1/sales/${foreign.id}/print`)
        .set('Cookie', sellerCookie);
      const missingDetail = await request(server)
        .get(`/api/v1/sales/${NON_EXISTENT_UUID}`)
        .set('Cookie', sellerCookie);
      const missingPrint = await request(server)
        .get(`/api/v1/sales/${NON_EXISTENT_UUID}/print`)
        .set('Cookie', sellerCookie);
      expect(foreignDetail.status).toBe(404);
      expect(foreignPrint.status).toBe(404);
      expect(missingDetail.status).toBe(404);
      expect(missingPrint.status).toBe(404);
      // La ruta /print declara Content-Type text/html, así que el cuerpo de
      // error JSON llega en `text` (mismo comportamiento previo para una
      // venta inexistente): se lee el mensaje desde ahí.
      const messageOf = (r: request.Response): unknown =>
        (JSON.parse(r.text) as { message?: unknown }).message;
      expect(messageOf(foreignDetail)).toBe('Venta no encontrada');
      expect(messageOf(foreignPrint)).toBe('Venta no encontrada');
      expect(messageOf(foreignDetail)).toEqual(messageOf(missingDetail));
      expect(messageOf(foreignPrint)).toEqual(messageOf(missingPrint));
      // Nada del documento ajeno se filtra en la respuesta.
      expect(JSON.stringify(foreignDetail.body)).not.toContain(foreign.number);
      expect(foreignPrint.text).not.toContain(foreign.number);
    });

    it('ADMIN lee y lista ventas de otros vendedores; el vendedor original se conserva', async () => {
      const server = app.getHttpServer();
      const sellerSale = await createDirectSale(sellerCookie);

      const detail = await request(server)
        .get(`/api/v1/sales/${sellerSale.id}`)
        .set('Cookie', adminCookie);
      expect(detail.status).toBe(200);
      expect((detail.body as SafeSaleBody).seller.id).toBe(sellerId);

      const list = await listSales(adminCookie, { sellerId });
      expect(list.status).toBe(200);
      expect(rowsOf(list).data.map((row) => row.id)).toContain(sellerSale.id);

      const print = await request(server)
        .get(`/api/v1/sales/${sellerSale.id}/print`)
        .set('Cookie', adminCookie);
      expect(print.status).toBe(200);
    });

    it('MANAGEMENT conserva la lectura completa (ventas de SELLER y de ADMIN)', async () => {
      const server = app.getHttpServer();
      const sellerSale = await createDirectSale(sellerCookie);
      const adminSale = await createDirectSale(adminCookie);

      for (const sale of [sellerSale, adminSale]) {
        const detail = await request(server)
          .get(`/api/v1/sales/${sale.id}`)
          .set('Cookie', managementCookie);
        expect(detail.status).toBe(200);
      }
      const bySeller = await listSales(managementCookie, { sellerId });
      expect(rowsOf(bySeller).data.map((row) => row.id)).toContain(
        sellerSale.id,
      );
      const byAdmin = await listSales(managementCookie, { sellerId: adminId });
      expect(rowsOf(byAdmin).data.map((row) => row.id)).toContain(adminSale.id);
    });

    it('sin autenticación: listado, detalle e impresión responden 401', async () => {
      const server = app.getHttpServer();
      const sale = await createDirectSale(sellerCookie);
      expect((await request(server).get('/api/v1/sales')).status).toBe(401);
      expect(
        (await request(server).get(`/api/v1/sales/${sale.id}`)).status,
      ).toBe(401);
      expect(
        (await request(server).get(`/api/v1/sales/${sale.id}/print`)).status,
      ).toBe(401);
    });

    it('cambio de rol activo: el mismo usuario como SELLER no ve una venta ajena; tras cambiar a ADMIN sí', async () => {
      const server = app.getHttpServer();
      await upsertFixtureUser(prisma, {
        username: MULTI_ROLE_USERNAME,
        email: 'e2e_multirole_sales_p2@demosystem.test',
        password: MULTI_ROLE_PASSWORD,
        roleName: RoleName.SELLER,
      });
      const multiRoleUser = await prisma.user.findUniqueOrThrow({
        where: { username: MULTI_ROLE_USERNAME },
      });
      const adminRole = await prisma.role.findUniqueOrThrow({
        where: { name: RoleName.ADMIN },
      });
      await prisma.userRole.createMany({
        data: [{ userId: multiRoleUser.id, roleId: adminRole.id }],
        skipDuplicates: true,
      });

      try {
        const foreign = await createDirectSale(adminCookie);
        // Rol activo por defecto con SELLER asignado: SELLER.
        const asSeller = (
          await login(server, MULTI_ROLE_USERNAME, MULTI_ROLE_PASSWORD)
        ).cookie;
        const deniedDetail = await request(server)
          .get(`/api/v1/sales/${foreign.id}`)
          .set('Cookie', asSeller);
        expect(deniedDetail.status).toBe(404);

        const switched = await request(server)
          .post('/api/v1/auth/switch-role')
          .set('Cookie', asSeller)
          .send({ role: RoleName.ADMIN });
        expect(switched.status).toBe(200);
        const setCookie = (switched.headers['set-cookie'] ??
          []) as unknown as string[];
        const asAdmin = (setCookie[0] ?? '').split(';')[0] ?? '';
        expect(asAdmin).not.toBe('');

        const allowedDetail = await request(server)
          .get(`/api/v1/sales/${foreign.id}`)
          .set('Cookie', asAdmin);
        expect(allowedDetail.status).toBe(200);
      } finally {
        // Revoca el rol ADMIN de este usuario dedicado: otras suites
        // (users, users-admin-concurrency) dependen de que e2e_admin sea
        // el único ADMIN activo.
        await prisma.userRole.deleteMany({
          where: { userId: multiRoleUser.id, roleId: adminRole.id },
        });
      }
    });
  });

  // ==================================================================
  // Permisos por vendedor — entrega (P3)
  // ==================================================================
  describe('permisos por vendedor — entrega (P3)', () => {
    const SELLER2_USERNAME = 'e2e_seller2_sales_p3';
    const SELLER2_PASSWORD = 'Seller2SalesP3123';
    const MULTI_ROLE_USERNAME = 'e2e_multirole_sales_p3';
    const MULTI_ROLE_PASSWORD = 'MultiRoleSalesP3123';

    async function markDelivered(
      cookie: string,
      saleId: string,
    ): Promise<request.Response> {
      return request(app.getHttpServer())
        .post(`/api/v1/sales/${saleId}/mark-delivered`)
        .set('Cookie', cookie);
    }

    /** Estado persistido relevante de la venta, para comparar antes/después. */
    async function deliverySnapshot(saleId: string) {
      const [sale, movements, deliveryAudits] = await Promise.all([
        prisma.sale.findUniqueOrThrow({
          where: { id: saleId },
          select: { deliveryStatus: true, sellerId: true, updatedAt: true },
        }),
        prisma.inventoryMovement.count({
          where: { referenceType: 'Sale', referenceId: saleId },
        }),
        prisma.auditLog.count({
          where: {
            action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
            entityType: 'Sale',
            entityId: saleId,
          },
        }),
      ]);
      return { sale, movements, deliveryAudits };
    }

    function messageOf(response: request.Response): unknown {
      return (JSON.parse(response.text) as { message?: unknown }).message;
    }

    it('SELLER marca entregada su propia venta: 200, DELIVERED, auditoría con el SELLER real y sellerId intacto', async () => {
      const own = await createDirectSale(sellerCookie);
      const response = await markDelivered(sellerCookie, own.id);
      expect(response.status).toBe(200);
      expect((response.body as SafeSaleBody).deliveryStatus).toBe(
        SaleDeliveryStatus.DELIVERED,
      );

      const after = await deliverySnapshot(own.id);
      expect(after.sale.sellerId).toBe(sellerId);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
          entityId: own.id,
        },
      });
      expect(audit.userId).toBe(sellerId);
    });

    it('SELLER sobre una venta del ADMIN: 404 sin ningún efecto (estado, inventario, auditoría, sellerId)', async () => {
      const foreign = await createDirectSale(adminCookie);
      const before = await deliverySnapshot(foreign.id);

      const response = await markDelivered(sellerCookie, foreign.id);
      expect(response.status).toBe(404);
      expect(messageOf(response)).toBe('Venta no encontrada');
      expect(response.text).not.toContain(foreign.number);

      expect(await deliverySnapshot(foreign.id)).toEqual(before);
      expect(before.sale.deliveryStatus).toBe(SaleDeliveryStatus.PENDING);
    });

    it('SELLER sobre una venta de OTRO SELLER: 404 sin efectos', async () => {
      await upsertFixtureUser(prisma, {
        username: SELLER2_USERNAME,
        email: 'e2e_seller2_sales_p3@demosystem.test',
        password: SELLER2_PASSWORD,
        roleName: RoleName.SELLER,
      });
      const seller2Cookie = (
        await login(app.getHttpServer(), SELLER2_USERNAME, SELLER2_PASSWORD)
      ).cookie;
      const otherSellerSale = await createDirectSale(seller2Cookie);
      const before = await deliverySnapshot(otherSellerSale.id);

      const response = await markDelivered(sellerCookie, otherSellerSale.id);
      expect(response.status).toBe(404);
      expect(messageOf(response)).toBe('Venta no encontrada');
      expect(await deliverySnapshot(otherSellerSale.id)).toEqual(before);
    });

    it('venta ajena e inexistente son indistinguibles (estado y mensaje)', async () => {
      const foreign = await createDirectSale(adminCookie);
      const foreignResponse = await markDelivered(sellerCookie, foreign.id);
      const missingResponse = await markDelivered(
        sellerCookie,
        NON_EXISTENT_UUID,
      );
      expect(foreignResponse.status).toBe(404);
      expect(missingResponse.status).toBe(404);
      expect(messageOf(foreignResponse)).toEqual(messageOf(missingResponse));
      expect(messageOf(missingResponse)).toBe('Venta no encontrada');
    });

    it('ADMIN marca entregada una venta del SELLER (permiso existente); auditoría con el ADMIN real; sellerId intacto', async () => {
      const sellerSale = await createDirectSale(sellerCookie);
      const response = await markDelivered(adminCookie, sellerSale.id);
      expect(response.status).toBe(200);

      const after = await deliverySnapshot(sellerSale.id);
      expect(after.sale.deliveryStatus).toBe(SaleDeliveryStatus.DELIVERED);
      expect(after.sale.sellerId).toBe(sellerId);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
          entityId: sellerSale.id,
        },
      });
      expect(audit.userId).toBe(adminId);
    });

    it('sin autenticación: 401 sin efectos', async () => {
      const sale = await createDirectSale(sellerCookie);
      const before = await deliverySnapshot(sale.id);
      const response = await request(app.getHttpServer()).post(
        `/api/v1/sales/${sale.id}/mark-delivered`,
      );
      expect(response.status).toBe(401);
      expect(await deliverySnapshot(sale.id)).toEqual(before);
    });

    it('cambio de rol activo: como SELLER 404 sobre una venta ajena; tras cambiar a ADMIN, 200', async () => {
      const server = app.getHttpServer();
      await upsertFixtureUser(prisma, {
        username: MULTI_ROLE_USERNAME,
        email: 'e2e_multirole_sales_p3@demosystem.test',
        password: MULTI_ROLE_PASSWORD,
        roleName: RoleName.SELLER,
      });
      const multiRoleUser = await prisma.user.findUniqueOrThrow({
        where: { username: MULTI_ROLE_USERNAME },
      });
      const adminRole = await prisma.role.findUniqueOrThrow({
        where: { name: RoleName.ADMIN },
      });
      await prisma.userRole.createMany({
        data: [{ userId: multiRoleUser.id, roleId: adminRole.id }],
        skipDuplicates: true,
      });

      try {
        const foreign = await createDirectSale(adminCookie);
        const asSeller = (
          await login(server, MULTI_ROLE_USERNAME, MULTI_ROLE_PASSWORD)
        ).cookie;
        const denied = await markDelivered(asSeller, foreign.id);
        expect(denied.status).toBe(404);

        const switched = await request(server)
          .post('/api/v1/auth/switch-role')
          .set('Cookie', asSeller)
          .send({ role: RoleName.ADMIN });
        expect(switched.status).toBe(200);
        const setCookie = (switched.headers['set-cookie'] ??
          []) as unknown as string[];
        const asAdmin = (setCookie[0] ?? '').split(';')[0] ?? '';
        expect(asAdmin).not.toBe('');

        const allowed = await markDelivered(asAdmin, foreign.id);
        expect(allowed.status).toBe(200);
        const audit = await prisma.auditLog.findFirstOrThrow({
          where: {
            action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
            entityId: foreign.id,
          },
        });
        expect(audit.userId).toBe(multiRoleUser.id);
      } finally {
        // Otras suites exigen que e2e_admin sea el único ADMIN activo.
        await prisma.userRole.deleteMany({
          where: { userId: multiRoleUser.id, roleId: adminRole.id },
        });
      }
    });
  });

  // ==================================================================
  // Permisos por vendedor — observación (P6-D)
  // ==================================================================
  describe('permisos por vendedor — observación (P6-D)', () => {
    const SELLER2_USERNAME = 'e2e_seller2_sales_p6d';
    const SELLER2_PASSWORD = 'Seller2SalesP6d123';
    const MULTI_ROLE_USERNAME = 'e2e_multirole_sales_p6d';
    const MULTI_ROLE_PASSWORD = 'MultiRoleSalesP6d123';

    async function markObserved(
      cookie: string,
      saleId: string,
    ): Promise<request.Response> {
      return request(app.getHttpServer())
        .post(`/api/v1/sales/${saleId}/mark-observed`)
        .set('Cookie', cookie);
    }

    async function markDelivered(
      cookie: string,
      saleId: string,
    ): Promise<request.Response> {
      return request(app.getHttpServer())
        .post(`/api/v1/sales/${saleId}/mark-delivered`)
        .set('Cookie', cookie);
    }

    /** Estado persistido relevante de la venta, para comparar antes/después. */
    async function deliverySnapshot(saleId: string) {
      const [sale, movements, deliveryAudits] = await Promise.all([
        prisma.sale.findUniqueOrThrow({
          where: { id: saleId },
          select: { deliveryStatus: true, sellerId: true, updatedAt: true },
        }),
        prisma.inventoryMovement.count({
          where: { referenceType: 'Sale', referenceId: saleId },
        }),
        prisma.auditLog.count({
          where: {
            action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
            entityType: 'Sale',
            entityId: saleId,
          },
        }),
      ]);
      return { sale, movements, deliveryAudits };
    }

    function messageOf(response: request.Response): unknown {
      return (JSON.parse(response.text) as { message?: unknown }).message;
    }

    it('SELLER marca observada su propia venta: 200, OBSERVED, auditoría con el SELLER real y sellerId intacto', async () => {
      const own = await createDirectSale(sellerCookie);
      const response = await markObserved(sellerCookie, own.id);
      expect(response.status).toBe(200);
      expect((response.body as SafeSaleBody).deliveryStatus).toBe(
        SaleDeliveryStatus.OBSERVED,
      );

      const after = await deliverySnapshot(own.id);
      expect(after.sale.sellerId).toBe(sellerId);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
          entityId: own.id,
        },
      });
      expect(audit.userId).toBe(sellerId);
    });

    it('INVERSIÓN DEL SUPUESTO HEREDADO: SELLER sobre una venta del ADMIN ya NO devuelve 200 — ahora 404 sin ningún efecto (estado, inventario, auditoría, sellerId)', async () => {
      const foreign = await createDirectSale(adminCookie);
      const before = await deliverySnapshot(foreign.id);
      expect(before.sale.deliveryStatus).toBe(SaleDeliveryStatus.PENDING);

      const response = await markObserved(sellerCookie, foreign.id);
      expect(response.status).toBe(404);
      expect(messageOf(response)).toBe('Venta no encontrada');
      expect(response.text).not.toContain(foreign.number);

      expect(await deliverySnapshot(foreign.id)).toEqual(before);
    });

    it('SELLER sobre una venta de OTRO SELLER: 404 sin efectos', async () => {
      await upsertFixtureUser(prisma, {
        username: SELLER2_USERNAME,
        email: 'e2e_seller2_sales_p6d@demosystem.test',
        password: SELLER2_PASSWORD,
        roleName: RoleName.SELLER,
      });
      const seller2Cookie = (
        await login(app.getHttpServer(), SELLER2_USERNAME, SELLER2_PASSWORD)
      ).cookie;
      const otherSellerSale = await createDirectSale(seller2Cookie);
      const before = await deliverySnapshot(otherSellerSale.id);

      const response = await markObserved(sellerCookie, otherSellerSale.id);
      expect(response.status).toBe(404);
      expect(messageOf(response)).toBe('Venta no encontrada');
      expect(await deliverySnapshot(otherSellerSale.id)).toEqual(before);
    });

    it('venta ajena e inexistente son indistinguibles (estado y mensaje)', async () => {
      const foreign = await createDirectSale(adminCookie);
      const foreignResponse = await markObserved(sellerCookie, foreign.id);
      const missingResponse = await markObserved(
        sellerCookie,
        NON_EXISTENT_UUID,
      );
      expect(foreignResponse.status).toBe(404);
      expect(missingResponse.status).toBe(404);
      expect(messageOf(foreignResponse)).toEqual(messageOf(missingResponse));
      expect(messageOf(missingResponse)).toBe('Venta no encontrada');
    });

    it('venta ajena en estado inválido para observar (ya ENTREGADA por el ADMIN): sigue siendo 404, nunca 409 — la propiedad nunca revela el estado', async () => {
      const foreign = await createDirectSale(adminCookie);
      const delivered = await markDelivered(adminCookie, foreign.id);
      expect(delivered.status).toBe(200);
      const before = await deliverySnapshot(foreign.id);
      expect(before.sale.deliveryStatus).toBe(SaleDeliveryStatus.DELIVERED);

      const response = await markObserved(sellerCookie, foreign.id);
      expect(response.status).toBe(404);
      expect(messageOf(response)).toBe('Venta no encontrada');
      expect(await deliverySnapshot(foreign.id)).toEqual(before);
    });

    it('ADMIN marca observada una venta del SELLER (permiso existente); auditoría con el ADMIN real; sellerId intacto', async () => {
      const sellerSale = await createDirectSale(sellerCookie);
      const response = await markObserved(adminCookie, sellerSale.id);
      expect(response.status).toBe(200);

      const after = await deliverySnapshot(sellerSale.id);
      expect(after.sale.deliveryStatus).toBe(SaleDeliveryStatus.OBSERVED);
      expect(after.sale.sellerId).toBe(sellerId);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
          entityId: sellerSale.id,
        },
      });
      expect(audit.userId).toBe(adminId);
    });

    it('MANAGEMENT y WAREHOUSE no adquieren permisos de observación: 403 (RolesGuard), ni siquiera sobre su propia identidad', async () => {
      const sale = await createDirectSale(adminCookie);
      const byManagement = await markObserved(managementCookie, sale.id);
      expect(byManagement.status).toBe(403);
      const byWarehouse = await markObserved(warehouseCookie, sale.id);
      expect(byWarehouse.status).toBe(403);
    });

    it('sin autenticación: 401 sin efectos', async () => {
      const sale = await createDirectSale(sellerCookie);
      const before = await deliverySnapshot(sale.id);
      const response = await request(app.getHttpServer()).post(
        `/api/v1/sales/${sale.id}/mark-observed`,
      );
      expect(response.status).toBe(401);
      expect(await deliverySnapshot(sale.id)).toEqual(before);
    });

    it('cambio de rol activo: como SELLER 404 sobre una venta ajena; tras cambiar a ADMIN, 200', async () => {
      const server = app.getHttpServer();
      await upsertFixtureUser(prisma, {
        username: MULTI_ROLE_USERNAME,
        email: 'e2e_multirole_sales_p6d@demosystem.test',
        password: MULTI_ROLE_PASSWORD,
        roleName: RoleName.SELLER,
      });
      const multiRoleUser = await prisma.user.findUniqueOrThrow({
        where: { username: MULTI_ROLE_USERNAME },
      });
      const adminRole = await prisma.role.findUniqueOrThrow({
        where: { name: RoleName.ADMIN },
      });
      await prisma.userRole.createMany({
        data: [{ userId: multiRoleUser.id, roleId: adminRole.id }],
        skipDuplicates: true,
      });

      try {
        const foreign = await createDirectSale(adminCookie);
        const asSeller = (
          await login(server, MULTI_ROLE_USERNAME, MULTI_ROLE_PASSWORD)
        ).cookie;
        const denied = await markObserved(asSeller, foreign.id);
        expect(denied.status).toBe(404);

        const switched = await request(server)
          .post('/api/v1/auth/switch-role')
          .set('Cookie', asSeller)
          .send({ role: RoleName.ADMIN });
        expect(switched.status).toBe(200);
        const setCookie = (switched.headers['set-cookie'] ??
          []) as unknown as string[];
        const asAdmin = (setCookie[0] ?? '').split(';')[0] ?? '';
        expect(asAdmin).not.toBe('');

        const allowed = await markObserved(asAdmin, foreign.id);
        expect(allowed.status).toBe(200);
        const audit = await prisma.auditLog.findFirstOrThrow({
          where: {
            action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
            entityId: foreign.id,
          },
        });
        expect(audit.userId).toBe(multiRoleUser.id);
      } finally {
        // Otras suites exigen que e2e_admin sea el único ADMIN activo.
        await prisma.userRole.deleteMany({
          where: { userId: multiRoleUser.id, roleId: adminRole.id },
        });
      }
    });

    it('regresión: mark-delivered conserva exactamente su comportamiento de P3 (propia 200, ajena 404)', async () => {
      const own = await createDirectSale(sellerCookie);
      const ownResponse = await markDelivered(sellerCookie, own.id);
      expect(ownResponse.status).toBe(200);

      const foreign = await createDirectSale(adminCookie);
      const foreignResponse = await markDelivered(sellerCookie, foreign.id);
      expect(foreignResponse.status).toBe(404);
      expect(messageOf(foreignResponse)).toBe('Venta no encontrada');
    });
  });

  // ==================================================================
  // Permisos por vendedor — conversión con pagos iniciales (P6-A)
  // ==================================================================
  describe('permisos por vendedor — conversión de cotizaciones (P6-A + P6-B2)', () => {
    async function convertWith(
      cookie: string,
      quoteId: string,
      body: Record<string, unknown>,
    ): Promise<request.Response> {
      return request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteId}`)
        .set('Cookie', cookie)
        .send(body);
    }

    async function quoteFor(sellerOwner: string, status?: QuoteStatus) {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        sellerId: sellerOwner,
        ...(status !== undefined ? { status } : {}),
        items: [quoteItemFor(productA, '1.000')],
      });
      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
        select: { total: true },
      });
      return { ...quote, total: row.total.toFixed(2) };
    }

    /** Todo lo que una conversión podría persistir. */
    async function conversionSnapshot(quoteId: string) {
      const [quote, sales, sequence, converted, stock] = await Promise.all([
        prisma.quote.findUniqueOrThrow({
          where: { id: quoteId },
          select: { status: true, sellerId: true, updatedAt: true },
        }),
        prisma.sale.count({ where: { quoteId } }),
        currentSaleSequenceNumber(),
        prisma.auditLog.count({
          where: {
            action: AuditAction.QUOTE_CONVERTED,
            entityType: 'Quote',
            entityId: quoteId,
          },
        }),
        prisma.product
          .findUniqueOrThrow({ where: { id: productA.id } })
          .then((p) => p.stockCurrent.toFixed(3)),
      ]);
      return { quote, sales, sequence, converted, stock };
    }

    function trackSale(response: request.Response): SafeSaleBody {
      const body = response.body as SafeSaleBody;
      createdSaleIds.push(body.id);
      return body;
    }

    function messageOf(response: request.Response): unknown {
      return (response.body as { message?: unknown }).message;
    }

    const SELLER2_USERNAME = 'e2e_seller2_sales_p6b2';
    const SELLER2_PASSWORD = 'Seller2SalesP6b2123';

    async function seller2CookieP6b2(): Promise<string> {
      await upsertFixtureUser(prisma, {
        username: SELLER2_USERNAME,
        email: 'e2e_seller2_sales_p6b2@demosystem.test',
        password: SELLER2_PASSWORD,
        roleName: RoleName.SELLER,
      });
      return (
        await login(app.getHttpServer(), SELLER2_USERNAME, SELLER2_PASSWORD)
      ).cookie;
    }

    it('SELLER convierte su propia cotización con `payment`: 201, PAID, sellerId = SELLER, cobrador = SELLER', async () => {
      const quote = await quoteFor(sellerId);
      const response = await convertWith(sellerCookie, quote.id, {
        payment: { method: 'CASH', amount: quote.total },
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.seller.id).toBe(sellerId);
      const payments = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(payments).toHaveLength(1);
      expect(payments[0].createdByUserId).toBe(sellerId);
    });

    it('SELLER convierte su propia cotización con `payments[]`: 201, un Payment por elemento', async () => {
      const quote = await quoteFor(sellerId);
      const response = await convertWith(sellerCookie, quote.id, {
        payments: [
          { method: 'CASH', amount: '1.00' },
          { method: 'CASH', amount: '1.00' },
        ],
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(
        2,
      );
    });

    it.each([
      [
        'payment',
        (total: string) => ({ payment: { method: 'CASH', amount: total } }),
      ],
      [
        'payments[]',
        () => ({
          payments: [
            { method: 'CASH', amount: '1.00' },
            { method: 'CASH', amount: '1.00' },
          ],
        }),
      ],
    ])(
      'SELLER con cotización ajena y %s: 404 "La cotización no existe", sin venta, pagos, stock, correlativo ni auditoría',
      async (_label, body) => {
        const quote = await quoteFor(adminId);
        const before = await conversionSnapshot(quote.id);
        const paymentsBefore = await prisma.payment.count();

        const response = await convertWith(
          sellerCookie,
          quote.id,
          body(quote.total),
        );
        expect(response.status).toBe(404);
        expect(messageOf(response)).toBe('La cotización no existe');
        expect(JSON.stringify(response.body)).not.toContain(quote.number);

        expect(await conversionSnapshot(quote.id)).toEqual(before);
        expect(await prisma.payment.count()).toBe(paymentsBefore);
        expect(before.quote.sellerId).toBe(adminId);
      },
    );

    it('cotización ajena RECHAZADA o inexistente con pagos: mismo 404 (nunca el 409 que revelaría su estado)', async () => {
      const rejected = await quoteFor(adminId, QuoteStatus.REJECTED);
      const rejectedResponse = await convertWith(sellerCookie, rejected.id, {
        payment: { method: 'CASH', amount: '1.00' },
      });
      const missingResponse = await convertWith(
        sellerCookie,
        NON_EXISTENT_UUID,
        { payment: { method: 'CASH', amount: '1.00' } },
      );
      expect(rejectedResponse.status).toBe(404);
      expect(missingResponse.status).toBe(404);
      expect(messageOf(rejectedResponse)).toEqual(messageOf(missingResponse));
    });

    it('ADMIN convierte una cotización del SELLER con pago: sellerId = SELLER original, cobrador = ADMIN', async () => {
      const quote = await quoteFor(sellerId);
      const response = await convertWith(adminCookie, quote.id, {
        payment: { method: 'CASH', amount: quote.total },
      });
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.seller.id).toBe(sellerId);
      const payments = await prisma.payment.findMany({
        where: { saleId: sale.id },
      });
      expect(payments[0].createdByUserId).toBe(adminId);
    });

    it('P6-B2: SELLER convierte una cotización ajena SIN pagos → 404 "La cotización no existe", sin venta, stock, correlativo ni auditoría', async () => {
      const quote = await quoteFor(adminId);
      const before = await conversionSnapshot(quote.id);
      const response = await convertWith(sellerCookie, quote.id, {});
      expect(response.status).toBe(404);
      expect(messageOf(response)).toBe('La cotización no existe');
      expect(await conversionSnapshot(quote.id)).toEqual(before);
    });

    it('P6-B2: SELLER convierte su propia cotización SIN pagos → 201 a su nombre, sin pagos', async () => {
      const quote = await quoteFor(sellerId);
      const response = await convertWith(sellerCookie, quote.id, {});
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.seller.id).toBe(sellerId);
      expect(await prisma.payment.count({ where: { saleId: sale.id } })).toBe(
        0,
      );
    });

    it('P6-B2: ADMIN convierte una cotización del SELLER SIN pagos → 201; la venta conserva al SELLER', async () => {
      const quote = await quoteFor(sellerId);
      const response = await convertWith(adminCookie, quote.id, {});
      expect(response.status).toBe(201);
      const sale = trackSale(response);
      expect(sale.seller.id).toBe(sellerId);
      const audit = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.QUOTE_CONVERTED,
          entityType: 'Quote',
          entityId: quote.id,
        },
      });
      expect(audit.userId).toBe(adminId);
    });

    it('P6-B2: concurrencia — dueño (SELLER) y SELLER ajeno convierten la misma cotización; solo el dueño crea la venta', async () => {
      const quote = await quoteFor(sellerId);
      const [owner, foreign] = await Promise.all([
        convertWith(sellerCookie, quote.id, {}),
        convertWith(await seller2CookieP6b2(), quote.id, {}),
      ]);
      expect(owner.status).toBe(201);
      expect(foreign.status).toBe(404);
      trackSale(owner);
      expect(await prisma.sale.count({ where: { quoteId: quote.id } })).toBe(1);
    }, 30000);

    it('sin autenticación: 401 sin efectos', async () => {
      const quote = await quoteFor(sellerId);
      const before = await conversionSnapshot(quote.id);
      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .send({ payment: { method: 'CASH', amount: quote.total } });
      expect(response.status).toBe(401);
      expect(await conversionSnapshot(quote.id)).toEqual(before);
    });
  });

  // ==================================================================
  // Elegibilidad de cliente
  // ==================================================================
  describe('elegibilidad de cliente', () => {
    it('cliente inexistente → 404; inactivo → 409, sin consumir NV', async () => {
      const before = await currentSaleSequenceNumber();

      const missing = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: NON_EXISTENT_UUID }));
      expect(missing.status).toBe(404);

      const inactive = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: inactiveCustomer.id }));
      expect(inactive.status).toBe(409);

      const after = await currentSaleSequenceNumber();
      expect(after).toBe(before);
    });

    it('PERSON/COMPANY activos → 201, con snapshot de cliente correcto', async () => {
      const person = await createDirectSale(adminCookie, {
        customerId: personActive.id,
      });
      expect(person.customerType).toBe(CustomerType.PERSON);
      expect(person.customerName).toBe(personActive.name);
      expect(person.customerIsGeneric).toBe(false);

      const company = await createDirectSale(adminCookie, {
        customerId: companyActive.id,
      });
      expect(company.customerType).toBe(CustomerType.COMPANY);
      expect(company.customerName).toBe(companyActive.name);
    });
  });

  // ==================================================================
  // Público general y cliente bloqueado — reglas de deuda (D4/D5)
  // ==================================================================
  describe('Público general y cliente bloqueado — reglas de deuda', () => {
    it('Público general con total positivo → 409, sin consumir NV', async () => {
      const before = await currentSaleSequenceNumber();
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: genericCustomerId }));
      expect(response.status).toBe(409);
      const after = await currentSaleSequenceNumber();
      expect(after).toBe(before);
    });

    it('Público general con total exactamente 0 (descuento = subtotal) → 201, PAID', async () => {
      const body = await createDirectSale(adminCookie, {
        customerId: genericCustomerId,
        discountAmount: productA.salePrice,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.total).toBe('0.00');
      expect(body.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(body.balanceDue).toBe('0.00');
      expect(body.customerIsGeneric).toBe(true);
      expect(body.customerType).toBeNull();
    });

    it('cliente bloqueado con total positivo → 409; con total 0 → 201', async () => {
      const positive = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: blockedCustomer.id }));
      expect(positive.status).toBe(409);

      const zero = await createDirectSale(adminCookie, {
        customerId: blockedCustomer.id,
        discountAmount: productA.salePrice,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(zero.total).toBe('0.00');
      expect(zero.paymentStatus).toBe(SalePaymentStatus.PAID);
    });
  });

  // ==================================================================
  // Ítems vacíos y duplicados
  // ==================================================================
  describe('ítems vacíos y duplicados', () => {
    it('items=[] → 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ items: [] }));
      expect(response.status).toBe(400);
    });

    it('producto repetido → 400 (nunca 409), sin persistir nada ni consumir NV', async () => {
      const before = await currentSaleSequenceNumber();
      const totalBefore = await prisma.sale.count();

      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [
              { productId: productA.id, quantity: '1.000' },
              { productId: productA.id, quantity: '2.000' },
            ],
          }),
        );
      expect(response.status).toBe(400);

      expect(await currentSaleSequenceNumber()).toBe(before);
      expect(await prisma.sale.count()).toBe(totalBefore);
    });
  });

  // ==================================================================
  // Elegibilidad de producto
  // ==================================================================
  describe('elegibilidad de producto', () => {
    it('producto inexistente → 404; inactivo → 409; categoría inactiva → 409; unidad inactiva → 409, sin consumir NV', async () => {
      const before = await currentSaleSequenceNumber();

      const missing = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: NON_EXISTENT_UUID, quantity: '1.000' }],
          }),
        );
      expect(missing.status).toBe(404);

      const inactive = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productInactive.id, quantity: '1.000' }],
          }),
        );
      expect(inactive.status).toBe(409);

      const badCategory = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productBadCategory.id, quantity: '1.000' }],
          }),
        );
      expect(badCategory.status).toBe(409);

      const badUnit = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productBadUnit.id, quantity: '1.000' }],
          }),
        );
      expect(badUnit.status).toBe(409);

      expect(await currentSaleSequenceNumber()).toBe(before);
    });

    it('PRODUCT activo → 201; SERVICE activo → 201, sin movimiento de inventario; producto no inventariable → 201 sin movimiento', async () => {
      const productSale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(productSale.deliveryStatus).toBe(SaleDeliveryStatus.PENDING);
      expect(productSale.inventoryMovements).toHaveLength(1);

      const serviceSale = await createDirectSale(adminCookie, {
        items: [{ productId: productService.id, quantity: '1.000' }],
      });
      expect(serviceSale.deliveryStatus).toBe(
        SaleDeliveryStatus.NOT_APPLICABLE,
      );
      expect(serviceSale.inventoryMovements).toHaveLength(0);

      const nonInventorySale = await createDirectSale(adminCookie, {
        items: [{ productId: productNonInventory.id, quantity: '1.000' }],
      });
      expect(nonInventorySale.deliveryStatus).toBe(
        SaleDeliveryStatus.NOT_APPLICABLE,
      );
      expect(nonInventorySale.inventoryMovements).toHaveLength(0);
    });

    it('venta mixta (tracked + no tracked) → deliveryStatus PENDING con un solo movimiento de inventario', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [
          { productId: productMixedTracked.id, quantity: '1.000' },
          { productId: productMixedNonTracked.id, quantity: '1.000' },
        ],
      });
      expect(sale.deliveryStatus).toBe(SaleDeliveryStatus.PENDING);
      expect(sale.inventoryMovements).toHaveLength(1);
      expect(sale.inventoryMovements[0].productId).toBe(productMixedTracked.id);
    });
  });

  // ==================================================================
  // Reglas de cantidad
  // ==================================================================
  describe('reglas de cantidad', () => {
    it('unidad allowDecimal=false: entero OK, fraccionario 400', async () => {
      const ok = await createDirectSale(adminCookie, {
        items: [{ productId: productNoDecimal.id, quantity: '1' }],
      });
      expect(ok.items[0].quantity).toBe('1.000');

      const rejected = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productNoDecimal.id, quantity: '1.5' }],
          }),
        );
      expect(rejected.status).toBe(400);
    });

    it('unidad allowDecimal=true: "1.250" es válido', async () => {
      const body = await createDirectSale(adminCookie, {
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
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productA.id, quantity }],
          }),
        );
      expect(response.status).toBe(400);
    });
  });

  // ==================================================================
  // Autoridad de precio del backend
  // ==================================================================
  describe('autoridad de precio del backend', () => {
    it('unitPrice/lineTotal en el payload → 400 (whitelist)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
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

    it('sin precio en el payload, unitPrice = Product.salePrice leído al confirmar', async () => {
      const body = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.items[0].unitPrice).toBe(productA.salePrice);
    });
  });

  // ==================================================================
  // Cálculo decimal
  // ==================================================================
  describe('cálculo decimal', () => {
    it('HALF_UP de línea, subtotal, descuento y total exactos (sin punto flotante)', async () => {
      const body = await createDirectSale(adminCookie, {
        discountAmount: '10.00',
        items: [
          { productId: productRounding.id, quantity: '0.500' }, // 0.500*0.01=0.005 -> HALF_UP -> 0.01
          { productId: productA.id, quantity: '2.000' }, // 2.000*19.99=39.98
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
      const body = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.discountAmount).toBe('0.00');
      expect(body.total).toBe(body.subtotal);
    });

    it('discountAmount = subtotal → total = "0.00"', async () => {
      const body = await createDirectSale(adminCookie, {
        discountAmount: productA.salePrice,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.total).toBe('0.00');
    });

    it('discountAmount > subtotal → 400', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
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
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(validCreateSaleBody({ discountAmount }));
        expect(response.status).toBe(400);
      },
    );

    it('desbordamiento monetario (quantity × salePrice máximo) → 409 controlado, sin escritura ni consumo de NV', async () => {
      const before = await currentSaleSequenceNumber();
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productOverflow.id, quantity: '2.000' }],
          }),
        );
      expect(response.status).toBe(409);
      assertNoLeakage(response);
      expect(await currentSaleSequenceNumber()).toBe(before);
    });
  });

  // ==================================================================
  // Resumen de pago derivado (D18)
  // ==================================================================
  describe('resumen de pago derivado', () => {
    it('total positivo → UNPAID, paidAmount "0.00", balanceDue = total', async () => {
      const body = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.paymentStatus).toBe(SalePaymentStatus.UNPAID);
      expect(body.paidAmount).toBe('0.00');
      expect(body.balanceDue).toBe(body.total);
    });

    it('total 0 (descuento = subtotal) → PAID, paidAmount "0.00", balanceDue "0.00"', async () => {
      const body = await createDirectSale(adminCookie, {
        discountAmount: productA.salePrice,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(body.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(body.paidAmount).toBe('0.00');
      expect(body.balanceDue).toBe('0.00');
    });
  });

  // ==================================================================
  // Promoción PROSPECT (D6)
  // ==================================================================
  describe('promoción de PROSPECT a CUSTOMER', () => {
    it('venta directa exitosa a un PROSPECT lo promueve a CUSTOMER con auditoría CUSTOMER_STAGE_CHANGED', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectCustomer.id },
      });
      expect(before.customerStage).toBe(CustomerStage.PROSPECT);

      await createDirectSale(adminCookie, { customerId: prospectCustomer.id });

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectCustomer.id },
      });
      expect(after.customerStage).toBe(CustomerStage.CUSTOMER);

      const audits = await fetchAuditRows(
        AuditAction.CUSTOMER_STAGE_CHANGED,
        'Customer',
        prospectCustomer.id,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toEqual({
        previousStage: CustomerStage.PROSPECT,
        customerStage: CustomerStage.CUSTOMER,
      });
      assertAuditRowHasNoSecrets(audits[0]);
    });

    it('dos ventas concurrentes al mismo PROSPECT: ambas confirman, pero exactamente una promoción (una sola auditoría)', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectConcurrencyCustomer.id },
      });
      expect(before.customerStage).toBe(CustomerStage.PROSPECT);

      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              customerId: prospectConcurrencyCustomer.id,
              items: [{ productId: productMultiA.id, quantity: '1.000' }],
            }),
          ),
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', sellerCookie)
          .send(
            validCreateSaleBody({
              customerId: prospectConcurrencyCustomer.id,
              items: [{ productId: productMultiB.id, quantity: '1.000' }],
            }),
          ),
      ]);
      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      createdSaleIds.push((first.body as SafeSaleBody).id);
      createdSaleIds.push((second.body as SafeSaleBody).id);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectConcurrencyCustomer.id },
      });
      expect(after.customerStage).toBe(CustomerStage.CUSTOMER);

      const audits = await fetchAuditRows(
        AuditAction.CUSTOMER_STAGE_CHANGED,
        'Customer',
        prospectConcurrencyCustomer.id,
      );
      expect(audits).toHaveLength(1);
    }, 30000);

    it('una venta fallida (stock insuficiente) NO promueve al PROSPECT: la transacción completa revierte', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectFailedCustomer.id },
      });
      expect(before.customerStage).toBe(CustomerStage.PROSPECT);

      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            customerId: prospectFailedCustomer.id,
            items: [{ productId: productOversale.id, quantity: '999.000' }],
          }),
        );
      expect(response.status).toBe(409);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectFailedCustomer.id },
      });
      expect(after.customerStage).toBe(CustomerStage.PROSPECT);

      const audits = await fetchAuditRows(
        AuditAction.CUSTOMER_STAGE_CHANGED,
        'Customer',
        prospectFailedCustomer.id,
      );
      expect(audits).toHaveLength(0);
    });
  });

  // ==================================================================
  // Descuento de stock exacto y atomicidad
  // ==================================================================
  describe('descuento de stock exacto y atomicidad', () => {
    it('stock insuficiente → 409, sin persistir Sale/SaleItem/InventoryMovement ni consumir NV', async () => {
      const before = await currentSaleSequenceNumber();
      const stockBefore = await prisma.product.findUniqueOrThrow({
        where: { id: productOversale.id },
      });

      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productOversale.id, quantity: '999.000' }],
          }),
        );
      expect(response.status).toBe(409);

      expect(await currentSaleSequenceNumber()).toBe(before);
      const stockAfter = await prisma.product.findUniqueOrThrow({
        where: { id: productOversale.id },
      });
      expect(stockAfter.stockCurrent.toFixed(3)).toBe(
        stockBefore.stockCurrent.toFixed(3),
      );
      const movements = await prisma.inventoryMovement.count({
        where: { productId: productOversale.id },
      });
      expect(movements).toBe(0);
    });

    it('fallo en el segundo ítem de una venta multi-ítem: atomicidad total (ningún movimiento del primer ítem persiste)', async () => {
      const dedicatedProduct = await prisma.product.create({
        data: {
          sku: `E2ES-ATOM-${nextSuffix()}`,
          name: `Producto Atomicidad E2E ${nextSuffix()}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('9.99'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('100.000'),
        },
      });
      createdProductIds.push(dedicatedProduct.id);
      const stockBefore = dedicatedProduct.stockCurrent;

      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [
              { productId: dedicatedProduct.id, quantity: '5.000' },
              { productId: productOversale.id, quantity: '999.000' },
            ],
          }),
        );
      expect(response.status).toBe(409);

      const stockAfter = await prisma.product.findUniqueOrThrow({
        where: { id: dedicatedProduct.id },
      });
      expect(stockAfter.stockCurrent.toFixed(3)).toBe(stockBefore.toFixed(3));
      const movements = await prisma.inventoryMovement.count({
        where: { productId: dedicatedProduct.id },
      });
      expect(movements).toBe(0);
    });

    it('descuenta exactamente la cantidad vendida y registra un movimiento EXIT/SALE con previousStock/newStock exactos', async () => {
      const dedicatedProduct = await prisma.product.create({
        data: {
          sku: `E2ES-EXACT-${nextSuffix()}`,
          name: `Producto Exacto E2E ${nextSuffix()}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('9.99'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('25.750'),
        },
      });
      createdProductIds.push(dedicatedProduct.id);

      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: dedicatedProduct.id, quantity: '5.250' }],
      });
      expect(sale.inventoryMovements).toHaveLength(1);
      const movement = sale.inventoryMovements[0];
      expect(movement.movementType).toBe(InventoryMovementType.EXIT);
      expect(movement.origin).toBe(InventoryMovementOrigin.SALE);
      expect(movement.quantity).toBe('5.250');
      expect(movement.previousStock).toBe('25.750');
      expect(movement.newStock).toBe('20.500');

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: dedicatedProduct.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('20.500');
    });
  });

  // ==================================================================
  // Concurrencia: sobreventa
  // ==================================================================
  describe('concurrencia: sobreventa (mismo producto)', () => {
    it('dos ventas concurrentes por el stock total disponible: exactamente una 201, la otra 409; stock final exacto; un solo EXIT', async () => {
      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              customerId: personActive.id,
              items: [{ productId: productOversale.id, quantity: '5.000' }],
            }),
          ),
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', sellerCookie)
          .send(
            validCreateSaleBody({
              customerId: companyActive.id,
              items: [{ productId: productOversale.id, quantity: '5.000' }],
            }),
          ),
      ]);

      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const winner = first.status === 201 ? first : second;
      createdSaleIds.push((winner.body as SafeSaleBody).id);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productOversale.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('0.000');

      const exits = await prisma.inventoryMovement.count({
        where: {
          productId: productOversale.id,
          movementType: InventoryMovementType.EXIT,
        },
      });
      expect(exits).toBe(1);
    }, 30000);
  });

  // ==================================================================
  // Concurrencia: múltiples productos, sin deadlock (orden inverso)
  // ==================================================================
  describe('concurrencia: múltiples productos en orden inverso, sin deadlock', () => {
    it('dos ventas concurrentes con los mismos dos productos en orden inverso del payload: ambas confirman', async () => {
      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              items: [
                { productId: productMultiA.id, quantity: '1.000' },
                { productId: productMultiB.id, quantity: '1.000' },
              ],
            }),
          ),
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', sellerCookie)
          .send(
            validCreateSaleBody({
              items: [
                { productId: productMultiB.id, quantity: '1.000' },
                { productId: productMultiA.id, quantity: '1.000' },
              ],
            }),
          ),
      ]);

      expect(first.status).toBe(201);
      expect(second.status).toBe(201);
      createdSaleIds.push((first.body as SafeSaleBody).id);
      createdSaleIds.push((second.body as SafeSaleBody).id);
    }, 30000);
  });

  // ==================================================================
  // Conversión de cotización — estados
  // ==================================================================
  describe('conversión de cotización — estados', () => {
    it('PENDING → 201; la cotización queda CONVERTED; sale.quote referencia la cotización', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        status: QuoteStatus.PENDING,
        items: [quoteItemFor(productA, '1.000')],
      });
      const sale = await convertQuoteOrThrow(adminCookie, quote.id);
      expect(sale.quote).toEqual({ id: quote.id, number: quote.number });

      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);
    });

    it('ACCEPTED → 201', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        status: QuoteStatus.ACCEPTED,
        items: [quoteItemFor(productA, '1.000')],
      });
      const sale = await convertQuoteOrThrow(adminCookie, quote.id);
      expect(sale.status).toBe(SaleStatus.ACTIVE);
    });

    it('REJECTED → 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        status: QuoteStatus.REJECTED,
        items: [quoteItemFor(productA, '1.000')],
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);
    });

    it('EXPIRED efectivo (derivado por fecha, almacenado PENDING) → 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        status: QuoteStatus.PENDING,
        issueDate: addDaysToDateOnly(businessToday(), -2),
        expirationDate: addDaysToDateOnly(businessToday(), -1),
        items: [quoteItemFor(productA, '1.000')],
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);

      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.PENDING);
    });

    it('EXPIRED almacenado físicamente → 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        status: QuoteStatus.EXPIRED,
        items: [quoteItemFor(productA, '1.000')],
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);
    });

    it('CONVERTED → 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        status: QuoteStatus.PENDING,
        items: [quoteItemFor(productA, '1.000')],
      });
      await convertQuoteOrThrow(adminCookie, quote.id);

      const secondAttempt = await convertQuote(adminCookie, quote.id);
      expect(secondAttempt.status).toBe(409);
    });
  });

  // ==================================================================
  // Una cotización — una venta, y concurrencia de doble conversión
  // ==================================================================
  describe('una cotización genera como máximo una venta', () => {
    it('segunda conversión de una cotización ya convertida → 409 ("ya generó una venta")', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      await convertQuoteOrThrow(adminCookie, quote.id);
      const second = await convertQuote(adminCookie, quote.id);
      expect(second.status).toBe(409);

      const sales = await prisma.sale.count({ where: { quoteId: quote.id } });
      expect(sales).toBe(1);
    });

    it('concurrencia: dos conversiones simultáneas de la MISMA cotización — exactamente una 201, la otra 409; una sola Sale', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        // P6-B2: cotización del SELLER que convierte (propiedad coherente; esta
        // prueba no es de autorización).
        sellerId,
        items: [quoteItemFor(productA, '1.000')],
      });

      const [first, second] = await Promise.all([
        convertQuote(adminCookie, quote.id),
        convertQuote(sellerCookie, quote.id),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([201, 409]);
      const winner = first.status === 201 ? first : second;
      createdSaleIds.push((winner.body as SafeSaleBody).id);

      const sales = await prisma.sale.count({ where: { quoteId: quote.id } });
      expect(sales).toBe(1);
    }, 30000);
  });

  // ==================================================================
  // Concurrencia: venta directa vs. conversión (carrera de stock)
  // ==================================================================
  describe('concurrencia: venta directa vs. conversión de cotización (carrera de stock del mismo producto)', () => {
    it('stock alcanza solo para una: exactamente una 201, la otra 409 por stock insuficiente', async () => {
      const quote = await createDirectQuote({
        customerId: companyActive.id,
        customerType: CustomerType.COMPANY,
        customerName: companyActive.name,
        // P6-B2: cotización del SELLER que convierte (propiedad coherente; esta
        // prueba no es de autorización).
        sellerId,
        items: [quoteItemFor(productRaceStock, '3.000')],
      });

      const [direct, conversion] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              customerId: personActive.id,
              items: [{ productId: productRaceStock.id, quantity: '3.000' }],
            }),
          ),
        convertQuote(sellerCookie, quote.id),
      ]);

      const statuses = [direct.status, conversion.status].sort();
      expect(statuses).toEqual([201, 409]);
      const winnerBody =
        direct.status === 201
          ? (direct.body as SafeSaleBody)
          : (conversion.body as SafeSaleBody);
      createdSaleIds.push(winnerBody.id);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productRaceStock.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('0.000');
    }, 30000);
  });

  // ==================================================================
  // Conversión — snapshot histórico (cliente + ítem/precio, D8/D9)
  // ==================================================================
  describe('conversión — snapshot histórico', () => {
    it('el snapshot de cliente de la venta proviene de la cotización, no del Customer vivo mutado después', async () => {
      const quote = await createDirectQuote({
        customerId: customerQuoteSnapshot.id,
        customerType: CustomerType.PERSON,
        customerDocumentType: CustomerDocumentType.DNI,
        customerDocumentNumber: customerQuoteSnapshot.documentNumber,
        customerName: customerQuoteSnapshot.name,
        customerAddress: customerQuoteSnapshot.address,
        items: [quoteItemFor(productA, '1.000')],
      });

      // Valores sufijados por corrida (nunca literales fijos): si una
      // corrida anterior falla a mitad de camino, un valor fijo dejaría un
      // documentNumber huérfano que colisionaría con el UNIQUE
      // (documentType, documentNumber) de esta misma corrida.
      const changedSuffix = nextSuffix();
      await prisma.customer.update({
        where: { id: customerQuoteSnapshot.id },
        data: {
          name: `Nombre Cambiado Vivo Venta ${changedSuffix}`,
          documentNumber: `CAMBIADOV${changedSuffix}`,
          address: `Direccion Cambiada Viva Venta ${changedSuffix}`,
        },
      });

      const sale = await convertQuoteOrThrow(adminCookie, quote.id);
      expect(sale.customerName).toBe(customerQuoteSnapshot.name);
      expect(sale.customerDocumentNumber).toBe(
        customerQuoteSnapshot.documentNumber,
      );
      expect(sale.customerAddress).toBe(customerQuoteSnapshot.address);
      expect(sale.customerName).not.toBe(
        `Nombre Cambiado Vivo Venta ${changedSuffix}`,
      );
    });

    it('los ítems de la venta copian EXACTAMENTE el snapshot del QuoteItem (sku/nombre/unidad/precio/lineTotal), nunca repreciados del catálogo vigente', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productQuoteItemSnapshot, '2.000', '25.00')],
      });

      await prisma.product.update({
        where: { id: productQuoteItemSnapshot.id },
        data: {
          sku: `${productQuoteItemSnapshot.sku}-CAMBIADO`,
          name: 'Nombre Producto Cambiado Vivo Venta',
          salePrice: new Prisma.Decimal('999.99'),
        },
      });

      const sale = await convertQuoteOrThrow(adminCookie, quote.id);
      const item = sale.items[0];
      expect(item.productSku).toBe(productQuoteItemSnapshot.sku);
      expect(item.productName).toBe(productQuoteItemSnapshot.name);
      expect(item.unitPrice).toBe('25.00');
      expect(item.lineTotal).toBe('50.00');
      expect(sale.subtotal).toBe('50.00');
      expect(sale.total).toBe('50.00');
    });
  });

  // ==================================================================
  // Conversión — sellerId (D10)
  // ==================================================================
  describe('conversión — sellerId', () => {
    it('sellerId de la venta es el de la cotización (quien la emitió), nunca el actor que ejecuta la conversión', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        sellerId,
        items: [quoteItemFor(productA, '1.000')],
      });
      const sale = await convertQuoteOrThrow(adminCookie, quote.id);
      expect(sale.seller.id).toBe(sellerId);
      expect(sale.seller.id).not.toBe(adminId);
    });
  });

  // ==================================================================
  // Conversión — revalidación de catálogo vigente
  // ==================================================================
  describe('conversión — revalidación de catálogo vigente', () => {
    it('producto pasa a INACTIVE tras crear la cotización → conversión 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productRevalProductInactive, '1.000')],
      });
      await prisma.product.update({
        where: { id: productRevalProductInactive.id },
        data: { status: ProductStatus.INACTIVE },
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);
    });

    it('categoría pasa a INACTIVE tras crear la cotización → conversión 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productRevalCategoryInactive, '1.000')],
      });
      await prisma.category.update({
        where: { id: categoryMutableConversionId },
        data: { status: CategoryStatus.INACTIVE },
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);
    });

    it('unidad pasa a INACTIVE tras crear la cotización → conversión 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productRevalUnitInactive, '1.000')],
      });
      await prisma.unit.update({
        where: { id: unitMutableConversionId },
        data: { status: UnitStatus.INACTIVE },
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);
    });

    it('unidad pierde allowDecimal tras crear una cotización con cantidad fraccionaria → conversión 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productRevalAllowDecimalChange, '1.500')],
      });
      await prisma.unit.update({
        where: { id: unitAllowDecimalMutableId },
        data: { allowDecimal: false },
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);
    });

    it('stock actual insuficiente al momento de convertir → 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productRevalStockInsufficient, '5.000')],
      });
      const response = await convertQuote(adminCookie, quote.id);
      expect(response.status).toBe(409);
    });
  });

  // ==================================================================
  // Auditoría — confirmación (directa/conversión) y conversión de cotización
  // ==================================================================
  describe('auditoría — confirmación y conversión', () => {
    it('venta directa: SALE_CONFIRMED con source=DIRECT, sin quoteId, sin PII/montos', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const audits = await fetchAuditRows(
        AuditAction.SALE_CONFIRMED,
        'Sale',
        sale.id,
      );
      expect(audits).toHaveLength(1);
      const metadata = audits[0].metadata as Record<string, unknown>;
      expect(metadata.source).toBe('DIRECT');
      expect(metadata.saleNumber).toBe(sale.number);
      expect(metadata.itemCount).toBe(1);
      expect(metadata.quoteId).toBeUndefined();
      assertAuditRowHasNoSecrets(audits[0]);
    });

    it('venta desde cotización: SALE_CONFIRMED con source=QUOTE + quoteId; QUOTE_CONVERTED en la cotización', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const sale = await convertQuoteOrThrow(adminCookie, quote.id);

      const saleAudits = await fetchAuditRows(
        AuditAction.SALE_CONFIRMED,
        'Sale',
        sale.id,
      );
      expect(saleAudits).toHaveLength(1);
      const saleMetadata = saleAudits[0].metadata as Record<string, unknown>;
      expect(saleMetadata.source).toBe('QUOTE');
      expect(saleMetadata.quoteId).toBe(quote.id);

      const quoteAudits = await fetchAuditRows(
        AuditAction.QUOTE_CONVERTED,
        'Quote',
        quote.id,
      );
      expect(quoteAudits).toHaveLength(1);
      expect(quoteAudits[0].metadata).toEqual({
        quoteNumber: quote.number,
        saleNumber: sale.number,
      });
      assertAuditRowHasNoSecrets(quoteAudits[0]);
    });
  });

  // ==================================================================
  // Entrega (D12/D13/D14)
  // ==================================================================
  describe('entrega', () => {
    it('venta con ítem inventariable: deliveryStatus inicial PENDING; venta sin ítems inventariables: NOT_APPLICABLE', async () => {
      const tracked = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      expect(tracked.deliveryStatus).toBe(SaleDeliveryStatus.PENDING);

      const notApplicable = await createDirectSale(adminCookie, {
        items: [{ productId: productService.id, quantity: '1.000' }],
      });
      expect(notApplicable.deliveryStatus).toBe(
        SaleDeliveryStatus.NOT_APPLICABLE,
      );
    });

    it('PENDING → DELIVERED (200); DELIVERED es terminal (segundo intento 409)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const delivered = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      expect(delivered.status).toBe(200);
      expect((delivered.body as SafeSaleBody).deliveryStatus).toBe(
        SaleDeliveryStatus.DELIVERED,
      );

      const again = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      expect(again.status).toBe(409);
    });

    it('PENDING → OBSERVED → DELIVERED; OBSERVED no puede volver a OBSERVED', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const observed = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-observed`)
        .set('Cookie', adminCookie);
      expect(observed.status).toBe(200);
      expect((observed.body as SafeSaleBody).deliveryStatus).toBe(
        SaleDeliveryStatus.OBSERVED,
      );

      const observedAgain = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-observed`)
        .set('Cookie', adminCookie);
      expect(observedAgain.status).toBe(409);

      const delivered = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      expect(delivered.status).toBe(200);
      expect((delivered.body as SafeSaleBody).deliveryStatus).toBe(
        SaleDeliveryStatus.DELIVERED,
      );
    });

    it('NOT_APPLICABLE no admite mark-delivered ni mark-observed (409)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productService.id, quantity: '1.000' }],
      });
      const delivered = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      expect(delivered.status).toBe(409);

      const observed = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-observed`)
        .set('Cookie', adminCookie);
      expect(observed.status).toBe(409);
    });

    it('auditoría SALE_DELIVERY_STATUS_CHANGED con previousDeliveryStatus/deliveryStatus exactos', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-observed`)
        .set('Cookie', adminCookie);

      const audits = await fetchAuditRows(
        AuditAction.SALE_DELIVERY_STATUS_CHANGED,
        'Sale',
        sale.id,
      );
      expect(audits).toHaveLength(1);
      expect(audits[0].metadata).toEqual({
        saleNumber: sale.number,
        previousDeliveryStatus: SaleDeliveryStatus.PENDING,
        deliveryStatus: SaleDeliveryStatus.OBSERVED,
      });
    });

    it('marcar entrega/observación nunca crea InventoryMovement', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const before = await prisma.inventoryMovement.count();
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      const after = await prisma.inventoryMovement.count();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // Anulación
  // ==================================================================
  describe('anulación', () => {
    it('venta ACTIVE se anula: 200, status CANCELLED, cancelledAt/cancellationReason/cancelledBy poblados, stock restaurado', async () => {
      const dedicatedProduct = await prisma.product.create({
        data: {
          sku: `E2ES-CANC-${nextSuffix()}`,
          name: `Producto Anulacion E2E ${nextSuffix()}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('9.99'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('50.000'),
        },
      });
      createdProductIds.push(dedicatedProduct.id);

      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: dedicatedProduct.id, quantity: '10.000' }],
      });
      const afterSale = await prisma.product.findUniqueOrThrow({
        where: { id: dedicatedProduct.id },
      });
      expect(afterSale.stockCurrent.toFixed(3)).toBe('40.000');

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Cliente se arrepintió del pedido' });
      expect(response.status).toBe(200);
      const body = response.body as SafeSaleBody;
      expect(body.status).toBe(SaleStatus.CANCELLED);
      expect(body.cancelledAt).not.toBeNull();
      expect(body.cancellationReason).toBe('Cliente se arrepintió del pedido');
      expect(body.cancelledBy?.id).toBe(adminId);

      const afterCancel = await prisma.product.findUniqueOrThrow({
        where: { id: dedicatedProduct.id },
      });
      expect(afterCancel.stockCurrent.toFixed(3)).toBe('50.000');

      expect(body.inventoryMovements).toHaveLength(2);
      const reversal = body.inventoryMovements.find(
        (m) => m.origin === InventoryMovementOrigin.SALE_CANCELLATION,
      );
      expect(reversal?.movementType).toBe(InventoryMovementType.ENTRY);
      expect(reversal?.quantity).toBe('10.000');
    });

    it('motivo ausente/vacío/solo espacios → 400; motivo > 200 caracteres → 400', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const server = app.getHttpServer();

      const missing = await request(server)
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({});
      expect(missing.status).toBe(400);

      const blank = await request(server)
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: '   ' });
      expect(blank.status).toBe(400);

      const tooLong = await request(server)
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'x'.repeat(201) });
      expect(tooLong.status).toBe(400);

      const stillActive = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(stillActive.status).toBe(SaleStatus.ACTIVE);
    });

    it('segunda anulación de la misma venta → 409, sin duplicar reversas ni auditoría', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'primera anulación' });

      const second = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'segunda anulación' });
      expect(second.status).toBe(409);

      const audits = await fetchAuditRows(
        AuditAction.SALE_CANCELLED,
        'Sale',
        sale.id,
      );
      expect(audits).toHaveLength(1);
      const reversals = await prisma.inventoryMovement.count({
        where: {
          referenceType: 'Sale',
          referenceId: sale.id,
          origin: InventoryMovementOrigin.SALE_CANCELLATION,
        },
      });
      expect(reversals).toBe(1);
    });

    it('concurrencia: dos anulaciones simultáneas — exactamente una 200, la otra 409; una sola reversa, una sola auditoría', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const [first, second] = await Promise.all([
        request(app.getHttpServer())
          .post(`/api/v1/sales/${sale.id}/cancel`)
          .set('Cookie', adminCookie)
          .send({ reason: 'anulación concurrente A' }),
        request(app.getHttpServer())
          .post(`/api/v1/sales/${sale.id}/cancel`)
          .set('Cookie', adminCookie)
          .send({ reason: 'anulación concurrente B' }),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const audits = await fetchAuditRows(
        AuditAction.SALE_CANCELLED,
        'Sale',
        sale.id,
      );
      expect(audits).toHaveLength(1);
      const reversals = await prisma.inventoryMovement.count({
        where: {
          referenceType: 'Sale',
          referenceId: sale.id,
          origin: InventoryMovementOrigin.SALE_CANCELLATION,
        },
      });
      expect(reversals).toBe(1);
    }, 30000);

    it('anulación no afecta la cotización de origen: permanece CONVERTED', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const sale = await convertQuoteOrThrow(adminCookie, quote.id);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación tras conversión' });

      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);
    });

    it('venta anulada rechaza mark-delivered/mark-observed (409); deliveryStatus queda congelado', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const cancelled = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación antes de entrega' });
      const deliveryStatusAtCancellation = (cancelled.body as SafeSaleBody)
        .deliveryStatus;

      const delivered = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      expect(delivered.status).toBe(409);
      const observed = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-observed`)
        .set('Cookie', adminCookie);
      expect(observed.status).toBe(409);

      const row = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(row.deliveryStatus).toBe(deliveryStatusAtCancellation);
    });

    it('venta sobre producto no inventariable: anulación no crea ninguna reversa (sin movimiento original)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productCancelNonInventory.id, quantity: '1.000' }],
      });
      expect(sale.inventoryMovements).toHaveLength(0);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación sin stock' });
      expect(response.status).toBe(200);
      expect((response.body as SafeSaleBody).inventoryMovements).toHaveLength(
        0,
      );
    });
  });

  // ==================================================================
  // Anulación — bypass histórico ante mutaciones vivas (D22)
  // ==================================================================
  describe('anulación — bypass histórico ante mutaciones vivas del catálogo', () => {
    it('un movimiento MANUAL no relacionado antes de anular: la reversa SUMA sobre el stock vigente, nunca resetea a un snapshot', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [
          { productId: productCancelUnrelatedStock.id, quantity: '5.000' },
        ],
      });
      const afterSale = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelUnrelatedStock.id },
      });
      expect(afterSale.stockCurrent.toFixed(3)).toBe('15.000');

      const entry = await request(app.getHttpServer())
        .post('/api/v1/inventory/entries')
        .set('Cookie', adminCookie)
        .send({
          productId: productCancelUnrelatedStock.id,
          quantity: '3.000',
          reason: 'Ingreso no relacionado antes de anulación',
        });
      expect(entry.status).toBe(201);
      const afterEntry = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelUnrelatedStock.id },
      });
      expect(afterEntry.stockCurrent.toFixed(3)).toBe('18.000');

      const cancel = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación tras ingreso no relacionado' });
      expect(cancel.status).toBe(200);

      const afterCancel = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelUnrelatedStock.id },
      });
      // 18.000 (tras el ingreso no relacionado) + 5.000 (reversa) = 23.000.
      expect(afterCancel.stockCurrent.toFixed(3)).toBe('23.000');
    });

    it('producto pasado a INACTIVE tras la venta: la anulación igual restaura el stock (bypass D22)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [
          { productId: productCancelProductInactive.id, quantity: '4.000' },
        ],
      });
      await prisma.product.update({
        where: { id: productCancelProductInactive.id },
        data: { status: ProductStatus.INACTIVE },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación con producto inactivo' });
      expect(response.status).toBe(200);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelProductInactive.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('20.000');
    });

    it('categoría pasada a INACTIVE tras la venta: la anulación igual restaura el stock', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [
          { productId: productCancelCategoryInactive.id, quantity: '4.000' },
        ],
      });
      await prisma.category.update({
        where: { id: categoryMutableCancelId },
        data: { status: CategoryStatus.INACTIVE },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación con categoría inactiva' });
      expect(response.status).toBe(200);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelCategoryInactive.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('20.000');

      // Restaura para no afectar otras pruebas que reutilicen esta categoría.
      await prisma.category.update({
        where: { id: categoryMutableCancelId },
        data: { status: CategoryStatus.ACTIVE },
      });
    });

    it('unidad pasada a INACTIVE tras la venta: la anulación igual restaura el stock', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productCancelUnitInactive.id, quantity: '4.000' }],
      });
      await prisma.unit.update({
        where: { id: unitMutableCancelId },
        data: { status: UnitStatus.INACTIVE },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación con unidad inactiva' });
      expect(response.status).toBe(200);

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelUnitInactive.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('20.000');
    });

    it('isInventoryTracked cambia a false tras la venta: la reversa igual se aplica (se basa en el movimiento SALE histórico, no en el Product vigente)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [
          { productId: productCancelTrackingChange.id, quantity: '4.000' },
        ],
      });
      expect(sale.inventoryMovements).toHaveLength(1);

      await prisma.product.update({
        where: { id: productCancelTrackingChange.id },
        data: { isInventoryTracked: false },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación tras cambio de configuración de tracking' });
      expect(response.status).toBe(200);
      expect((response.body as SafeSaleBody).inventoryMovements).toHaveLength(
        2,
      );

      const productRow = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelTrackingChange.id },
      });
      expect(productRow.stockCurrent.toFixed(3)).toBe('20.000');
    });

    it('reversa fraccionaria: precisión decimal exacta de ida y vuelta (10.500 → 7.250 → 10.500)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productCancelFractional.id, quantity: '3.250' }],
      });
      const afterSale = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelFractional.id },
      });
      expect(afterSale.stockCurrent.toFixed(3)).toBe('7.250');

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación fraccionaria' });
      expect(response.status).toBe(200);

      const afterCancel = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelFractional.id },
      });
      expect(afterCancel.stockCurrent.toFixed(3)).toBe('10.500');
    });
  });

  // ==================================================================
  // Generación concurrente de NV
  // ==================================================================
  describe('generación concurrente de NV — HTTP real', () => {
    it('dos ventas concurrentes obtienen números distintos y consecutivos (before+1, before+2)', async () => {
      const before = await currentSaleSequenceNumber();

      const [responseA, responseB] = await Promise.all([
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              items: [{ productId: productMultiA.id, quantity: '1.000' }],
            }),
          ),
        request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', sellerCookie)
          .send(
            validCreateSaleBody({
              items: [{ productId: productMultiB.id, quantity: '1.000' }],
            }),
          ),
      ]);

      expect(responseA.status).toBe(201);
      expect(responseB.status).toBe(201);
      createdSaleIds.push((responseA.body as SafeSaleBody).id);
      createdSaleIds.push((responseB.body as SafeSaleBody).id);

      const numberA = (responseA.body as SafeSaleBody).number;
      const numberB = (responseB.body as SafeSaleBody).number;
      expect(numberA).not.toBe(numberB);

      const expectedSet = new Set([
        `NV-${String(before + 1).padStart(6, '0')}`,
        `NV-${String(before + 2).padStart(6, '0')}`,
      ]);
      expect(expectedSet.has(numberA)).toBe(true);
      expect(expectedSet.has(numberB)).toBe(true);

      const after = await currentSaleSequenceNumber();
      expect(after).toBe(before + 2);
    }, 30000);
  });

  // ==================================================================
  // Rollback de secuencia NV (instancia real de DocumentSequenceService)
  // ==================================================================
  describe('rollback de secuencia NV', () => {
    it('un error dentro de la transacción revierte el incremento del correlativo', async () => {
      const before = await currentSaleSequenceNumber();
      const documentSequenceService = app.get(DocumentSequenceService);

      await expect(
        prisma.$transaction(async (tx) => {
          await documentSequenceService.next(tx, DocumentType.SALE);
          throw new Error('forced rollback for E2E');
        }),
      ).rejects.toThrow('forced rollback for E2E');

      const after = await currentSaleSequenceNumber();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // No consumo de NV en solicitudes rechazadas
  // ==================================================================
  describe('no consumo de NV en solicitudes rechazadas', () => {
    it('cliente genérico con deuda, cliente inactivo, productos duplicados, producto inactivo y stock insuficiente no avanzan currentNumber', async () => {
      const before = await currentSaleSequenceNumber();

      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: genericCustomerId }));
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: inactiveCustomer.id }));
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [
              { productId: productA.id, quantity: '1.000' },
              { productId: productA.id, quantity: '2.000' },
            ],
          }),
        );
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productInactive.id, quantity: '1.000' }],
          }),
        );
      await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productOversale.id, quantity: '9999.000' }],
          }),
        );

      const after = await currentSaleSequenceNumber();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // Paginación
  // ==================================================================
  describe('paginación', () => {
    beforeAll(async () => {
      for (let i = 0; i < 5; i += 1) {
        await createDirectSale(adminCookie, {
          customerId: paginationCustomer.id,
          items: [{ productId: productA.id, quantity: '1.000' }],
        });
      }
    }, 30000);

    it('page/limit controlan la ventana; totalPages es consistente', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: paginationCustomer.id, page: 1, limit: 2 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeSaleListItemBody>;
      expect(body.data).toHaveLength(2);
      expect(body.page).toBe(1);
      expect(body.limit).toBe(2);
      expect(body.total).toBe(5);
      expect(body.totalPages).toBe(3);
    });

    it('limit > 100 → 400 (@Max(100) del DTO)', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: paginationCustomer.id, limit: 500 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(400);
    });

    it('limit = 100 se acepta', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: paginationCustomer.id, limit: 100 })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect((response.body as PaginatedBody<SafeSaleListItemBody>).limit).toBe(
        100,
      );
    });
  });

  // ==================================================================
  // Búsqueda
  // ==================================================================
  describe('búsqueda', () => {
    it('por número, nombre de cliente y documento de cliente (insensible a mayúsculas)', async () => {
      const sale = await createDirectSale(adminCookie, {
        customerId: searchCustomer.id,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });

      const byNumber = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ search: sale.number.toLowerCase() })
        .set('Cookie', adminCookie);
      expect(
        (byNumber.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);

      const byName = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ search: searchCustomer.name.toUpperCase() })
        .set('Cookie', adminCookie);
      expect(
        (byName.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);

      const byDocument = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ search: searchCustomer.documentNumber })
        .set('Cookie', adminCookie);
      expect(
        (byDocument.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);
    });
  });

  // ==================================================================
  // Filtros
  // ==================================================================
  describe('filtros', () => {
    it('status/deliveryStatus/customerId/sellerId/quoteId filtran correctamente', async () => {
      const sale = await createDirectSale(sellerCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });

      const byStatus = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ status: SaleStatus.ACTIVE, sellerId })
        .set('Cookie', adminCookie);
      expect(
        (byStatus.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);

      const byDelivery = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ deliveryStatus: SaleDeliveryStatus.PENDING, sellerId })
        .set('Cookie', adminCookie);
      expect(
        (byDelivery.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);

      const byCustomer = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: sale.customerId })
        .set('Cookie', adminCookie);
      expect(
        (byCustomer.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);

      const bySeller = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ sellerId })
        .set('Cookie', adminCookie);
      expect(
        (bySeller.body as PaginatedBody<SafeSaleListItemBody>).data.every(
          (row) => row.sellerId === sellerId,
        ),
      ).toBe(true);

      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const converted = await convertQuoteOrThrow(adminCookie, quote.id);
      const byQuote = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ quoteId: quote.id })
        .set('Cookie', adminCookie);
      const quoteResults = (byQuote.body as PaginatedBody<SafeSaleListItemBody>)
        .data;
      expect(quoteResults).toHaveLength(1);
      expect(quoteResults[0].id).toBe(converted.id);
    });

    it('confirmedFrom > confirmedTo → 400', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({
          confirmedFrom: addDaysToDateOnly(businessToday(), 1),
          confirmedTo: businessToday(),
        })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(400);
    });

    it('paymentStatus=PARTIALLY_PAID: fila estructuralmente válida mutada directamente (sin modelo Payment) sí aparece con ese filtro', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      await prisma.sale.update({
        where: { id: sale.id },
        data: {
          paymentStatus: SalePaymentStatus.PARTIALLY_PAID,
          paidAmount: new Prisma.Decimal('10.00'),
          balanceDue: new Prisma.Decimal(sale.total).minus('10.00'),
        },
      });

      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ paymentStatus: SalePaymentStatus.PARTIALLY_PAID })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(
        (response.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);
    });
  });

  // ==================================================================
  // Frontera de fecha de negocio America/Lima (confirmedFrom/confirmedTo)
  // ==================================================================
  describe('frontera de fecha de negocio America/Lima', () => {
    it('confirmedAt en el límite inferior incluye; en el límite superior exclusivo excluye', async () => {
      const targetDate = businessToday();
      const inclusiveStart = startOfBusinessDayUtc(targetDate);
      const exclusiveEnd = endOfBusinessDayExclusiveUtc(targetDate);

      const sale = await createDirectSale(adminCookie, {
        customerId: businessDateCustomer.id,
        items: [{ productId: productBusinessDate.id, quantity: '1.000' }],
      });

      await prisma.sale.update({
        where: { id: sale.id },
        data: { confirmedAt: inclusiveStart },
      });
      const includedAtStart = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({
          customerId: businessDateCustomer.id,
          confirmedFrom: targetDate,
        })
        .set('Cookie', adminCookie);
      expect(
        (includedAtStart.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(true);

      await prisma.sale.update({
        where: { id: sale.id },
        data: { confirmedAt: new Date(exclusiveEnd.getTime() - 1) },
      });
      const includedBeforeEnd = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: businessDateCustomer.id, confirmedTo: targetDate })
        .set('Cookie', adminCookie);
      expect(
        (
          includedBeforeEnd.body as PaginatedBody<SafeSaleListItemBody>
        ).data.some((row) => row.id === sale.id),
      ).toBe(true);

      await prisma.sale.update({
        where: { id: sale.id },
        data: { confirmedAt: exclusiveEnd },
      });
      const excludedAtEnd = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: businessDateCustomer.id, confirmedTo: targetDate })
        .set('Cookie', adminCookie);
      expect(
        (excludedAtEnd.body as PaginatedBody<SafeSaleListItemBody>).data.some(
          (row) => row.id === sale.id,
        ),
      ).toBe(false);
    });
  });

  // ==================================================================
  // Contrato de respuesta seguro
  // ==================================================================
  describe('contrato de respuesta seguro', () => {
    it('detalle: claves exactas en Sale/items/movements/seller, sin campos internos', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Cookie', adminCookie);
      const body = response.body as SafeSaleBody;

      expect(Object.keys(body).sort()).toEqual(SAFE_SALE_DETAIL_KEYS);
      expect(Object.keys(body.items[0]).sort()).toEqual(SAFE_SALE_ITEM_KEYS);
      expect(Object.keys(body.seller).sort()).toEqual(SAFE_SALE_SELLER_KEYS);
      expect(Object.keys(body.inventoryMovements[0]).sort()).toEqual(
        SAFE_SALE_MOVEMENT_KEYS,
      );

      const serialized = JSON.stringify(body).toLowerCase();
      expect(serialized).not.toMatch(/passwordhash|roleid|deletedat/);
    });

    it('listado: claves exactas por fila', async () => {
      await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ limit: 1 })
        .set('Cookie', adminCookie);
      const body = response.body as PaginatedBody<SafeSaleListItemBody>;
      expect(Object.keys(body.data[0]).sort()).toEqual(
        SAFE_SALE_LIST_ITEM_KEYS,
      );
    });

    // ================================================================
    // Fase 9, Bloque A (R1) — proyección segura de vendedor en el listado.
    // ================================================================
    it('listado: incluye seller con identidad segura mínima exacta; sellerId se conserva; sin fuga de campos de seguridad', async () => {
      const sale = await createDirectSale(adminCookie, {
        customerId: personActive.id,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: personActive.id, sellerId: adminId })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<SafeSaleListItemBody>;
      const row = body.data.find((r) => r.id === sale.id);
      expect(row).toBeDefined();
      expect(row?.sellerId).toBe(adminId);
      expect(Object.keys(row!.seller).sort()).toEqual(SAFE_SALE_SELLER_KEYS);
      expect(row?.seller.id).toBe(adminId);
      expect(row?.seller).toEqual({
        id: adminId,
        username: E2E_ADMIN_USERNAME,
        firstName: expect.any(String) as string,
        lastName: expect.any(String) as string,
      });
      const serialized = JSON.stringify(row?.seller).toLowerCase();
      expect(serialized).not.toMatch(
        /email|role|status|passwordhash|mustchangepassword|failedloginattempts|blockedat|lastloginat/,
      );
    });

    it('listado: una venta CANCELLED permanece visible por defecto (sin filtro implícito de status)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const cancelResponse = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación fixture R1' });
      expect(cancelResponse.status).toBe(200);

      const response = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ customerId: sale.customerId })
        .set('Cookie', adminCookie);
      const body = response.body as PaginatedBody<SafeSaleListItemBody>;
      const row = body.data.find((r) => r.id === sale.id);
      expect(row).toBeDefined();
      expect(row?.status).toBe(SaleStatus.CANCELLED);
      expect(row?.seller).toBeDefined();
    });

    it('el detalle incluye el resumen de movimientos de inventario (segunda consulta, sin FK)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '2.000' }],
      });
      expect(sale.inventoryMovements).toHaveLength(1);
      expect(sale.inventoryMovements[0].origin).toBe(
        InventoryMovementOrigin.SALE,
      );
    });
  });

  // ==================================================================
  // Auditoría — sin rastro para operaciones de solo lectura
  // ==================================================================
  describe('auditoría — sin rastro para operaciones de solo lectura', () => {
    it('listar/leer/imprimir una venta no genera ninguna fila de auditoría', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const before = await prisma.auditLog.count({
        where: { entityType: 'Sale', entityId: sale.id },
      });

      await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);

      const after = await prisma.auditLog.count({
        where: { entityType: 'Sale', entityId: sale.id },
      });
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // Atomicidad de mutaciones fallidas
  // ==================================================================
  describe('atomicidad de mutaciones fallidas', () => {
    it('transición de entrega inválida no altera la fila ni genera auditoría nueva', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      const before = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(409);

      const after = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(after.updatedAt.getTime()).toBe(before.updatedAt.getTime());
      const audits = await prisma.auditLog.count({
        where: {
          action: AuditAction.SALE_DELIVERY_STATUS_CHANGED,
          entityType: 'Sale',
          entityId: sale.id,
        },
      });
      expect(audits).toBe(1);
    });

    it('cliente genérico con deuda rechazado no crea Sale ni consume NV', async () => {
      const before = await currentSaleSequenceNumber();
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: genericCustomerId }));
      expect(response.status).toBe(409);
      const after = await currentSaleSequenceNumber();
      expect(after).toBe(before);
      const orphanSales = await prisma.sale.count({
        where: { customerId: genericCustomerId, total: { gt: 0 } },
      });
      expect(orphanSales).toBe(0);
    });
  });

  // ==================================================================
  // Endpoint de impresión
  // ==================================================================
  describe('endpoint de impresión', () => {
    it('200, Content-Type text/html, cuerpo no vacío con número/cliente/producto/totales, sin datos de pago/inventario', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      expect(response.headers['content-type']).toMatch(/^text\/html/);
      expect(response.text.length).toBeGreaterThan(0);
      expect(response.text).toContain(sale.number);
      expect(response.text).toContain(sale.customerName);
      expect(response.text).toContain(sale.items[0].productName);
      expect(response.text).toContain(sale.total);
      expect(response.text.toLowerCase()).not.toMatch(
        /paidamount|balancedue|paymentstatus|previousstock|newstock/,
      );
    });

    it('DOCUMENTO INTERNO — NO FISCAL; venta CANCELLED marca ANULADA/CANCELLED con el mismo número', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const printActive = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);
      expect(printActive.text).toContain('DOCUMENTO INTERNO');
      expect(printActive.text).not.toContain('ANULADA');

      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'anulación antes de imprimir' });

      const printCancelled = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);
      expect(printCancelled.status).toBe(200);
      expect(printCancelled.text).toContain('ANULADA');
      expect(printCancelled.text).toContain('CANCELLED');
      expect(printCancelled.text).toContain(sale.number);
    });

    it('MANAGEMENT → 200; WAREHOUSE → 403', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const management = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', managementCookie);
      expect(management.status).toBe(200);

      const warehouse = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', warehouseCookie);
      expect(warehouse.status).toBe(403);
    });

    it('conserva el snapshot histórico incluso tras mutar Customer/Product vivos', async () => {
      const sale = await createDirectSale(adminCookie, {
        customerId: personActive.id,
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const originalCustomerName = sale.customerName;
      const originalProductName = sale.items[0].productName;

      await prisma.customer.update({
        where: { id: personActive.id },
        data: { name: 'Cliente Vivo Cambiado Print Venta' },
      });
      await prisma.product.update({
        where: { id: productA.id },
        data: { name: 'Producto Vivo Cambiado Print Venta' },
      });

      const response = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);
      expect(response.text).toContain(originalCustomerName);
      expect(response.text).toContain(originalProductName);
      expect(response.text).not.toContain('Cliente Vivo Cambiado Print Venta');
      expect(response.text).not.toContain('Producto Vivo Cambiado Print Venta');

      await prisma.customer.update({
        where: { id: personActive.id },
        data: { name: originalCustomerName },
      });
      await prisma.product.update({
        where: { id: productA.id },
        data: { name: originalProductName },
      });
    });

    it('escapa HTML: XSS en snapshot de cliente y producto, sin etiquetas ejecutables', async () => {
      const sale = await createDirectSale(adminCookie, {
        customerId: xssCustomer.id,
        items: [{ productId: productXss.id, quantity: '1.000' }],
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);

      expect(response.text).not.toContain('<script>alert(1)</script>');
      expect(response.text.toLowerCase()).not.toContain('<script>alert');
      expect(response.text).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(response.text).toContain('A&amp;B');
      expect(response.text).toContain('&quot;Q&quot;');
      expect(response.text).toContain('O&#39;Brien');
    });
  });

  // ==================================================================
  // Restricciones directas de PostgreSQL — 22 CHECK constraints
  // ==================================================================
  describe('restricciones directas de PostgreSQL — 22 CHECK constraints', () => {
    let checkSaleId: string;

    beforeAll(async () => {
      checkSaleId = await directValidSale(`CHK-SAL-BASE-${nextSuffix()}`);
    }, 30000);

    it('1. sales_number_not_blank', async () => {
      await expectPgRejection(() => rawInsertSale({ number: '   ' }), '23514');
    });

    it('2. sales_customer_type_generic_consistency', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK2-${nextSuffix()}`,
            customerIsGeneric: false,
            customerType: null,
          }),
        '23514',
      );
    });

    it('3. sales_customer_document_pair', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK3-${nextSuffix()}`,
            customerDocumentType: CustomerDocumentType.DNI,
            customerDocumentNumber: null,
          }),
        '23514',
      );
    });

    it('4. sales_generic_no_document', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK4-${nextSuffix()}`,
            customerIsGeneric: true,
            customerType: null,
            customerDocumentType: CustomerDocumentType.DNI,
            customerDocumentNumber: '999',
          }),
        '23514',
      );
    });

    it('5. sales_generic_no_debt', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK5-${nextSuffix()}`,
            customerIsGeneric: true,
            customerType: null,
            paymentStatus: SalePaymentStatus.UNPAID,
            subtotal: '10.00',
            total: '10.00',
            paidAmount: '0.00',
            balanceDue: '10.00',
          }),
        '23514',
      );
    });

    it('6. sales_customer_name_not_blank', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK6-${nextSuffix()}`,
            customerName: '   ',
          }),
        '23514',
      );
    });

    it('7. sales_subtotal_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({ number: `CHK7-${nextSuffix()}`, subtotal: '-1.00' }),
        '23514',
      );
    });

    it('8. sales_discount_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK8-${nextSuffix()}`,
            discountAmount: '-1.00',
          }),
        '23514',
      );
    });

    it('9. sales_tax_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({ number: `CHK9-${nextSuffix()}`, taxAmount: '-1.00' }),
        '23514',
      );
    });

    it('10. sales_total_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({ number: `CHK10-${nextSuffix()}`, total: '-1.00' }),
        '23514',
      );
    });

    it('11. sales_discount_within_subtotal', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK11-${nextSuffix()}`,
            subtotal: '5.00',
            discountAmount: '10.00',
            total: '-5.00',
          }),
        '23514',
      );
    });

    it('12. sales_total_arithmetic', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK12-${nextSuffix()}`,
            subtotal: '10.00',
            discountAmount: '0.00',
            taxAmount: '0.00',
            total: '5.00',
            paidAmount: '5.00',
            balanceDue: '0.00',
          }),
        '23514',
      );
    });

    it('13. sales_paid_amount_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK13-${nextSuffix()}`,
            paidAmount: '-1.00',
          }),
        '23514',
      );
    });

    it('14. sales_balance_due_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK14-${nextSuffix()}`,
            balanceDue: '-1.00',
          }),
        '23514',
      );
    });

    it('15. sales_paid_within_total', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK15-${nextSuffix()}`,
            subtotal: '10.00',
            total: '10.00',
            paidAmount: '20.00',
            balanceDue: '0.00',
          }),
        '23514',
      );
    });

    it('16. sales_paid_balance_arithmetic', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK16-${nextSuffix()}`,
            subtotal: '10.00',
            total: '10.00',
            paidAmount: '3.00',
            balanceDue: '3.00',
          }),
        '23514',
      );
    });

    it('17. sales_payment_status_consistency', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK17-${nextSuffix()}`,
            subtotal: '10.00',
            total: '10.00',
            paymentStatus: SalePaymentStatus.UNPAID,
            paidAmount: '5.00',
            balanceDue: '5.00',
          }),
        '23514',
      );
    });

    it('18. sales_cancellation_consistency', async () => {
      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK18-${nextSuffix()}`,
            status: SaleStatus.ACTIVE,
            cancelledAt: new Date(),
          }),
        '23514',
      );
    });

    it('19. sale_items_quantity_positive', async () => {
      await expectPgRejection(
        () =>
          rawInsertSaleItem({
            saleId: checkSaleId,
            productId: productA.id,
            quantity: '0',
            unitPrice: '10.00',
            lineTotal: '0.00',
          }),
        '23514',
      );
    });

    it('20. sale_items_unit_price_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSaleItem({
            saleId: checkSaleId,
            productId: productA.id,
            quantity: '1',
            unitPrice: '-10.00',
            lineTotal: '-10.00',
          }),
        '23514',
      );
    });

    it('21. sale_items_line_total_non_negative', async () => {
      await expectPgRejection(
        () =>
          rawInsertSaleItem({
            saleId: checkSaleId,
            productId: productA.id,
            quantity: '1',
            unitPrice: '10.00',
            lineTotal: '-10.00',
          }),
        '23514',
      );
    });

    it('22. sale_items_line_arithmetic', async () => {
      await expectPgRejection(
        () =>
          rawInsertSaleItem({
            saleId: checkSaleId,
            productId: productA.id,
            quantity: '2',
            unitPrice: '10.00',
            lineTotal: '15.00',
          }),
        '23514',
      );
    });
  });

  // ==================================================================
  // Unicidad directa
  // ==================================================================
  describe('unicidad directa: número de venta, quoteId, producto por venta', () => {
    it('número de venta único: segundo INSERT con el mismo number → 23505, limpiado de inmediato', async () => {
      const number = `CHK-NUM-${nextSuffix()}`;
      const firstId = await directValidSale(number);

      await expectPgRejection(() => rawInsertSale({ number }), '23505');

      await prisma.sale.delete({ where: { id: firstId } });
      directSaleIds.splice(directSaleIds.indexOf(firstId), 1);
      expect(await prisma.sale.count({ where: { number } })).toBe(0);
    });

    it('sales_quote_id_key: una segunda Sale con el mismo quoteId → 23505', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      await convertQuoteOrThrow(adminCookie, quote.id);

      await expectPgRejection(
        () =>
          rawInsertSale({
            number: `CHK-QID-${nextSuffix()}`,
            quoteId: quote.id,
          }),
        '23505',
      );
    });

    it('UNIQUE(sale_id, product_id): segundo ítem del mismo producto en la misma venta → 23505; el mismo producto SÍ puede estar en otra venta', async () => {
      const saleOneId = await directValidSale(`CHK-DUP-A-${nextSuffix()}`);
      await rawInsertSaleItem({
        saleId: saleOneId,
        productId: productA.id,
        quantity: '1',
        unitPrice: '10.00',
        lineTotal: '10.00',
      });

      await expectPgRejection(
        () =>
          rawInsertSaleItem({
            saleId: saleOneId,
            productId: productA.id,
            quantity: '2',
            unitPrice: '10.00',
            lineTotal: '20.00',
          }),
        '23505',
      );

      const saleTwoId = await directValidSale(`CHK-DUP-B-${nextSuffix()}`);
      await rawInsertSaleItem({
        saleId: saleTwoId,
        productId: productA.id,
        quantity: '1',
        unitPrice: '10.00',
        lineTotal: '10.00',
      });
      expect(
        await prisma.saleItem.count({
          where: { saleId: saleTwoId, productId: productA.id },
        }),
      ).toBe(1);
    });

    it('DocumentSequence.documentType único: un segundo SALE → 23505; sin fila QUOTE remanente', async () => {
      await expectPgRejection(
        () =>
          prisma.$executeRaw`
            INSERT INTO document_sequences (id, document_type, prefix, current_number, padding, updated_at)
            VALUES (gen_random_uuid(), 'SALE', 'NV-', 0, 6, now())
          `,
        '23505',
      );
      expect(
        await prisma.documentSequence.count({
          where: { documentType: DocumentType.SALE },
        }),
      ).toBe(1);
    });
  });

  // ==================================================================
  // Comportamiento de claves foráneas
  // ==================================================================
  describe('comportamiento de claves foráneas', () => {
    it('eliminar una Sale propia elimina en cascada sus SaleItems', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const itemsBefore = await prisma.saleItem.count({
        where: { saleId: sale.id },
      });
      expect(itemsBefore).toBeGreaterThan(0);

      // Fase 8, Bloque B: esta Sale (creada vía el endpoint real) tiene un
      // AccountingEntry ORIGINAL propio, sin FK hacia sales (source
      // polimórfico): borrar la Sale aquí NUNCA fallaría por eso, pero sí
      // dejaría el asiento huérfano al retirar el id de createdSaleIds antes
      // de afterAll. Se limpia a mano, mismo criterio que el resto de las
      // eliminaciones directas de este describe.
      await prisma.accountingEntry.deleteMany({
        where: { sourceType: 'SALE', sourceId: sale.id },
      });
      await prisma.sale.delete({ where: { id: sale.id } });
      createdSaleIds.splice(createdSaleIds.indexOf(sale.id), 1);

      const itemsAfter = await prisma.saleItem.count({
        where: { saleId: sale.id },
      });
      expect(itemsAfter).toBe(0);
    });

    it('no se puede eliminar un Customer referenciado por una Sale existente', async () => {
      const sale = await createDirectSale(adminCookie, {
        customerId: companyActive.id,
      });
      await expectClientFkRejection(() =>
        prisma.customer.delete({ where: { id: companyActive.id } }),
      );
      expect(
        (await prisma.sale.findUnique({ where: { id: sale.id } }))?.id,
      ).toBe(sale.id);
    });

    it('no se puede eliminar un Product referenciado por un SaleItem existente', async () => {
      const dedicatedProduct = await prisma.product.create({
        data: {
          sku: `E2ES-FK-${nextSuffix()}`,
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

      await createDirectSale(adminCookie, {
        items: [{ productId: dedicatedProduct.id, quantity: '1.000' }],
      });

      await expectClientFkRejection(() =>
        prisma.product.delete({ where: { id: dedicatedProduct.id } }),
      );
    });

    it('no se puede eliminar un User referenciado como seller de una Sale existente (RESTRICT), sin tocar los usuarios compartidos de login', async () => {
      const dedicatedSaleId = await directValidSale(
        `CHK-FKUSER-${nextSuffix()}`,
      );
      await prisma.sale.update({
        where: { id: dedicatedSaleId },
        data: { sellerId: fkUserId },
      });

      await expectClientFkRejection(() =>
        prisma.user.delete({ where: { id: fkUserId } }),
      );

      // Limpieza inmediata para no dejar la venta apuntando a fkUserId al cierre.
      await prisma.sale.delete({ where: { id: dedicatedSaleId } });
      directSaleIds.splice(directSaleIds.indexOf(dedicatedSaleId), 1);
    });

    it('no se puede eliminar una Quote referenciada por una Sale existente (sales_quote_id_fkey RESTRICT)', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      await convertQuoteOrThrow(adminCookie, quote.id);

      await expectClientFkRejection(() =>
        prisma.quote.delete({ where: { id: quote.id } }),
      );
    });
  });

  // ==================================================================
  // Seguridad de errores HTTP
  // ==================================================================
  describe('seguridad de errores HTTP', () => {
    it('400/403/404/409 no filtran códigos Prisma, SQLSTATE, nombres de constraint ni SQL crudo', async () => {
      const badPayload = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send({});
      expect(badPayload.status).toBe(400);
      assertNoLeakage(badPayload);

      const forbidden = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', warehouseCookie)
        .send(validCreateSaleBody());
      expect(forbidden.status).toBe(403);
      assertNoLeakage(forbidden);

      const notFound = await request(app.getHttpServer())
        .get(`/api/v1/sales/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie);
      expect(notFound.status).toBe(404);
      assertNoLeakage(notFound);

      const conflict = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(validCreateSaleBody({ customerId: genericCustomerId }));
      expect(conflict.status).toBe(409);
      assertNoLeakage(conflict);
    });
  });

  // ==================================================================
  // Regresión de Swagger
  // ==================================================================
  describe('regresión de Swagger', () => {
    it('8 operaciones Sales en 7 paths únicos; sin DELETE/PUT; print documenta text/html', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');
      expect(response.status).toBe(200);
      const doc = response.body as {
        tags: { name: string }[];
        paths: Record<string, Record<string, unknown>>;
      };
      expect(doc.tags.some((tag) => tag.name === 'Sales')).toBe(true);

      // Fase 7, Bloque C: excluye explícitamente las rutas de Pagos
      // anidadas bajo /sales/{saleId}/payments... (registradas por
      // PaymentsController, un controller distinto) — de lo contrario el
      // simple filtro por substring "sales" las contaría también, aunque
      // SalesController en sí sigue exponiendo exactamente 7 paths/8
      // operaciones, sin cambios. Fase 9, Bloque B: filtra por prefijo real
      // del recurso (no por substring "sales") porque los nuevos reportes
      // GET /reports/sales-by-product|customer|seller también contienen
      // "sales" en el path y no deben contarse aquí. Fase 11, Bloque D:
      // excluye igual criterio la ruta anidada
      // /sales/{saleId}/electronic-documents (registrada por
      // SaleElectronicDocumentsController, un controller distinto de
      // SalesController) — mismo motivo exacto que "payments".
      const salePaths = Object.keys(doc.paths).filter(
        (path) =>
          path.startsWith('/api/v1/sales') &&
          !path.includes('payments') &&
          !path.includes('electronic-documents'),
      );
      expect(new Set(salePaths).size).toBe(7);
      let totalOps = 0;
      for (const path of salePaths) {
        totalOps += Object.keys(doc.paths[path]).length;
        expect(Object.keys(doc.paths[path])).not.toContain('delete');
        expect(Object.keys(doc.paths[path])).not.toContain('put');
      }
      expect(totalOps).toBe(8);

      const printOp = doc.paths['/api/v1/sales/{id}/print']?.get as
        | { responses?: Record<string, { content?: Record<string, unknown> }> }
        | undefined;
      const printContentTypes = Object.keys(
        printOp?.responses?.['200']?.content ?? {},
      );
      expect(printContentTypes).toContain('text/html');
    });

    it('documentación de frontera de pago (Fase 7, Bloque C): paidAmount/balanceDue ya NO se documentan como "siempre 0.00" — reflejan la reconciliación dinámica contra Payment', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');
      const doc = response.body as {
        components: {
          schemas: Record<
            string,
            { properties?: Record<string, { description?: string }> }
          >;
        };
      };
      const saleSchema = doc.components.schemas.SaleResponseDto;
      expect(saleSchema).toBeDefined();
      const paidAmountDescription =
        saleSchema.properties?.paidAmount?.description ?? '';
      // La afirmación obsoleta de la Fase 6 ("Siempre 0.00 en la Fase 6:
      // sin registros de Payment todavía") debe haber desaparecido; la
      // documentación ahora explica la reconciliación contra los pagos
      // ACTIVE de la venta.
      expect(paidAmountDescription).not.toMatch(/siempre.*0\.00.*fase 6/i);
      expect(paidAmountDescription.toLowerCase()).toMatch(/active/);
      const balanceDueDescription =
        saleSchema.properties?.balanceDue?.description ?? '';
      expect(balanceDueDescription).not.toMatch(/siempre.*0\.00/i);
    });
  });

  // ==================================================================
  // Sin artefactos de Payment / sin efecto lateral de inventario en lectura
  // ==================================================================
  describe('sin artefactos de Payment; sin efecto lateral de inventario en lectura o entrega', () => {
    it('sin pago inicial en el body: payments=[] (el comportamiento CON pago inicial se cubre en Fase 7, Bloque D, más abajo)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Cookie', adminCookie);
      expect((response.body as SafeSaleBody).payments).toEqual([]);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(/"paymentId"/);
    });

    it('listar/leer/imprimir/marcar-entrega nunca crea InventoryMovement fuera de la creación/anulación de la venta', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const before = await prisma.inventoryMovement.count();

      await request(app.getHttpServer())
        .get('/api/v1/sales')
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/mark-delivered`)
        .set('Cookie', adminCookie);

      const after = await prisma.inventoryMovement.count();
      expect(after).toBe(before);
    });
  });

  // ==================================================================
  // Fase 7, Bloque D — pago inicial en venta directa
  // ==================================================================
  describe('Fase 7, Bloque D — pago inicial en venta directa', () => {
    let productD100: FixtureProduct;
    let productDInsufficient: FixtureProduct;
    let productDMultiA: FixtureProduct;
    let productDMultiB: FixtureProduct;
    let prospectInitialPayment: FixtureCustomer;
    let prospectOverpayRollback: FixtureCustomer;
    let cardMethodId: string;
    let cardRequiresReferenceOriginal: boolean;
    const ownedCardReferenceAuditLogIds: string[] = [];

    async function setCardRequiresReference(value: boolean): Promise<void> {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${cardMethodId}`)
        .set('Cookie', adminCookie)
        .send({ requiresReference: value });
      if (response.status !== 200) {
        throw new Error(
          `No se pudo fijar CARD.requiresReference=${value}: ${JSON.stringify(response.body)}`,
        );
      }
      const latest = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.PAYMENT_METHOD_UPDATED,
          entityType: 'PaymentMethod',
          entityId: cardMethodId,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (
        latest !== null &&
        !ownedCardReferenceAuditLogIds.includes(latest.id)
      ) {
        ownedCardReferenceAuditLogIds.push(latest.id);
      }
    }

    async function createDedicatedProduct(
      data: Partial<Prisma.ProductUncheckedCreateInput>,
    ): Promise<FixtureProduct> {
      const suffix = nextSuffix();
      const row = await prisma.product.create({
        data: {
          sku: `E2ES-PAYD-${suffix}`,
          name: `Producto Pago Inicial E2E ${suffix}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          isInventoryTracked: true,
          status: ProductStatus.ACTIVE,
          ...data,
        },
      });
      createdProductIds.push(row.id);
      return {
        id: row.id,
        sku: row.sku,
        name: row.name,
        salePrice: row.salePrice.toFixed(2),
      };
    }

    beforeAll(async () => {
      productD100 = await createDedicatedProduct({
        salePrice: new Prisma.Decimal('100.00'),
        stockCurrent: new Prisma.Decimal('500.000'),
      });
      productDInsufficient = await createDedicatedProduct({
        salePrice: new Prisma.Decimal('100.00'),
        stockCurrent: new Prisma.Decimal('1.000'),
      });
      productDMultiA = await createDedicatedProduct({
        salePrice: new Prisma.Decimal('50.00'),
        stockCurrent: new Prisma.Decimal('500.000'),
      });
      productDMultiB = await createDedicatedProduct({
        salePrice: new Prisma.Decimal('50.00'),
        stockCurrent: new Prisma.Decimal('1.000'),
      });

      const prospectASuffix = nextSuffix();
      const prospectA = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          status: CustomerStatus.ACTIVE,
          name: `Prospecto Pago Inicial E2E ${prospectASuffix}`,
        },
      });
      createdCustomerIds.push(prospectA.id);
      prospectInitialPayment = { id: prospectA.id, name: prospectA.name };

      const prospectBSuffix = nextSuffix();
      const prospectB = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.PROSPECT,
          status: CustomerStatus.ACTIVE,
          name: `Prospecto Sobrepago Rollback E2E ${prospectBSuffix}`,
        },
      });
      createdCustomerIds.push(prospectB.id);
      prospectOverpayRollback = { id: prospectB.id, name: prospectB.name };

      // NR-01B1: igual criterio de snapshot-y-restauración que
      // payments.e2e-spec.ts -- esta suite no asume el valor real de
      // CARD.requiresReference en pos_db_test (seedPaymentMethods() usa
      // update: {}; una base inicializada ANTES de NR-01 podría
      // conservarlo en true). Acotado a CARD (representativo de los 4
      // métodos baseline no-efectivo: la ruta de validación del pago
      // inicial es la misma parseInitialPayments() ->
      // PaymentEngine.register() para los 4, ya probada exhaustivamente
      // por método en payments.e2e-spec.ts).
      const methodsResponse = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', adminCookie);
      if (methodsResponse.status !== 200) {
        throw new Error(
          `No se pudo leer GET /payment-methods: ${JSON.stringify(methodsResponse.body)}`,
        );
      }
      const cardMethod = (
        methodsResponse.body as Array<{
          id: string;
          code: string;
          requiresReference: boolean;
        }>
      ).find((m) => m.code === 'CARD');
      if (cardMethod === undefined) {
        throw new Error('No se encontró el método de pago baseline "CARD"');
      }
      cardMethodId = cardMethod.id;
      cardRequiresReferenceOriginal = cardMethod.requiresReference;
      if (cardMethod.requiresReference !== false) {
        await setCardRequiresReference(false);
      }
    });

    afterAll(async () => {
      if (cardRequiresReferenceOriginal !== false) {
        await setCardRequiresReference(cardRequiresReferenceOriginal);
      }
      if (ownedCardReferenceAuditLogIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedCardReferenceAuditLogIds } },
        });
      }
    });

    it('sin pago inicial: UNPAID, paidAmount 0.00, balanceDue = total, payments=[]', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productD100.id, quantity: '1.000' }],
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.UNPAID);
      expect(sale.paidAmount).toBe('0.00');
      expect(sale.balanceDue).toBe('100.00');
      expect(sale.payments).toEqual([]);
    });

    it('pago inicial parcial (40 de 100): PARTIALLY_PAID, paidAmount 40.00, balanceDue 60.00, payments=[1 ACTIVE 40.00]; el Payment ya existe dentro de la misma respuesta (misma transacción)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productD100.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '40.00' },
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(sale.paidAmount).toBe('40.00');
      expect(sale.balanceDue).toBe('60.00');
      expect(sale.payments).toHaveLength(1);
      const payment = sale.payments[0] as SafeSalePaymentItem;
      expect(payment.status).toBe(PaymentStatus.ACTIVE);
      expect(payment.amount).toBe('40.00');
      const row = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.id },
      });
      expect(row.saleId).toBe(sale.id);
    });

    it('pago inicial completo (100 de 100): PAID, paidAmount 100.00, balanceDue 0.00, payments=[1 ACTIVE 100.00]', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productD100.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '100.00' },
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.paidAmount).toBe('100.00');
      expect(sale.balanceDue).toBe('0.00');
      expect(sale.payments).toHaveLength(1);
    });

    it('Público general: sin pago → 409; pago parcial (40) → 409; pago total (100) → éxito PAID/balance 0/1 pago ACTIVE', async () => {
      const noPayment = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            customerId: genericCustomerId,
            items: [{ productId: productD100.id, quantity: '1.000' }],
          }),
        );
      expect(noPayment.status).toBe(409);

      const partial = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            customerId: genericCustomerId,
            items: [{ productId: productD100.id, quantity: '1.000' }],
            payment: { method: 'CASH', amount: '40.00' },
          }),
        );
      expect(partial.status).toBe(409);

      const full = await createDirectSale(adminCookie, {
        customerId: genericCustomerId,
        items: [{ productId: productD100.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '100.00' },
      });
      expect(full.customerIsGeneric).toBe(true);
      expect(full.balanceDue).toBe('0.00');
      expect(full.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(full.payments).toHaveLength(1);
    });

    it('Público general con total 0 (descuento total): éxito sin ningún Payment', async () => {
      const sale = await createDirectSale(adminCookie, {
        customerId: genericCustomerId,
        items: [{ productId: productD100.id, quantity: '1.000' }],
        discountAmount: '100.00',
      });
      expect(sale.total).toBe('0.00');
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.payments).toEqual([]);
    });

    it('cliente BLOCKED: sin pago → 409; pago parcial → 409; pago total → éxito; el cliente permanece BLOCKED (sin mutación de estado)', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: blockedCustomer.id },
      });
      expect(before.status).toBe(CustomerStatus.BLOCKED);

      const noPayment = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            customerId: blockedCustomer.id,
            items: [{ productId: productD100.id, quantity: '1.000' }],
          }),
        );
      expect(noPayment.status).toBe(409);

      const partial = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            customerId: blockedCustomer.id,
            items: [{ productId: productD100.id, quantity: '1.000' }],
            payment: { method: 'CASH', amount: '40.00' },
          }),
        );
      expect(partial.status).toBe(409);

      const full = await createDirectSale(adminCookie, {
        customerId: blockedCustomer.id,
        items: [{ productId: productD100.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '100.00' },
      });
      expect(full.paymentStatus).toBe(SalePaymentStatus.PAID);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: blockedCustomer.id },
      });
      expect(after.status).toBe(CustomerStatus.BLOCKED);
    });

    it('pago inicial > total (100.01 de 100): 409, rollback atómico total — sin Sale/SaleItem/Payment, NV sin consumir, PROSPECT sin promover', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectOverpayRollback.id },
      });
      expect(before.customerStage).toBe(CustomerStage.PROSPECT);
      const nvBefore = await currentSaleSequenceNumber();
      const salesBefore = await prisma.sale.count();
      const paymentsBefore = await prisma.payment.count();

      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            customerId: prospectOverpayRollback.id,
            items: [{ productId: productD100.id, quantity: '1.000' }],
            payment: { method: 'CASH', amount: '100.01' },
          }),
        );
      expect(response.status).toBe(409);

      expect(await prisma.sale.count()).toBe(salesBefore);
      expect(await prisma.payment.count()).toBe(paymentsBefore);
      expect(await currentSaleSequenceNumber()).toBe(nvBefore);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectOverpayRollback.id },
      });
      expect(after.customerStage).toBe(CustomerStage.PROSPECT);
      const stageAudits = await fetchAuditRows(
        AuditAction.CUSTOMER_STAGE_CHANGED,
        'Customer',
        prospectOverpayRollback.id,
      );
      expect(stageAudits).toHaveLength(0);
    });

    it('prospecto + pago inicial exitoso: promovido a CUSTOMER; exactamente 1 CUSTOMER_STAGE_CHANGED, 1 PAYMENT_REGISTERED y 1 SALE_CONFIRMED', async () => {
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectInitialPayment.id },
      });
      expect(before.customerStage).toBe(CustomerStage.PROSPECT);

      const sale = await createDirectSale(adminCookie, {
        customerId: prospectInitialPayment.id,
        items: [{ productId: productD100.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '100.00' },
      });

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: prospectInitialPayment.id },
      });
      expect(after.customerStage).toBe(CustomerStage.CUSTOMER);

      const stageAudits = await fetchAuditRows(
        AuditAction.CUSTOMER_STAGE_CHANGED,
        'Customer',
        prospectInitialPayment.id,
      );
      expect(stageAudits).toHaveLength(1);

      const payment = sale.payments[0] as SafeSalePaymentItem;
      const paymentAudits = await fetchAuditRows(
        AuditAction.PAYMENT_REGISTERED,
        'Payment',
        payment.id,
      );
      expect(paymentAudits).toHaveLength(1);

      const confirmAudits = await fetchAuditRows(
        AuditAction.SALE_CONFIRMED,
        'Sale',
        sale.id,
      );
      expect(confirmAudits).toHaveLength(1);
    });

    it('stock insuficiente con pago inicial válido: 409, rollback total — sin Sale/SaleItem/Payment/movimiento, stock sin cambios', async () => {
      const stockBefore = await prisma.product.findUniqueOrThrow({
        where: { id: productDInsufficient.id },
      });
      const paymentsBefore = await prisma.payment.count();
      const movementsBefore = await prisma.inventoryMovement.count();

      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [{ productId: productDInsufficient.id, quantity: '2.000' }],
            payment: { method: 'CASH', amount: '50.00' },
          }),
        );
      expect(response.status).toBe(409);

      expect(await prisma.payment.count()).toBe(paymentsBefore);
      expect(await prisma.inventoryMovement.count()).toBe(movementsBefore);
      const stockAfter = await prisma.product.findUniqueOrThrow({
        where: { id: productDInsufficient.id },
      });
      expect(stockAfter.stockCurrent.toFixed(3)).toBe(
        stockBefore.stockCurrent.toFixed(3),
      );
    });

    it('dos ítems (A suficiente, B insuficiente) con pago inicial válido: 409, ningún stock cambia (ni el de A), sin Payment', async () => {
      const stockABefore = await prisma.product.findUniqueOrThrow({
        where: { id: productDMultiA.id },
      });
      const stockBBefore = await prisma.product.findUniqueOrThrow({
        where: { id: productDMultiB.id },
      });
      const paymentsBefore = await prisma.payment.count();

      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', adminCookie)
        .send(
          validCreateSaleBody({
            items: [
              { productId: productDMultiA.id, quantity: '2.000' },
              { productId: productDMultiB.id, quantity: '2.000' },
            ],
            payment: { method: 'CASH', amount: '50.00' },
          }),
        );
      expect(response.status).toBe(409);

      expect(await prisma.payment.count()).toBe(paymentsBefore);
      const stockAAfter = await prisma.product.findUniqueOrThrow({
        where: { id: productDMultiA.id },
      });
      const stockBAfter = await prisma.product.findUniqueOrThrow({
        where: { id: productDMultiB.id },
      });
      expect(stockAAfter.stockCurrent.toFixed(3)).toBe(
        stockABefore.stockCurrent.toFixed(3),
      );
      expect(stockBAfter.stockCurrent.toFixed(3)).toBe(
        stockBBefore.stockCurrent.toFixed(3),
      );
    });

    it('NR-01B1: pago inicial único con CARD sin referencia (requiresReference=false): 201, PAID, reference null', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productD100.id, quantity: '1.000' }],
        payment: { method: 'CARD', amount: '100.00' },
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.paidAmount).toBe('100.00');
      expect(sale.balanceDue).toBe('0.00');
      expect(sale.payments).toHaveLength(1);
      const payment = sale.payments[0] as SafeSalePaymentItem;
      expect(payment.reference).toBeNull();
    });

    it('NR-01B1: lote payments[] con dos pagos CARD, ambos sin referencia: 201, PAID, los dos Payment con reference null, ningún inconsistencia de saldo', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productD100.id, quantity: '1.000' }],
        payments: [
          { method: 'CARD', amount: '40.00' },
          { method: 'CARD', amount: '60.00' },
        ],
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.paidAmount).toBe('100.00');
      expect(sale.balanceDue).toBe('0.00');
      expect(sale.payments).toHaveLength(2);
      for (const payment of sale.payments as SafeSalePaymentItem[]) {
        expect(payment.status).toBe(PaymentStatus.ACTIVE);
        expect(payment.reference).toBeNull();
      }
      const sumActive = (sale.payments as SafeSalePaymentItem[]).reduce(
        (total, payment) => total + Number(payment.amount),
        0,
      );
      expect(sumActive.toFixed(2)).toBe(sale.paidAmount);
    });

    describe('NR-02A: crédito configurable por cliente, end-to-end', () => {
      async function createCustomerWithCredit(
        creditEnabled: boolean,
      ): Promise<string> {
        const suffix = nextSuffix();
        const row = await prisma.customer.create({
          data: {
            customerType: CustomerType.PERSON,
            customerStage: CustomerStage.CUSTOMER,
            status: CustomerStatus.ACTIVE,
            name: `Cliente Credito E2E ${suffix}`,
            creditEnabled,
          },
        });
        createdCustomerIds.push(row.id);
        return row.id;
      }

      it('crédito deshabilitado: sin pago -> 409, sin crear Sale', async () => {
        const customerId = await createCustomerWithCredit(false);
        const paymentsBefore = await prisma.payment.count();
        const response = await request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              customerId,
              items: [{ productId: productD100.id, quantity: '1.000' }],
            }),
          );
        expect(response.status).toBe(409);
        expect((response.body as { message?: string }).message).toContain(
          'crédito habilitado',
        );
        expect(await prisma.payment.count()).toBe(paymentsBefore);
        expect(await prisma.sale.count({ where: { customerId } })).toBe(0);
      });

      it('crédito deshabilitado: pago parcial -> 409', async () => {
        const customerId = await createCustomerWithCredit(false);
        const response = await request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              customerId,
              items: [{ productId: productD100.id, quantity: '1.000' }],
              payment: { method: 'CASH', amount: '40.00' },
            }),
          );
        expect(response.status).toBe(409);
      });

      it('crédito deshabilitado: pago total -> 201 (0 de saldo nunca depende de creditEnabled)', async () => {
        const customerId = await createCustomerWithCredit(false);
        const response = await request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              customerId,
              items: [{ productId: productD100.id, quantity: '1.000' }],
              payment: { method: 'CASH', amount: '100.00' },
            }),
          );
        expect(response.status).toBe(201);
        createdSaleIds.push((response.body as SafeSaleBody).id);
      });

      it('crédito habilitado: sin pago -> 201, UNPAID, balanceDue = total', async () => {
        const customerId = await createCustomerWithCredit(true);
        const response = await request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              customerId,
              items: [{ productId: productD100.id, quantity: '1.000' }],
            }),
          );
        expect(response.status).toBe(201);
        const sale = response.body as SafeSaleBody;
        createdSaleIds.push(sale.id);
        expect(sale.paymentStatus).toBe(SalePaymentStatus.UNPAID);
        expect(sale.balanceDue).toBe(sale.total);
      });

      it('ADMIN deshabilita el crédito con deuda histórica ya existente: el cobro posterior sigue funcionando (NR-02A §7)', async () => {
        const customerId = await createCustomerWithCredit(true);
        const sale = await createDirectSale(adminCookie, {
          customerId,
          items: [{ productId: productD100.id, quantity: '1.000' }],
        });
        expect(sale.balanceDue).toBe('100.00');

        const disable = await request(app.getHttpServer())
          .patch(`/api/v1/customers/${customerId}/credit`)
          .set('Cookie', adminCookie)
          .send({ creditEnabled: false });
        expect(disable.status).toBe(200);

        const payment = await request(app.getHttpServer())
          .post(`/api/v1/sales/${sale.id}/payments`)
          .set('Cookie', adminCookie)
          .send({ method: 'CASH', amount: '100.00' });
        expect(payment.status).toBe(201);
        const saleRow = await prisma.sale.findUniqueOrThrow({
          where: { id: sale.id },
        });
        expect(saleRow.balanceDue.toFixed(2)).toBe('0.00');
      });
    });
  });

  // ==================================================================
  // Fase 7, Bloque D — pago inicial en conversión de cotización
  // ==================================================================
  describe('Fase 7, Bloque D — pago inicial en conversión de cotización', () => {
    let productQD: FixtureProduct;
    let productQDInsufficient: FixtureProduct;
    let cardMethodIdQ: string;
    let cardRequiresReferenceOriginalQ: boolean;
    const ownedCardReferenceAuditLogIdsQ: string[] = [];

    // NR-01B1: mismo criterio de snapshot-y-restauración acotado a CARD que
    // el describe "pago inicial en venta directa" (no se comparte estado
    // entre describes: cada uno restaura en su propio afterAll antes de que
    // el siguiente empiece).
    async function setCardRequiresReferenceQ(value: boolean): Promise<void> {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/payment-methods/${cardMethodIdQ}`)
        .set('Cookie', adminCookie)
        .send({ requiresReference: value });
      if (response.status !== 200) {
        throw new Error(
          `No se pudo fijar CARD.requiresReference=${value}: ${JSON.stringify(response.body)}`,
        );
      }
      const latest = await prisma.auditLog.findFirst({
        where: {
          action: AuditAction.PAYMENT_METHOD_UPDATED,
          entityType: 'PaymentMethod',
          entityId: cardMethodIdQ,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (
        latest !== null &&
        !ownedCardReferenceAuditLogIdsQ.includes(latest.id)
      ) {
        ownedCardReferenceAuditLogIdsQ.push(latest.id);
      }
    }

    beforeAll(async () => {
      const methodsResponse = await request(app.getHttpServer())
        .get('/api/v1/payment-methods')
        .set('Cookie', adminCookie);
      if (methodsResponse.status !== 200) {
        throw new Error(
          `No se pudo leer GET /payment-methods: ${JSON.stringify(methodsResponse.body)}`,
        );
      }
      const cardMethod = (
        methodsResponse.body as Array<{
          id: string;
          code: string;
          requiresReference: boolean;
        }>
      ).find((m) => m.code === 'CARD');
      if (cardMethod === undefined) {
        throw new Error('No se encontró el método de pago baseline "CARD"');
      }
      cardMethodIdQ = cardMethod.id;
      cardRequiresReferenceOriginalQ = cardMethod.requiresReference;
      if (cardMethod.requiresReference !== false) {
        await setCardRequiresReferenceQ(false);
      }

      const suffixA = nextSuffix();
      const rowA = await prisma.product.create({
        data: {
          sku: `E2ES-PAYQ-${suffixA}`,
          name: `Producto Pago Cotizacion E2E ${suffixA}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('100.00'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('500.000'),
        },
      });
      createdProductIds.push(rowA.id);
      productQD = {
        id: rowA.id,
        sku: rowA.sku,
        name: rowA.name,
        salePrice: rowA.salePrice.toFixed(2),
      };

      const suffixB = nextSuffix();
      const rowB = await prisma.product.create({
        data: {
          sku: `E2ES-PAYQ-${suffixB}`,
          name: `Producto Pago Cotizacion Insuficiente E2E ${suffixB}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('100.00'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('1.000'),
        },
      });
      createdProductIds.push(rowB.id);
      productQDInsufficient = {
        id: rowB.id,
        sku: rowB.sku,
        name: rowB.name,
        salePrice: rowB.salePrice.toFixed(2),
      };
    });

    afterAll(async () => {
      if (cardRequiresReferenceOriginalQ !== false) {
        await setCardRequiresReferenceQ(cardRequiresReferenceOriginalQ);
      }
      if (ownedCardReferenceAuditLogIdsQ.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { id: { in: ownedCardReferenceAuditLogIdsQ } },
        });
      }
    });

    it('sin pago (preserva el comportamiento de la Fase 6): UNPAID, paidAmount 0, balanceDue = total, payments=[]; Quote CONVERTED', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productQD, '1.000')],
      });
      const sale = await convertQuoteOrThrow(adminCookie, quote.id);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.UNPAID);
      expect(sale.paidAmount).toBe('0.00');
      expect(sale.balanceDue).toBe(sale.total);
      expect(sale.payments).toEqual([]);
      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);
    });

    it('pago parcial (40 de 100): PARTIALLY_PAID 40/60, 1 pago ACTIVE, stock descontado una vez, Quote CONVERTED, todo en una transacción', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productQD, '1.000')],
      });
      const stockBefore = await prisma.product.findUniqueOrThrow({
        where: { id: productQD.id },
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CASH', amount: '40.00' } });
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      createdSaleIds.push(sale.id);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(sale.paidAmount).toBe('40.00');
      expect(sale.balanceDue).toBe('60.00');
      expect(sale.payments).toHaveLength(1);

      const stockAfter = await prisma.product.findUniqueOrThrow({
        where: { id: productQD.id },
      });
      expect(
        stockBefore.stockCurrent.minus(stockAfter.stockCurrent).toFixed(3),
      ).toBe('1.000');
      const exits = await prisma.inventoryMovement.count({
        where: {
          referenceType: 'Sale',
          referenceId: sale.id,
          origin: InventoryMovementOrigin.SALE,
        },
      });
      expect(exits).toBe(1);
    });

    it('pago total (100 de 100): PAID, 1 pago ACTIVE, Quote CONVERTED', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productQD, '1.000')],
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CASH', amount: '100.00' } });
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      createdSaleIds.push(sale.id);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.payments).toHaveLength(1);
    });

    it('pago inicial válido pero conversión falla por stock insuficiente vigente: 409, rollback total — sin Sale/Payment/mutación de stock; Quote sin cambios; NV sin consumir', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productQDInsufficient, '5.000')],
      });
      const stockBefore = await prisma.product.findUniqueOrThrow({
        where: { id: productQDInsufficient.id },
      });
      const nvBefore = await currentSaleSequenceNumber();
      const paymentsBefore = await prisma.payment.count();

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CASH', amount: '50.00' } });
      expect(response.status).toBe(409);

      expect(await prisma.payment.count()).toBe(paymentsBefore);
      expect(await currentSaleSequenceNumber()).toBe(nvBefore);
      const stockAfter = await prisma.product.findUniqueOrThrow({
        where: { id: productQDInsufficient.id },
      });
      expect(stockAfter.stockCurrent.toFixed(3)).toBe(
        stockBefore.stockCurrent.toFixed(3),
      );
      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.PENDING);
      const convertedAudits = await fetchAuditRows(
        AuditAction.QUOTE_CONVERTED,
        'Quote',
        quote.id,
      );
      expect(convertedAudits).toHaveLength(0);
    });

    it('el pago inicial nunca reprecia ni reescribe el historial comercial de la cotización: solo afecta paymentStatus/paidAmount/balanceDue/payments[]', async () => {
      const snapshotSuffix = nextSuffix();
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente Snapshot Pago E2E ${snapshotSuffix}`,
          documentType: CustomerDocumentType.DNI,
          documentNumber: `SNPP${snapshotSuffix}`,
          // NR-02A: este test convierte con pago PARCIAL (10 de 30) — sin
          // crédito habilitado, assertCustomerDebtRules respondería 409
          // antes de llegar a lo que el test realmente quiere probar
          // (snapshot comercial inmutable).
          creditEnabled: true,
        },
      });
      createdCustomerIds.push(customer.id);
      const originalCustomerName = customer.name;

      const dedicatedSuffix = nextSuffix();
      const dedicatedProduct = await prisma.product.create({
        data: {
          sku: `E2ES-SNPP-${dedicatedSuffix}`,
          name: `Producto Snapshot Pago E2E ${dedicatedSuffix}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('30.00'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('50.000'),
        },
      });
      createdProductIds.push(dedicatedProduct.id);
      const productSnapshot: FixtureProduct = {
        id: dedicatedProduct.id,
        sku: dedicatedProduct.sku,
        name: dedicatedProduct.name,
        salePrice: dedicatedProduct.salePrice.toFixed(2),
      };

      const quote = await createDirectQuote({
        customerId: customer.id,
        customerType: CustomerType.PERSON,
        customerDocumentType: CustomerDocumentType.DNI,
        customerDocumentNumber: `SNPP${snapshotSuffix}`,
        customerName: originalCustomerName,
        items: [quoteItemFor(productSnapshot, '1.000')],
      });

      // Mutaciones vivas DESPUÉS de emitir la cotización, ANTES de convertir.
      await prisma.customer.update({
        where: { id: customer.id },
        data: { name: 'Nombre Cambiado Después De La Cotizacion' },
      });
      await prisma.product.update({
        where: { id: dedicatedProduct.id },
        data: {
          salePrice: new Prisma.Decimal('999.00'),
          sku: `E2ES-SNPP-CAMBIADO-${nextSuffix()}`,
        },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CASH', amount: '10.00' } });
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      // Snapshot comercial: EXACTAMENTE el de la cotización, nunca el vigente.
      expect(sale.customerName).toBe(originalCustomerName);
      expect(sale.customerName).not.toBe(
        'Nombre Cambiado Después De La Cotizacion',
      );
      expect(sale.items[0].productSku).toBe(productSnapshot.sku);
      expect(sale.items[0].unitPrice).toBe('30.00');
      expect(sale.total).toBe('30.00');

      // Solo el resumen de pago cambia por el pago inicial.
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(sale.paidAmount).toBe('10.00');
      expect(sale.balanceDue).toBe('20.00');
      expect(sale.payments).toHaveLength(1);
    });

    it('NR-01B1: conversión de cotización con pago inicial CARD sin referencia (requiresReference=false): 201, PAID, reference null, Quote CONVERTED', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productQD, '1.000')],
      });
      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CARD', amount: '100.00' } });
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      createdSaleIds.push(sale.id);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.paidAmount).toBe('100.00');
      expect(sale.balanceDue).toBe('0.00');
      expect(sale.payments).toHaveLength(1);
      const payment = sale.payments[0] as SafeSalePaymentItem;
      expect(payment.reference).toBeNull();
      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);
    });

    describe('NR-02A: crédito configurable por cliente, conversión de cotización', () => {
      // E/F (cliente con creditEnabled=true, sin pago / con pago parcial:
      // permitida) ya están demostrados por los tests preexistentes de
      // este mismo describe sobre personActive ("sin pago (preserva el
      // comportamiento de la Fase 6)" y "pago parcial (40 de 100)") --
      // personActive tiene creditEnabled=true explícito desde NR-02B1
      // (ver createCustomer() del beforeAll superior). No se duplican
      // aquí. Solo se agregan B/C/D (el comportamiento genuinamente
      // nuevo: creditEnabled=false bloqueando la conversión).
      async function createNoCreditCustomer(): Promise<string> {
        const suffix = nextSuffix();
        const row = await prisma.customer.create({
          data: {
            customerType: CustomerType.PERSON,
            customerStage: CustomerStage.CUSTOMER,
            status: CustomerStatus.ACTIVE,
            name: `Cliente Conversion Sin Credito E2E ${suffix}`,
            creditEnabled: false,
          },
        });
        createdCustomerIds.push(row.id);
        return row.id;
      }

      it('B: creditEnabled=false, conversión sin pago inicial -> 409; Quote no se convierte, sin Sale/Payment/descuento de stock/auditoría de éxito', async () => {
        const customerId = await createNoCreditCustomer();
        const quote = await createDirectQuote({
          customerId,
          customerType: CustomerType.PERSON,
          customerName: 'Cliente Conversion Sin Credito E2E',
          items: [quoteItemFor(productQD, '1.000')],
        });
        const stockBefore = await prisma.product.findUniqueOrThrow({
          where: { id: productQD.id },
        });
        const salesBefore = await prisma.sale.count();
        const paymentsBefore = await prisma.payment.count();

        const response = await request(app.getHttpServer())
          .post(`/api/v1/sales/from-quote/${quote.id}`)
          .set('Cookie', adminCookie)
          .send();
        expect(response.status).toBe(409);
        expect((response.body as { message?: string }).message).toContain(
          'crédito habilitado',
        );

        expect(await prisma.sale.count()).toBe(salesBefore);
        expect(await prisma.payment.count()).toBe(paymentsBefore);
        const quoteRow = await prisma.quote.findUniqueOrThrow({
          where: { id: quote.id },
        });
        expect(quoteRow.status).not.toBe(QuoteStatus.CONVERTED);
        const stockAfter = await prisma.product.findUniqueOrThrow({
          where: { id: productQD.id },
        });
        expect(stockAfter.stockCurrent.toFixed(3)).toBe(
          stockBefore.stockCurrent.toFixed(3),
        );
        const convertedAudits = await fetchAuditRows(
          AuditAction.QUOTE_CONVERTED,
          'Quote',
          quote.id,
        );
        expect(convertedAudits).toHaveLength(0);
      });

      it('C: creditEnabled=false, conversión con pago parcial -> 409; Quote no se convierte', async () => {
        const customerId = await createNoCreditCustomer();
        const quote = await createDirectQuote({
          customerId,
          customerType: CustomerType.PERSON,
          customerName: 'Cliente Conversion Sin Credito E2E',
          items: [quoteItemFor(productQD, '1.000')],
        });
        const response = await request(app.getHttpServer())
          .post(`/api/v1/sales/from-quote/${quote.id}`)
          .set('Cookie', adminCookie)
          .send({ payment: { method: 'CASH', amount: '40.00' } });
        expect(response.status).toBe(409);
        const quoteRow = await prisma.quote.findUniqueOrThrow({
          where: { id: quote.id },
        });
        expect(quoteRow.status).not.toBe(QuoteStatus.CONVERTED);
      });

      it('D: creditEnabled=false, conversión con pago completo -> 201, Quote CONVERTED (0 de saldo nunca depende de creditEnabled)', async () => {
        const customerId = await createNoCreditCustomer();
        const quote = await createDirectQuote({
          customerId,
          customerType: CustomerType.PERSON,
          customerName: 'Cliente Conversion Sin Credito E2E',
          items: [quoteItemFor(productQD, '1.000')],
        });
        const response = await request(app.getHttpServer())
          .post(`/api/v1/sales/from-quote/${quote.id}`)
          .set('Cookie', adminCookie)
          .send({ payment: { method: 'CASH', amount: '100.00' } });
        expect(response.status).toBe(201);
        const sale = response.body as SafeSaleBody;
        createdSaleIds.push(sale.id);
        expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
        expect(sale.balanceDue).toBe('0.00');
        const quoteRow = await prisma.quote.findUniqueOrThrow({
          where: { id: quote.id },
        });
        expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);
      });
    });
  });

  // ==================================================================
  // Fase 7, Bloque D — anulación de venta en cascada sobre pagos
  // ==================================================================
  describe('Fase 7, Bloque D — anulación de venta en cascada sobre pagos', () => {
    let productCancelD: FixtureProduct;

    beforeAll(async () => {
      const suffix = nextSuffix();
      const row = await prisma.product.create({
        data: {
          sku: `E2ES-CANCD-${suffix}`,
          name: `Producto Anulacion Cascada Pago E2E ${suffix}`,
          productType: ProductType.PRODUCT,
          categoryId,
          unitId: unitDecimalId,
          salePrice: new Prisma.Decimal('100.00'),
          isInventoryTracked: true,
          stockCurrent: new Prisma.Decimal('500.000'),
        },
      });
      createdProductIds.push(row.id);
      productCancelD = {
        id: row.id,
        sku: row.sku,
        name: row.name,
        salePrice: row.salePrice.toFixed(2),
      };
    });

    it('venta con UN pago (parcial) y stock rastreado: anular → Sale CANCELLED; Payment CANCELLED/SALE_CANCELLATION/reason null/cancelledBy=ADMIN; stock restaurado; movimiento SALE original preservado; movimiento SALE_CANCELLATION creado; resumen congelado (no 0/total)', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productCancelD.id, quantity: '2.000' }],
        payment: { method: 'CASH', amount: '40.00' },
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      const paymentBefore = sale.payments[0] as SafeSalePaymentItem;
      const stockAfterSale = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelD.id },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación con pago activo' });
      expect(response.status).toBe(200);
      const body = response.body as SafeSaleBody;
      expect(body.status).toBe(SaleStatus.CANCELLED);

      // Resumen congelado: EXACTAMENTE los valores previos a la anulación.
      expect(body.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(body.paidAmount).toBe('40.00');
      // Total = 100.00 * 2.000 = 200.00; balance congelado = 200.00 - 40.00.
      expect(body.balanceDue).toBe('160.00');

      expect(body.payments).toHaveLength(1);
      const paymentAfter = body.payments[0] as SafeSalePaymentItem;
      expect(paymentAfter.id).toBe(paymentBefore.id);
      expect(paymentAfter.status).toBe(PaymentStatus.CANCELLED);
      expect(paymentAfter.cancellationSource).toBe(
        PaymentCancellationSource.SALE_CANCELLATION,
      );
      expect(paymentAfter.cancellationReason).toBeNull();
      expect(paymentAfter.cancelledBy?.id).toBe(adminId);

      const stockAfterCancel = await prisma.product.findUniqueOrThrow({
        where: { id: productCancelD.id },
      });
      expect(stockAfterCancel.stockCurrent.toFixed(3)).toBe(
        stockAfterSale.stockCurrent
          .plus(new Prisma.Decimal('2.000'))
          .toFixed(3),
      );
      const originalExit = await prisma.inventoryMovement.findFirst({
        where: {
          referenceType: 'Sale',
          referenceId: sale.id,
          origin: InventoryMovementOrigin.SALE,
        },
      });
      expect(originalExit).not.toBeNull();
      const reversal = await prisma.inventoryMovement.findFirst({
        where: {
          referenceType: 'Sale',
          referenceId: sale.id,
          origin: InventoryMovementOrigin.SALE_CANCELLATION,
        },
      });
      expect(reversal).not.toBeNull();

      const cancelAudits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        'Payment',
        paymentBefore.id,
      );
      expect(cancelAudits).toHaveLength(1);
      const metadata = cancelAudits[0].metadata as Record<string, unknown>;
      expect(metadata.cancellationSource).toBe(
        PaymentCancellationSource.SALE_CANCELLATION,
      );
      expect(metadata).not.toHaveProperty('amount');
      expect(metadata).not.toHaveProperty('reference');
      expect(metadata).not.toHaveProperty('reason');
    });

    it('venta con TRES pagos (20 ACTIVE, 30 ACTIVE, 10 ya CANCELLED manualmente): anular → los 2 ACTIVE pasan a CANCELLED/SALE_CANCELLATION; el ya cancelado no se toca; exactamente 2 nuevas auditorías PAYMENT_CANCELLED', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productCancelD.id, quantity: '1.000' }],
      });
      const p20 = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Cookie', adminCookie)
        .send({ method: 'CASH', amount: '20.00' });
      const p30 = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Cookie', adminCookie)
        .send({ method: 'CASH', amount: '30.00' });
      const p10 = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Cookie', adminCookie)
        .send({ method: 'CASH', amount: '10.00' });
      const p10Id = (p10.body as { payment: { id: string } }).payment.id;
      const manualCancel = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments/${p10Id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación manual previa' });
      expect(manualCancel.status).toBe(200);
      const p10RowBefore = await prisma.payment.findUniqueOrThrow({
        where: { id: p10Id },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación con múltiples pagos' });
      expect(response.status).toBe(200);

      const p20Id = (p20.body as { payment: { id: string } }).payment.id;
      const p30Id = (p30.body as { payment: { id: string } }).payment.id;
      const p20Row = await prisma.payment.findUniqueOrThrow({
        where: { id: p20Id },
      });
      const p30Row = await prisma.payment.findUniqueOrThrow({
        where: { id: p30Id },
      });
      expect(p20Row.cancellationSource).toBe(
        PaymentCancellationSource.SALE_CANCELLATION,
      );
      expect(p30Row.cancellationSource).toBe(
        PaymentCancellationSource.SALE_CANCELLATION,
      );

      const p10RowAfter = await prisma.payment.findUniqueOrThrow({
        where: { id: p10Id },
      });
      expect(p10RowAfter.cancellationSource).toBe(
        PaymentCancellationSource.MANUAL,
      );
      expect(p10RowAfter.cancelledAt?.getTime()).toBe(
        p10RowBefore.cancelledAt?.getTime(),
      );

      const cascadeAudits20 = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        'Payment',
        p20Id,
      );
      const cascadeAudits30 = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        'Payment',
        p30Id,
      );
      expect(cascadeAudits20).toHaveLength(1);
      expect(cascadeAudits30).toHaveLength(1);
      const p10Audits = await fetchAuditRows(
        AuditAction.PAYMENT_CANCELLED,
        'Payment',
        p10Id,
      );
      // Solo la manual previa; la cascada no crea una segunda para éste.
      expect(p10Audits).toHaveLength(1);
    });

    it('venta genérica totalmente pagada: anular la venta funciona (aunque la anulación manual de su pago esté prohibida); Payment se anula en cascada; resumen congelado en PAID; sin violar sales_generic_no_debt', async () => {
      const sale = await createDirectSale(adminCookie, {
        customerId: genericCustomerId,
        items: [{ productId: productCancelD.id, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '100.00' },
      });
      expect(sale.customerIsGeneric).toBe(true);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación de venta genérica pagada' });
      expect(response.status).toBe(200);
      const body = response.body as SafeSaleBody;
      expect(body.status).toBe(SaleStatus.CANCELLED);
      expect(body.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(body.balanceDue).toBe('0.00');
      const payment = body.payments[0] as SafeSalePaymentItem;
      expect(payment.status).toBe(PaymentStatus.CANCELLED);
      expect(payment.cancellationSource).toBe(
        PaymentCancellationSource.SALE_CANCELLATION,
      );
    });

    it('venta desde cotización con pago inicial: anular → Payment CANCELLED/SALE_CANCELLATION; Quote permanece CONVERTED; quoteId sin cambios; segunda conversión de la misma cotización → 409', async () => {
      const quote = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productCancelD, '1.000')],
      });
      const conversionResponse = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CASH', amount: '40.00' } });
      expect(conversionResponse.status).toBe(201);
      const sale = conversionResponse.body as SafeSaleBody;
      createdSaleIds.push(sale.id);

      const cancelResponse = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Anulación de venta desde cotización con pago' });
      expect(cancelResponse.status).toBe(200);
      const body = cancelResponse.body as SafeSaleBody;
      const payment = body.payments[0] as SafeSalePaymentItem;
      expect(payment.status).toBe(PaymentStatus.CANCELLED);
      expect(payment.cancellationSource).toBe(
        PaymentCancellationSource.SALE_CANCELLATION,
      );

      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);
      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.quoteId).toBe(quote.id);

      const secondConversion = await convertQuote(adminCookie, quote.id);
      expect(secondConversion.status).toBe(409);
    });

    it('atomicidad completa: en el mismo estado confirmado, Sale CANCELLED + Payment CANCELLED + stock restaurado + reversa + resumen congelado + SALE_CANCELLED + PAYMENT_CANCELLED, todo o nada', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productCancelD.id, quantity: '3.000' }],
        payment: { method: 'CASH', amount: '100.00' },
      });
      const payment = sale.payments[0] as SafeSalePaymentItem;

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'Atomicidad completa' });
      expect(response.status).toBe(200);

      const [saleRow, paymentRow, reversal, saleAudits, paymentAudits] =
        await Promise.all([
          prisma.sale.findUniqueOrThrow({ where: { id: sale.id } }),
          prisma.payment.findUniqueOrThrow({ where: { id: payment.id } }),
          prisma.inventoryMovement.findFirst({
            where: {
              referenceType: 'Sale',
              referenceId: sale.id,
              origin: InventoryMovementOrigin.SALE_CANCELLATION,
            },
          }),
          fetchAuditRows(AuditAction.SALE_CANCELLED, 'Sale', sale.id),
          fetchAuditRows(AuditAction.PAYMENT_CANCELLED, 'Payment', payment.id),
        ]);
      expect(saleRow.status).toBe(SaleStatus.CANCELLED);
      expect(paymentRow.status).toBe(PaymentStatus.CANCELLED);
      expect(reversal).not.toBeNull();
      expect(saleRow.paidAmount.toFixed(2)).toBe('100.00');
      expect(saleAudits).toHaveLength(1);
      expect(paymentAudits).toHaveLength(1);
    });

    // NOTA (§54 del kickoff de Bloque D): no existe, dentro de este
    // repositorio, un mecanismo seguro y ya existente para forzar que la
    // reversa de inventario falle a mitad de camino sin modificar
    // producción (agregar un hook solo para la prueba está explícitamente
    // prohibido). La atomicidad de "Sale CANCELLED + Payment CANCELLED +
    // reversa" ya queda cubierta estructuralmente: las tres escrituras
    // ocurren dentro de la MISMA `prisma.$transaction()` de
    // `SalesService.cancel()` (ver stock-movement.engine.ts +
    // payment.engine.ts, ambos sin `PrismaService` propio y siempre
    // recibiendo el mismo `tx`), así que cualquier fallo en cualquiera de
    // los tres pasos revierte la transacción completa — ya demostrado
    // indirectamente por la prueba de "atomicidad completa" de arriba, que
    // confirma el estado post-commit coherente.
  });

  // ==================================================================
  // Fase 7, Bloque D — historial de pagos en el detalle de venta
  // ==================================================================
  describe('Fase 7, Bloque D — historial de pagos en el detalle de venta', () => {
    it('GET /sales/:id incluye payments[] con ACTIVE y CANCELLED, ordenados paidAt ASC, id ASC; el listado (list item) nunca incluye payments', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
      });
      const first = await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Cookie', adminCookie)
        .send({ method: 'CASH', amount: '5.00' });
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments`)
        .set('Cookie', adminCookie)
        .send({ method: 'CASH', amount: '5.00' });
      const firstId = (first.body as { payment: { id: string } }).payment.id;
      await request(app.getHttpServer())
        .post(`/api/v1/sales/${sale.id}/payments/${firstId}/cancel`)
        .set('Cookie', adminCookie)
        .send({ reason: 'x' });

      const detail = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}`)
        .set('Cookie', adminCookie);
      const payments = (detail.body as SafeSaleBody)
        .payments as unknown as SafeSalePaymentItem[];
      expect(payments).toHaveLength(2);
      const statuses = payments.map((p) => p.status).sort();
      expect(statuses).toEqual(
        [PaymentStatus.ACTIVE, PaymentStatus.CANCELLED].sort(),
      );
      for (let i = 0; i + 1 < payments.length; i += 1) {
        expect(payments[i].paidAt <= payments[i + 1].paidAt).toBe(true);
      }

      const list = await request(app.getHttpServer())
        .get('/api/v1/sales')
        .query({ limit: 100 })
        .set('Cookie', adminCookie);
      const listItem = (
        list.body as { data: Record<string, unknown>[] }
      ).data.find((row) => row.id === sale.id);
      expect(listItem).toBeDefined();
      expect(listItem).not.toHaveProperty('payments');
    });
  });

  // ==================================================================
  // Fase 7, Bloque D — whitelist del pago inicial anidado (DTO)
  // ==================================================================
  describe('Fase 7, Bloque D — whitelist del pago inicial anidado', () => {
    const FORBIDDEN_FIELDS = [
      'paidAt',
      'status',
      'createdByUserId',
      'cancelledAt',
      'cancellationReason',
      'cancellationSource',
      'saleId',
      'paidAmount',
      'balanceDue',
    ];

    it.each(FORBIDDEN_FIELDS)(
      'POST /sales rechaza el campo "%s" dentro de payment (400)',
      async (field) => {
        const response = await request(app.getHttpServer())
          .post('/api/v1/sales')
          .set('Cookie', adminCookie)
          .send(
            validCreateSaleBody({
              items: [{ productId: productA.id, quantity: '1.000' }],
              payment: {
                method: 'CASH',
                amount: '1.00',
                [field]: 'valor-no-permitido',
              },
            }),
          );
        expect(response.status).toBe(400);
      },
    );

    it.each(FORBIDDEN_FIELDS)(
      'POST /sales/from-quote/:quoteId rechaza el campo "%s" dentro de payment (400)',
      async (field) => {
        const quote = await createDirectQuote({
          customerId: personActive.id,
          customerType: CustomerType.PERSON,
          customerName: personActive.name,
          items: [quoteItemFor(productA, '1.000')],
        });
        const response = await request(app.getHttpServer())
          .post(`/api/v1/sales/from-quote/${quote.id}`)
          .set('Cookie', adminCookie)
          .send({
            payment: {
              method: 'CASH',
              amount: '1.00',
              [field]: 'valor-no-permitido',
            },
          });
        expect(response.status).toBe(400);
        const quoteRow = await prisma.quote.findUniqueOrThrow({
          where: { id: quote.id },
        });
        expect(quoteRow.status).toBe(QuoteStatus.PENDING);
      },
    );
  });

  // ==================================================================
  // Fase 7, Bloque D — compatibilidad del cuerpo en conversión de cotización
  // ==================================================================
  describe('Fase 7, Bloque D — compatibilidad del cuerpo en conversión de cotización', () => {
    it('acepta sin cuerpo, {} y {"payment": {...}}; rechaza campos comerciales en el nivel superior', async () => {
      const quoteNoBody = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const noBody = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteNoBody.id}`)
        .set('Cookie', adminCookie)
        .send();
      expect(noBody.status).toBe(201);
      createdSaleIds.push((noBody.body as SafeSaleBody).id);

      const quoteEmpty = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const empty = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteEmpty.id}`)
        .set('Cookie', adminCookie)
        .send({});
      expect(empty.status).toBe(201);
      createdSaleIds.push((empty.body as SafeSaleBody).id);

      const quoteWithPayment = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const withPayment = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteWithPayment.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CASH', amount: '1.00' } });
      expect(withPayment.status).toBe(201);
      createdSaleIds.push((withPayment.body as SafeSaleBody).id);

      const quoteBadField = await createDirectQuote({
        customerId: personActive.id,
        customerType: CustomerType.PERSON,
        customerName: personActive.name,
        items: [quoteItemFor(productA, '1.000')],
      });
      const badField = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteBadField.id}`)
        .set('Cookie', adminCookie)
        .send({ discountAmount: '999.00' });
      expect(badField.status).toBe(400);
    });
  });

  // ==================================================================
  // Fase 7, Bloque D — impresión no expone datos de pago
  // ==================================================================
  describe('Fase 7, Bloque D — impresión no expone datos de pago', () => {
    it('venta con pago inicial parcial: el HTML impreso no menciona paymentStatus/paidAmount/balanceDue/referencia de Payment', async () => {
      const sale = await createDirectSale(adminCookie, {
        items: [{ productId: productA.id, quantity: '1.000' }],
        payment: {
          method: 'TRANSFER',
          amount: '5.00',
          reference: 'OP-PRINT-1',
        },
      });
      const response = await request(app.getHttpServer())
        .get(`/api/v1/sales/${sale.id}/print`)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const html = response.text;
      expect(html).not.toMatch(/paymentStatus/i);
      expect(html).not.toMatch(/paidAmount/i);
      expect(html).not.toMatch(/balanceDue/i);
      expect(html).not.toMatch(/OP-PRINT-1/);
      expect(html).not.toMatch(/PARTIALLY_PAID/);
    });
  });
});
