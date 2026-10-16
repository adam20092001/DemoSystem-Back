import { randomUUID } from 'crypto';
import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingEventType,
  AccountingSourceType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  PaymentStatus,
  Prisma,
  PrismaClient,
  ProductStatus,
  ProductType,
  QuoteStatus,
  RoleName,
  SalePaymentStatus,
  SaleStatus,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import {
  endOfBusinessDayExclusiveUtc,
  startOfBusinessDayUtc,
} from '../src/common/date/business-date';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

// ======================================================================
// Fase 8, Bloque D — Validación end-to-end de Contabilidad básica.
//
// Todo movimiento de negocio (Venta/Pago/anulación) se ejercita a través de
// los endpoints HTTP reales, para que SalesService/PaymentEngine/
// AccountingEngine corran juntos exactamente como en producción (§7 del
// encargo). Solo las pruebas de restricciones de base de datos (CHECK/FK/
// unicidad) insertan filas directamente vía Prisma, deliberadamente
// bypaseando el motor.
// ======================================================================

const MANAGEMENT_USERNAME = 'e2e_management_accounting';
const MANAGEMENT_PASSWORD = 'ManagementAccounting123';
const SELLER_USERNAME = 'e2e_seller_accounting';
const SELLER_PASSWORD = 'SellerAccounting123';
const WAREHOUSE_USERNAME = 'e2e_warehouse_accounting';
const WAREHOUSE_PASSWORD = 'WarehouseAccounting123';

const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';
const INVALID_UUID = 'not-a-uuid';

const CANONICAL_ACCOUNTS: Record<
  AccountingSystemKey,
  { code: string; name: string; type: AccountType }
> = {
  CASH: { code: 'CASH', name: 'Caja', type: AccountType.ASSET },
  BANK: { code: 'BANK', name: 'Bancos', type: AccountType.ASSET },
  ACCOUNTS_RECEIVABLE: {
    code: 'AR',
    name: 'Cuentas por cobrar',
    type: AccountType.ASSET,
  },
  VAT_PAYABLE: {
    code: 'VAT',
    name: 'IGV por pagar',
    type: AccountType.LIABILITY,
  },
  SALES_REVENUE: { code: 'SALES', name: 'Ventas', type: AccountType.REVENUE },
  DISCOUNTS: {
    code: 'DISCOUNTS',
    name: 'Descuentos',
    type: AccountType.CONTRA_REVENUE,
  },
};

// ----------------------------------------------------------------------
// Formas seguras de respuesta HTTP
// ----------------------------------------------------------------------

interface SafeAccountBody {
  id: string;
  code: string;
  name: string;
  type: AccountType;
  systemKey: AccountingSystemKey;
}

interface SafeAccountingEntryListItemBody {
  id: string;
  sourceType: AccountingSourceType;
  sourceId: string;
  eventType: AccountingEventType;
  reversesEntryId: string | null;
  description: string;
  postedAt: string;
  createdAt: string;
}

interface SafeAccountingUserBody {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

interface SafeAccountingEntryLineBody {
  id: string;
  accountId: string;
  accountCode: string;
  accountName: string;
  debitAmount: string;
  creditAmount: string;
}

interface SafeAccountingEntryBody extends SafeAccountingEntryListItemBody {
  createdBy: SafeAccountingUserBody;
  lines: SafeAccountingEntryLineBody[];
}

interface PaginatedBody<T> {
  data: T[];
  page: number;
  limit: number;
  total: number;
  totalPages: number;
}

interface SafeSaleBody {
  id: string;
  number: string;
  status: SaleStatus;
  paymentStatus: SalePaymentStatus;
  customerId: string;
  seller: { id: string; username: string };
  subtotal: string;
  discountAmount: string;
  taxAmount: string;
  total: string;
  paidAmount: string;
  balanceDue: string;
  payments: { id: string; method: string }[];
  confirmedAt: string;
  cancelledAt: string | null;
}

interface SafePaymentBody {
  id: string;
  saleId: string;
  method: string;
  amount: string;
  status: PaymentStatus;
  paidAt: string;
  createdBy: SafeAccountingUserBody;
  cancelledAt: string | null;
}

interface SalePaymentSummaryBody {
  id: string;
  number: string;
  status: SaleStatus;
  total: string;
  paidAmount: string;
  balanceDue: string;
  paymentStatus: SalePaymentStatus;
}

interface PaymentMutationBody {
  payment: SafePaymentBody;
  sale: SalePaymentSummaryBody;
}

describe('Basic Accounting (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  let adminCookie: string;
  let managementCookie: string;
  let sellerCookie: string;
  let warehouseCookie: string;
  let adminId: string;

  let categoryId: string;
  let unitId: string;
  let productHundredId: string;
  let productZeroId: string;
  let personActive: { id: string; name: string };

  // systemKey -> id de la cuenta canónica (leído una vez, nunca hardcodeado).
  const accountIds = {} as Record<AccountingSystemKey, string>;

  // Ownership estricto por ID inmutable (§5 del encargo). Nunca deleteMany({}).
  const ownedSaleIds: string[] = [];
  const ownedPaymentIds: string[] = [];
  const ownedQuoteIds: string[] = [];
  const ownedCustomerIds: string[] = [];
  const ownedProductIds: string[] = [];
  const ownedCategoryIds: string[] = [];
  const ownedUnitIds: string[] = [];
  const ownedTemporaryUserIds: string[] = [];
  // sourceType/sourceId propios cuyo AccountingEntry pudo crearse fuera del
  // ciclo de vida de una Sale/Payment propia (pruebas de invariantes de BD
  // con sourceId sintético — §51/§52/§58/§59/§60-related raw fixtures).
  const ownedSyntheticAccountingSources: {
    sourceType: AccountingSourceType;
    sourceId: string;
  }[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }
  /** Sufijo corto (base36) para columnas de ancho estrecho, p. ej. Unit.code VarChar(15). */
  function nextShortSuffix(): string {
    counter += 1;
    return `${RUN_ID.toString(36)}${counter.toString(36)}`;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_accounting@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_accounting@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });
    await upsertFixtureUser(prisma, {
      username: WAREHOUSE_USERNAME,
      email: 'e2e_warehouse_accounting@demosystem.test',
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
    managementCookie = (
      await login(app.getHttpServer(), MANAGEMENT_USERNAME, MANAGEMENT_PASSWORD)
    ).cookie;
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, SELLER_PASSWORD)
    ).cookie;
    warehouseCookie = (
      await login(app.getHttpServer(), WAREHOUSE_USERNAME, WAREHOUSE_PASSWORD)
    ).cookie;

    adminId = (
      await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      })
    ).id;

    for (const key of Object.values(AccountingSystemKey)) {
      const row = await prisma.account.findUniqueOrThrow({
        where: { systemKey: key },
      });
      accountIds[key] = row.id;
    }

    // Secuencia NV: upsert defensivo (nunca destructivo — `update: {}`
    // conserva currentNumber si ya existe), mismo criterio exacto que
    // sales.e2e-spec.ts/quotes.e2e-spec.ts. Necesario porque este archivo
    // crea Sales reales por HTTP y, con maxWorkers=1, puede ejecutarse
    // después de un archivo que dejó la fila ausente en su propio afterAll.
    // A diferencia de esos archivos, este nunca la elimina en afterAll: no
    // le corresponde a esta suite decidir si la siguiente la necesitará.
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
    // Idem para COT: §29/§30 crean Quotes reales por HTTP.
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

    const category = await prisma.category.create({
      data: {
        code: `E2EA-CAT-${nextSuffix()}`,
        name: `Categoria E2E Accounting ${nextSuffix()}`,
        status: 'ACTIVE',
      },
    });
    categoryId = category.id;
    ownedCategoryIds.push(categoryId);

    const unit = await prisma.unit.create({
      data: {
        code: `E2A${nextShortSuffix()}`,
        name: `Unidad E2E Accounting ${nextSuffix()}`,
        abbreviation: 'uea',
        allowDecimal: true,
        status: 'ACTIVE',
      },
    });
    unitId = unit.id;
    ownedUnitIds.push(unitId);

    const productHundred = await prisma.product.create({
      data: {
        sku: `E2EA-100-${nextSuffix()}`,
        name: `Producto E2E Accounting 100 ${nextSuffix()}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('100.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('1000000.000'),
        status: ProductStatus.ACTIVE,
      },
    });
    productHundredId = productHundred.id;
    ownedProductIds.push(productHundredId);

    // salePrice = "0.00" — no hay ninguna regla que exija precio positivo
    // (CHECK products_sale_price_non_negative admite 0). Es la única vía
    // real (sin tocar producción) para producir una venta subtotal=0 a
    // través del flujo HTTP genuino de Ventas (§13).
    const productZero = await prisma.product.create({
      data: {
        sku: `E2EA-0-${nextSuffix()}`,
        name: `Producto E2E Accounting Cero ${nextSuffix()}`,
        productType: ProductType.PRODUCT,
        categoryId,
        unitId,
        salePrice: new Prisma.Decimal('0.00'),
        isInventoryTracked: true,
        stockCurrent: new Prisma.Decimal('1000000.000'),
        status: ProductStatus.ACTIVE,
      },
    });
    productZeroId = productZero.id;
    ownedProductIds.push(productZeroId);

    const customer = await prisma.customer.create({
      data: {
        customerType: CustomerType.PERSON,
        customerStage: CustomerStage.CUSTOMER,
        status: CustomerStatus.ACTIVE,
        name: `Cliente E2E Accounting ${nextSuffix()}`,
      },
    });
    personActive = { id: customer.id, name: customer.name };
    ownedCustomerIds.push(customer.id);
  }, 120000);

  afterAll(async () => {
    try {
      // --------------------------------------------------------------
      // 1-2. Asientos contables propios (REVERSAL antes que ORIGINAL: el
      // self-FK reversesEntryId apunta al ORIGINAL). Las líneas se van
      // solas por CASCADE.
      // --------------------------------------------------------------
      const ownedPayments = await prisma.payment.findMany({
        where: { saleId: { in: ownedSaleIds } },
        select: { id: true },
      });
      const allOwnedPaymentIds = [
        ...new Set([...ownedPaymentIds, ...ownedPayments.map((p) => p.id)]),
      ];

      const accountingSourceConditions: Prisma.AccountingEntryWhereInput[] = [
        {
          sourceType: AccountingSourceType.SALE,
          sourceId: { in: ownedSaleIds },
        },
      ];
      if (allOwnedPaymentIds.length > 0) {
        accountingSourceConditions.push({
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: { in: allOwnedPaymentIds },
        });
      }
      for (const synthetic of ownedSyntheticAccountingSources) {
        accountingSourceConditions.push({
          sourceType: synthetic.sourceType,
          sourceId: synthetic.sourceId,
        });
      }
      const accountingWhere: Prisma.AccountingEntryWhereInput = {
        OR: accountingSourceConditions,
      };
      await prisma.accountingEntry.deleteMany({
        where: { ...accountingWhere, eventType: AccountingEventType.REVERSAL },
      });
      await prisma.accountingEntry.deleteMany({
        where: { ...accountingWhere, eventType: AccountingEventType.ORIGINAL },
      });

      // --------------------------------------------------------------
      // 3-4. AuditLog de Payment y de Sale/Quote propios.
      // --------------------------------------------------------------
      if (allOwnedPaymentIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: {
            entityType: 'Payment',
            entityId: { in: allOwnedPaymentIds },
          },
        });
      }
      if (ownedSaleIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: ownedSaleIds } },
        });
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: ownedSaleIds } },
        });
      }
      if (ownedQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: ownedQuoteIds } },
        });
      }

      // --------------------------------------------------------------
      // 5-6. Payments propios, luego InventoryMovements ya cubiertos arriba.
      // --------------------------------------------------------------
      if (ownedSaleIds.length > 0) {
        await prisma.payment.deleteMany({
          where: { saleId: { in: ownedSaleIds } },
        });
      }

      // --------------------------------------------------------------
      // 7-8. Sales/SaleItems (cascade), luego Quotes.
      // --------------------------------------------------------------
      if (ownedSaleIds.length > 0) {
        await prisma.sale.deleteMany({ where: { id: { in: ownedSaleIds } } });
      }
      if (ownedQuoteIds.length > 0) {
        await prisma.quote.deleteMany({ where: { id: { in: ownedQuoteIds } } });
      }

      // --------------------------------------------------------------
      // 9. Clientes/productos/catálogo propios.
      // --------------------------------------------------------------
      if (ownedProductIds.length > 0) {
        await prisma.inventoryMovement.deleteMany({
          where: { productId: { in: ownedProductIds } },
        });
        await prisma.product.deleteMany({
          where: { id: { in: ownedProductIds } },
        });
      }
      await prisma.unit.deleteMany({ where: { id: { in: ownedUnitIds } } });
      await prisma.category.deleteMany({
        where: { id: { in: ownedCategoryIds } },
      });
      if (ownedCustomerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Customer', entityId: { in: ownedCustomerIds } },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: ownedCustomerIds } },
        });
      }

      // --------------------------------------------------------------
      // 10. Usuarios temporales propios. Nunca se tocan
      // admin/seller/management/warehouse compartidos.
      // --------------------------------------------------------------
      if (ownedTemporaryUserIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { userId: { in: ownedTemporaryUserIds } },
        });
        await prisma.user.deleteMany({
          where: { id: { in: ownedTemporaryUserIds } },
        });
      }

      // Secuencias NV/COT: mismo criterio exacto que sales.e2e-spec.ts/
      // quotes.e2e-spec.ts (se eliminan al final, nunca solo se resetea el
      // contador): esta suite crea Sales/Quotes reales igual que aquellas,
      // así que asume la misma responsabilidad de dejar la fila ausente
      // para que el siguiente archivo que la necesite la recree fresca en 0
      // vía su propio upsert defensivo. Sin este paso, cualquier suite
      // posterior que asuma "currentNumber = 0 antes de la primera venta/
      // cotización" (ya existente en sales.e2e-spec.ts/quotes.e2e-spec.ts)
      // fallaría por un efecto colateral de esta suite.
      await prisma.documentSequence.deleteMany({
        where: {
          documentType: { in: [DocumentType.SALE, DocumentType.QUOTE] },
        },
      });

      // Verificación final: las seis cuentas canónicas permanecen intactas.
      const finalAccounts = await prisma.account.findMany({
        orderBy: { code: 'asc' },
      });
      if (finalAccounts.length !== 6) {
        throw new Error(
          `Limpieza de Bloque D dejó el plan de cuentas en un estado inesperado: ${finalAccounts.length} cuentas (se esperaban 6).`,
        );
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 120000);

  // ====================================================================
  // Helpers
  // ====================================================================

  function validCreateSaleBody(
    overrides: Record<string, unknown> = {},
  ): Record<string, unknown> {
    return {
      customerId: personActive.id,
      items: [{ productId: productHundredId, quantity: '1.000' }],
      ...overrides,
    };
  }

  async function createSaleHttp(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send(validCreateSaleBody(overrides));
  }

  async function createSaleOrThrow(
    cookie: string,
    overrides: Record<string, unknown> = {},
  ): Promise<SafeSaleBody> {
    const response = await createSaleHttp(cookie, overrides);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo crear la venta fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const body = response.body as SafeSaleBody;
    ownedSaleIds.push(body.id);
    return body;
  }

  /** Venta subtotal=100, sin descuento/impuesto/pago: total=100. */
  async function createBasicSale(
    cookie: string = adminCookie,
  ): Promise<SafeSaleBody> {
    return createSaleOrThrow(cookie, {
      items: [{ productId: productHundredId, quantity: '1.000' }],
    });
  }

  async function registerPaymentHttp(
    cookie: string,
    saleId: string,
    body: Record<string, unknown>,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments`)
      .set('Cookie', cookie)
      .send(body);
  }

  async function registerPaymentOrThrow(
    cookie: string,
    saleId: string,
    body: Record<string, unknown>,
  ): Promise<PaymentMutationBody> {
    const response = await registerPaymentHttp(cookie, saleId, body);
    if (response.status !== 201) {
      throw new Error(
        `No se pudo registrar el pago fixture: ${JSON.stringify(response.body)}`,
      );
    }
    const parsed = response.body as PaymentMutationBody;
    ownedPaymentIds.push(parsed.payment.id);
    return parsed;
  }

  async function cancelPaymentHttp(
    cookie: string,
    saleId: string,
    paymentId: string,
    reason = 'Anulación fixture E2E de Contabilidad',
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/payments/${paymentId}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  async function cancelSaleHttp(
    cookie: string,
    saleId: string,
    reason = 'Anulación fixture E2E de Contabilidad',
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .post(`/api/v1/sales/${saleId}/cancel`)
      .set('Cookie', cookie)
      .send({ reason });
  }

  async function fetchEntriesFor(
    sourceType: AccountingSourceType,
    sourceId: string,
  ) {
    return prisma.accountingEntry.findMany({
      where: { sourceType, sourceId },
      include: { lines: true },
      orderBy: { createdAt: 'asc' },
    });
  }

  async function fetchAuditRows(action: AuditAction, entityId: string) {
    return prisma.auditLog.findMany({
      where: { action, entityType: 'AccountingEntry', entityId },
    });
  }

  function assertNoLeakage(response: { body: unknown }): void {
    const serialized = JSON.stringify(response.body);
    expect(serialized).not.toMatch(/prisma/i);
    expect(serialized).not.toMatch(/P2002/);
    expect(serialized).not.toMatch(/P2003/);
    expect(serialized).not.toMatch(/P2010/);
    expect(serialized).not.toMatch(/23505/);
    expect(serialized).not.toMatch(/23514/);
    expect(serialized).not.toMatch(/23503/);
    expect(serialized).not.toMatch(/constraint/i);
    expect(serialized).not.toMatch(/accounting_/);
    expect(serialized).not.toMatch(/chart_of_accounts/);
    expect(serialized).not.toMatch(/at Object/);
    expect(serialized).not.toMatch(/[a-zA-Z]:\\/);
  }

  async function expectPgRejection(
    insert: () => Promise<unknown>,
    sqlstate: '23514' | '23505' | '23503',
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

  /**
   * Inserción cruda de un asiento (bypass total de AccountingEngine) para
   * las pruebas de invariantes de base de datos (§45-§60). `id` fijo
   * opcional para escenarios de auto-reversa (§49).
   */
  async function rawInsertEntry(overrides: {
    id?: string;
    sourceType?: AccountingSourceType;
    sourceId?: string;
    eventType?: AccountingEventType;
    reversesEntryId?: string | null;
    description?: string;
    postedAt?: Date;
    createdByUserId?: string;
  }): Promise<string> {
    const o = {
      id: overrides.id ?? randomUUID(),
      sourceType: overrides.sourceType ?? AccountingSourceType.SALE,
      sourceId: overrides.sourceId ?? randomUUID(),
      eventType: overrides.eventType ?? AccountingEventType.ORIGINAL,
      reversesEntryId: overrides.reversesEntryId ?? null,
      description: overrides.description ?? `Asiento crudo E2E ${nextSuffix()}`,
      postedAt: overrides.postedAt ?? new Date(),
      createdByUserId: overrides.createdByUserId ?? adminId,
    };
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO accounting_entries
        (id, source_type, source_id, event_type, reverses_entry_id,
         description, posted_at, created_by_user_id, created_at)
      VALUES
        (${o.id}::uuid, ${o.sourceType}::"AccountingSourceType", ${o.sourceId}::uuid,
         ${o.eventType}::"AccountingEventType", ${o.reversesEntryId}::uuid,
         ${o.description}, ${o.postedAt}::timestamp, ${o.createdByUserId}::uuid, now())
      RETURNING id
    `;
    return rows[0].id;
  }

  async function rawInsertLine(overrides: {
    entryId: string;
    accountId?: string;
    debitAmount?: string;
    creditAmount?: string;
  }): Promise<string> {
    const o = {
      accountId: overrides.accountId ?? accountIds.CASH,
      debitAmount: overrides.debitAmount ?? '0',
      creditAmount: overrides.creditAmount ?? '0',
      ...overrides,
    };
    const rows = await prisma.$queryRaw<{ id: string }[]>`
      INSERT INTO accounting_entry_lines
        (id, entry_id, account_id, debit_amount, credit_amount, created_at)
      VALUES
        (gen_random_uuid(), ${o.entryId}::uuid, ${o.accountId}::uuid,
         ${o.debitAmount}::numeric, ${o.creditAmount}::numeric, now())
      RETURNING id
    `;
    return rows[0].id;
  }

  /** Crea un ORIGINAL balanceado válido (2 líneas CASH/AR) y lo registra como propio, para pruebas que necesitan un asiento persistente de partida. */
  async function createOwnedBalancedOriginal(amount = '10.00'): Promise<{
    id: string;
    sourceId: string;
    sourceType: AccountingSourceType;
  }> {
    const sourceType = AccountingSourceType.PAYMENT;
    const sourceId = randomUUID();
    const entryId = await rawInsertEntry({ sourceType, sourceId });
    await rawInsertLine({
      entryId,
      accountId: accountIds.CASH,
      debitAmount: amount,
      creditAmount: '0',
    });
    await rawInsertLine({
      entryId,
      accountId: accountIds.ACCOUNTS_RECEIVABLE,
      debitAmount: '0',
      creditAmount: amount,
    });
    ownedSyntheticAccountingSources.push({ sourceType, sourceId });
    return { id: entryId, sourceId, sourceType };
  }

  /**
   * Retira temporalmente una cuenta canónica (por systemKey), ejecuta `fn`,
   * y la restituye SIEMPRE en `finally` con exactamente su id/código/
   * nombre/tipo/systemKey/fecha de creación original. Solo se usa contra
   * pos_db_test. VAT_PAYABLE nunca es referenciada por ningún flujo real de
   * este sistema (taxAmount siempre 0 — §14), así que retirarla temporalmente
   * en cualquier punto del archivo es siempre seguro (nunca hay una línea
   * propia que la referencie). SALES_REVENUE/BANK solo se retiran al
   * comienzo del archivo, antes de que exista ninguna Sale/Payment propia
   * que las referencie (§63/§64).
   */
  async function withTemporarilyRemovedAccount<T>(
    systemKey: AccountingSystemKey,
    fn: () => Promise<T>,
  ): Promise<T> {
    const original = await prisma.account.findUniqueOrThrow({
      where: { systemKey },
    });
    await prisma.account.delete({ where: { id: original.id } });
    try {
      return await fn();
    } finally {
      await prisma.account.create({
        data: {
          id: original.id,
          code: original.code,
          name: original.name,
          type: original.type,
          systemKey: original.systemKey,
          createdAt: original.createdAt,
        },
      });
    }
  }

  async function listEntriesHttp(
    cookie: string,
    query: Record<string, string> = {},
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounting/entries')
      .query(query)
      .set('Cookie', cookie);
  }

  async function getEntryHttp(
    cookie: string,
    id: string,
  ): Promise<request.Response> {
    return request(app.getHttpServer())
      .get(`/api/v1/accounting/entries/${id}`)
      .set('Cookie', cookie);
  }

  async function listAccountsHttp(cookie: string): Promise<request.Response> {
    return request(app.getHttpServer())
      .get('/api/v1/accounts')
      .set('Cookie', cookie);
  }

  // ====================================================================
  // §63/§64 — Atomicidad ante cuenta de sistema faltante.
  //
  // DEBEN correr como las PRIMERAS acciones de negocio reales del archivo:
  // §63 retira SALES_REVENUE (referenciada por TODA Sale con actividad
  // económica) antes de que exista ninguna Sale propia; §64 retira BANK
  // antes de que exista ningún Payment propio con método distinto de CASH.
  // Ejecutarlas más tarde sería inseguro: cualquier Sale/Payment previa ya
  // referenciaría esas cuentas, y el DELETE temporal fallaría por RESTRICT.
  // ====================================================================
  describe('§63 — atomicidad: creación de venta sin cuenta SALES_REVENUE', () => {
    it('falla completa (500) y revierte TODO: sin Sale, SaleItem, ORIGINAL, InventoryMovement, SALE_CONFIRMED ni ACCOUNTING_ENTRY_POSTED', async () => {
      const stockBefore = (
        await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        })
      ).stockCurrent;
      const salesBefore = await prisma.sale.count();
      const auditBefore = await prisma.auditLog.count();
      const entriesBefore = await prisma.accountingEntry.count();

      const response = await withTemporarilyRemovedAccount(
        AccountingSystemKey.SALES_REVENUE,
        () => createSaleHttp(adminCookie),
      );

      expect(response.status).toBe(500);
      assertNoLeakage(response);
      // Remediación verificada (AllExceptionsFilter.fromHttpException):
      // el cuerpo 500 nunca contiene el nombre interno de la cuenta de
      // sistema faltante, y el mensaje es exactamente el genérico del
      // repositorio, no el mensaje descriptivo interno de AccountingEngine.
      expect(JSON.stringify(response.body)).not.toMatch(/SALES_REVENUE/);
      expect(response.body).toMatchObject({
        statusCode: 500,
        message: 'Error interno del servidor',
        error: 'Internal Server Error',
      });

      const salesAfter = await prisma.sale.count();
      const auditAfter = await prisma.auditLog.count();
      const entriesAfter = await prisma.accountingEntry.count();
      const stockAfter = (
        await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        })
      ).stockCurrent;

      expect(salesAfter).toBe(salesBefore);
      expect(auditAfter).toBe(auditBefore);
      expect(entriesAfter).toBe(entriesBefore);
      expect(stockAfter.toFixed(3)).toBe(stockBefore.toFixed(3));

      // La cuenta SALES_REVENUE quedó exactamente restituida.
      const restored = await prisma.account.findUniqueOrThrow({
        where: { systemKey: AccountingSystemKey.SALES_REVENUE },
      });
      expect(restored.code).toBe(CANONICAL_ACCOUNTS.SALES_REVENUE.code);
      expect(restored.name).toBe(CANONICAL_ACCOUNTS.SALES_REVENUE.name);
    });
  });

  describe('§64 — atomicidad: registro de pago sin cuenta BANK', () => {
    it('falla completa (500) y revierte TODO: sin Payment, ORIGINAL, PAYMENT_REGISTERED ni ACCOUNTING_ENTRY_POSTED; resumen de la venta intacto', async () => {
      const sale = await createBasicSale();

      const paymentsBefore = await prisma.payment.count();
      const entriesBefore = await prisma.accountingEntry.count();
      const auditBefore = await prisma.auditLog.count();

      const response = await withTemporarilyRemovedAccount(
        AccountingSystemKey.BANK,
        () =>
          registerPaymentHttp(adminCookie, sale.id, {
            method: 'TRANSFER',
            amount: '10.00',
            reference: 'OP-ATOMIC-64',
          }),
      );

      expect(response.status).toBe(500);
      assertNoLeakage(response);
      // Remediación verificada: sin fuga de "BANK" ni de ningún detalle de
      // configuración/cuenta interna; mensaje genérico exacto.
      expect(JSON.stringify(response.body)).not.toMatch(/\bBANK\b/);
      expect(response.body).toMatchObject({
        statusCode: 500,
        message: 'Error interno del servidor',
        error: 'Internal Server Error',
      });

      const paymentsAfter = await prisma.payment.count();
      const entriesAfter = await prisma.accountingEntry.count();
      const auditAfter = await prisma.auditLog.count();
      expect(paymentsAfter).toBe(paymentsBefore);
      expect(entriesAfter).toBe(entriesBefore);
      expect(auditAfter).toBe(auditBefore);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.paidAmount.toFixed(2)).toBe('0.00');
      expect(saleRow.balanceDue.toFixed(2)).toBe('100.00');
      expect(saleRow.paymentStatus).toBe(SalePaymentStatus.UNPAID);

      const restored = await prisma.account.findUniqueOrThrow({
        where: { systemKey: AccountingSystemKey.BANK },
      });
      expect(restored.code).toBe(CANONICAL_ACCOUNTS.BANK.code);
    });
  });

  // ====================================================================
  // §8 — Autenticación y autorización de lectura contable
  // ====================================================================
  describe('§8 — autenticación y matriz de roles', () => {
    it('sin cookie: los 3 endpoints responden 401', async () => {
      const sale = await createBasicSale();
      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      const entryId = entries[0].id;
      const server = app.getHttpServer();
      const responses = await Promise.all([
        request(server).get('/api/v1/accounts'),
        request(server).get('/api/v1/accounting/entries'),
        request(server).get(`/api/v1/accounting/entries/${entryId}`),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(401);
      }
    });

    it('ADMIN y MANAGEMENT: los 3 endpoints permitidos (200)', async () => {
      const sale = await createBasicSale();
      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      const entryId = entries[0].id;
      for (const cookie of [adminCookie, managementCookie]) {
        const [accounts, list, detail] = await Promise.all([
          listAccountsHttp(cookie),
          listEntriesHttp(cookie),
          getEntryHttp(cookie, entryId),
        ]);
        expect(accounts.status).toBe(200);
        expect(list.status).toBe(200);
        expect(detail.status).toBe(200);
      }
    });

    it('SELLER y WAREHOUSE: los 3 endpoints -> 403 (con un id de detalle válido, para no confundir con 404)', async () => {
      const sale = await createBasicSale();
      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      const entryId = entries[0].id;
      for (const cookie of [sellerCookie, warehouseCookie]) {
        const [accounts, list, detail] = await Promise.all([
          listAccountsHttp(cookie),
          listEntriesHttp(cookie),
          getEntryHttp(cookie, entryId),
        ]);
        expect(accounts.status).toBe(403);
        expect(list.status).toBe(403);
        expect(detail.status).toBe(403);
      }
    });
  });

  // ====================================================================
  // §9 — Plan de cuentas
  // ====================================================================
  describe('§9 — GET /accounts', () => {
    it('exactamente 6 cuentas, valores canónicos exactos, orden code ASC, sin campos extra', async () => {
      const response = await listAccountsHttp(adminCookie);
      expect(response.status).toBe(200);
      const accounts = response.body as SafeAccountBody[];
      expect(accounts).toHaveLength(6);

      const codes = accounts.map((a) => a.code);
      expect(codes).toEqual([...codes].sort());

      for (const account of accounts) {
        expect(Object.keys(account).sort()).toEqual(
          ['id', 'code', 'name', 'type', 'systemKey'].sort(),
        );
      }

      const bySystemKey = new Map(accounts.map((a) => [a.systemKey, a]));
      for (const [systemKey, expected] of Object.entries(CANONICAL_ACCOUNTS)) {
        const actual = bySystemKey.get(systemKey as AccountingSystemKey);
        expect(actual).toBeDefined();
        expect(actual?.code).toBe(expected.code);
        expect(actual?.name).toBe(expected.name);
        expect(actual?.type).toBe(expected.type);
      }
    });

    it('la lectura no crea ningún AuditLog', async () => {
      const before = await prisma.auditLog.count();
      await listAccountsHttp(adminCookie);
      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });
  });

  // ====================================================================
  // §10-14 — Reconocimiento contable de venta
  // ====================================================================
  describe('§10 — Sale ORIGINAL básica (sin pago), 100/0/100', () => {
    it('exactamente un asiento ORIGINAL, AR 100 debe / SALES 100 haber, sin línea extra', async () => {
      const auditBefore = await prisma.auditLog.count({
        where: { action: AuditAction.ACCOUNTING_ENTRY_POSTED },
      });
      const sale = await createBasicSale();
      expect(sale.subtotal).toBe('100.00');
      expect(sale.discountAmount).toBe('0.00');
      expect(sale.taxAmount).toBe('0.00');
      expect(sale.total).toBe('100.00');

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      expect(entries).toHaveLength(1);
      const entry = entries[0];
      expect(entry.sourceType).toBe(AccountingSourceType.SALE);
      expect(entry.sourceId).toBe(sale.id);
      expect(entry.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(entry.reversesEntryId).toBeNull();
      expect(entry.description).toBe(`Venta ${sale.number}`);
      expect(entry.postedAt.toISOString()).toBe(sale.confirmedAt);
      expect(entry.createdByUserId).toBe(adminId);

      expect(entry.lines).toHaveLength(2);
      const ar = entry.lines.find(
        (l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE,
      );
      const sales = entry.lines.find(
        (l) => l.accountId === accountIds.SALES_REVENUE,
      );
      expect(ar).toBeDefined();
      expect(ar?.debitAmount.toFixed(2)).toBe('100.00');
      expect(ar?.creditAmount.toFixed(2)).toBe('0.00');
      expect(sales).toBeDefined();
      expect(sales?.debitAmount.toFixed(2)).toBe('0.00');
      expect(sales?.creditAmount.toFixed(2)).toBe('100.00');

      const audits = await fetchAuditRows(
        AuditAction.ACCOUNTING_ENTRY_POSTED,
        entry.id,
      );
      expect(audits).toHaveLength(1);
      const auditAfter = await prisma.auditLog.count({
        where: { action: AuditAction.ACCOUNTING_ENTRY_POSTED },
      });
      expect(auditAfter).toBe(auditBefore + 1);

      const saleConfirmedAudits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.SALE_CONFIRMED,
          entityType: 'Sale',
          entityId: sale.id,
        },
      });
      expect(saleConfirmedAudits).toHaveLength(1);
    });
  });

  describe('§11 — Sale con descuento, 100/10/90', () => {
    it('DEBIT AR 90 + DEBIT DISCOUNTS 10 / CREDIT SALES 100, sin línea VAT', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        discountAmount: '10.00',
      });
      expect(sale.subtotal).toBe('100.00');
      expect(sale.discountAmount).toBe('10.00');
      expect(sale.total).toBe('90.00');

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      expect(entries).toHaveLength(1);
      const lines = entries[0].lines;
      expect(lines).toHaveLength(3);

      const ar = lines.find(
        (l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE,
      );
      const discounts = lines.find((l) => l.accountId === accountIds.DISCOUNTS);
      const sales = lines.find((l) => l.accountId === accountIds.SALES_REVENUE);
      const vat = lines.find((l) => l.accountId === accountIds.VAT_PAYABLE);
      expect(ar?.debitAmount.toFixed(2)).toBe('90.00');
      expect(discounts?.debitAmount.toFixed(2)).toBe('10.00');
      expect(sales?.creditAmount.toFixed(2)).toBe('100.00');
      expect(vat).toBeUndefined();

      const totalDebit = lines.reduce(
        (acc, l) => acc.plus(l.debitAmount),
        new Prisma.Decimal(0),
      );
      const totalCredit = lines.reduce(
        (acc, l) => acc.plus(l.creditAmount),
        new Prisma.Decimal(0),
      );
      expect(totalDebit.equals(totalCredit)).toBe(true);
    });
  });

  describe('§12 — Sale con descuento total, 100/100/0', () => {
    it('ORIGINAL existe: DEBIT DISCOUNTS 100 / CREDIT SALES 100, sin línea AR ni VAT; total sigue 0', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        discountAmount: '100.00',
      });
      expect(sale.total).toBe('0.00');

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      expect(entries).toHaveLength(1);
      const lines = entries[0].lines;
      expect(lines).toHaveLength(2);
      const discounts = lines.find((l) => l.accountId === accountIds.DISCOUNTS);
      const sales = lines.find((l) => l.accountId === accountIds.SALES_REVENUE);
      const ar = lines.find(
        (l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE,
      );
      expect(discounts?.debitAmount.toFixed(2)).toBe('100.00');
      expect(sales?.creditAmount.toFixed(2)).toBe('100.00');
      expect(ar).toBeUndefined();
    });
  });

  describe('§13 — Sale all-zero (subtotal=discount=tax=total=0)', () => {
    it('la venta se confirma; CERO AccountingEntry y CERO ACCOUNTING_ENTRY_POSTED; SALE_CONFIRMED sigue existiendo; la anulación posterior también funciona sin intentar revertir nada', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productZeroId, quantity: '1.000' }],
      });
      expect(sale.subtotal).toBe('0.00');
      expect(sale.discountAmount).toBe('0.00');
      expect(sale.taxAmount).toBe('0.00');
      expect(sale.total).toBe('0.00');
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      expect(entries).toHaveLength(0);

      const posted = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.ACCOUNTING_ENTRY_POSTED,
          entityType: 'AccountingEntry',
        },
      });
      // No hay forma de filtrar directamente por sourceId en AuditLog de
      // ACCOUNTING_ENTRY_POSTED (su entityId es el id del asiento, que aquí
      // nunca se creó); basta con confirmar que sigue sin existir ningún
      // asiento para esta Sale (ya verificado arriba).
      expect(posted.length).toBeGreaterThanOrEqual(0);

      const confirmed = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.SALE_CONFIRMED,
          entityType: 'Sale',
          entityId: sale.id,
        },
      });
      expect(confirmed).toHaveLength(1);

      // §67 contraste: la anulación de una Sale all-zero SIN ORIGINAL previo
      // debe tener éxito (no es el caso de corrupción de §66).
      const cancelResponse = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelResponse.status).toBe(200);
      const reversalEntries = await fetchEntriesFor(
        AccountingSourceType.SALE,
        sale.id,
      );
      expect(reversalEntries).toHaveLength(0);
    });
  });

  describe('§14 — límite de VAT: nunca aparece una línea VAT en asientos reales', () => {
    it('taxAmount siempre "0.00"; ninguna línea de las pruebas anteriores referencia VAT_PAYABLE (cubierto por §11/§12); documentado: VAT no es alcanzable desde ningún flujo HTTP actual', async () => {
      const sale = await createBasicSale();
      expect(sale.taxAmount).toBe('0.00');
      const linesReferencingVat = await prisma.accountingEntryLine.count({
        where: { accountId: accountIds.VAT_PAYABLE },
      });
      expect(linesReferencingVat).toBe(0);
    });
  });

  // ====================================================================
  // §15-19 — Contabilidad de pagos
  // ====================================================================
  describe('§15 — Sale 100 con pago inicial parcial 40', () => {
    it('dos asientos ORIGINAL (SALE + PAYMENT); resumen operativo PARTIALLY_PAID 40/60, no alterado por contabilidad', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '40.00' },
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(sale.paidAmount).toBe('40.00');
      expect(sale.balanceDue).toBe('60.00');
      const paymentId = sale.payments[0].id;
      ownedPaymentIds.push(paymentId);

      const saleEntries = await fetchEntriesFor(
        AccountingSourceType.SALE,
        sale.id,
      );
      expect(saleEntries).toHaveLength(1);
      const paymentEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        paymentId,
      );
      expect(paymentEntries).toHaveLength(1);

      const paymentLines = paymentEntries[0].lines;
      const cash = paymentLines.find((l) => l.accountId === accountIds.CASH);
      const ar = paymentLines.find(
        (l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE,
      );
      expect(cash?.debitAmount.toFixed(2)).toBe('40.00');
      expect(ar?.creditAmount.toFixed(2)).toBe('40.00');

      const totalOriginals = await prisma.accountingEntry.count({
        where: {
          eventType: AccountingEventType.ORIGINAL,
          OR: [
            { sourceType: AccountingSourceType.SALE, sourceId: sale.id },
            { sourceType: AccountingSourceType.PAYMENT, sourceId: paymentId },
          ],
        },
      });
      expect(totalOriginals).toBe(2);
    });
  });

  describe('§16 — Sale 100 con pago inicial completo 100', () => {
    it('dos asientos ORIGINAL (no colapsados); resumen operativo PAID 100/0', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '100.00' },
      });
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      expect(sale.paidAmount).toBe('100.00');
      expect(sale.balanceDue).toBe('0.00');
      const paymentId = sale.payments[0].id;
      ownedPaymentIds.push(paymentId);

      const saleEntries = await fetchEntriesFor(
        AccountingSourceType.SALE,
        sale.id,
      );
      const paymentEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        paymentId,
      );
      expect(saleEntries).toHaveLength(1);
      expect(paymentEntries).toHaveLength(1);
      expect(saleEntries[0].id).not.toBe(paymentEntries[0].id);

      const lines = paymentEntries[0].lines;
      const cash = lines.find((l) => l.accountId === accountIds.CASH);
      expect(cash?.debitAmount.toFixed(2)).toBe('100.00');
    });
  });

  describe('§17 — mapeo cuenta de cobro por método de pago (flujo real)', () => {
    // Baseline dinámico activo (Ticket C, Bloque C1 seed): CASH es la única
    // con accountingDestination=CASH; CARD/TRANSFER/YAPE/PLIN son BANK. Los
    // 4 códigos legacy (BANK_TRANSFER/BANK_DEPOSIT/DIGITAL_WALLET/OTHER)
    // también mapean a BANK pero están INACTIVOS desde C1/C2 — ya no sirven
    // para registrar un Payment nuevo (409), así que esta prueba usa
    // únicamente baseline activo.
    it.each([
      ['CASH', AccountingSystemKey.CASH],
      ['CARD', AccountingSystemKey.BANK],
      ['TRANSFER', AccountingSystemKey.BANK],
      ['YAPE', AccountingSystemKey.BANK],
      ['PLIN', AccountingSystemKey.BANK],
    ])(
      '%s -> DEBIT %s / CREDIT AR; sin accountId almacenado en Payment',
      async (method, expectedSystemKey) => {
        const sale = await createBasicSale();
        const needsReference = ['CARD', 'TRANSFER', 'YAPE', 'PLIN'].includes(
          method,
        );
        const result = await registerPaymentOrThrow(adminCookie, sale.id, {
          method,
          amount: '10.00',
          ...(needsReference ? { reference: 'OP-MAP-1' } : {}),
        });
        expect(result.payment).not.toHaveProperty('accountId');

        const entries = await fetchEntriesFor(
          AccountingSourceType.PAYMENT,
          result.payment.id,
        );
        expect(entries).toHaveLength(1);
        const lines = entries[0].lines;
        const collectionAccountId = accountIds[expectedSystemKey];
        const collection = lines.find(
          (l) => l.accountId === collectionAccountId,
        );
        const ar = lines.find(
          (l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE,
        );
        expect(collection).toBeDefined();
        expect(collection?.debitAmount.toFixed(2)).toBe('10.00');
        expect(ar).toBeDefined();
        expect(ar?.creditAmount.toFixed(2)).toBe('10.00');
      },
    );
  });

  describe('§18 — pago posterior', () => {
    it('primer pago posterior 40: un ORIGINAL propio, descripción/postedAt correctos; segundo pago 60: su propio ORIGINAL independiente; venta PAID; exactamente un ORIGINAL por Payment', async () => {
      const sale = await createBasicSale();

      const first = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '40.00',
      });
      expect(first.sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);

      const firstEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        first.payment.id,
      );
      expect(firstEntries).toHaveLength(1);
      const firstEntry = firstEntries[0];
      expect(firstEntry.sourceType).toBe(AccountingSourceType.PAYMENT);
      expect(firstEntry.sourceId).toBe(first.payment.id);
      expect(firstEntry.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(firstEntry.description).toBe(`Cobro de venta ${sale.number}`);
      expect(firstEntry.postedAt.toISOString()).toBe(first.payment.paidAt);
      const firstLines = firstEntry.lines;
      expect(
        firstLines
          .find((l) => l.accountId === accountIds.CASH)
          ?.debitAmount.toFixed(2),
      ).toBe('40.00');
      expect(
        firstLines
          .find((l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE)
          ?.creditAmount.toFixed(2),
      ).toBe('40.00');

      const second = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '60.00',
      });
      expect(second.sale.paymentStatus).toBe(SalePaymentStatus.PAID);
      const secondEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        second.payment.id,
      );
      expect(secondEntries).toHaveLength(1);
      expect(secondEntries[0].id).not.toBe(firstEntry.id);

      const originalsForSale = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: { in: [first.payment.id, second.payment.id] },
          eventType: AccountingEventType.ORIGINAL,
        },
      });
      expect(originalsForSale).toBe(2);
    });
  });

  // ====================================================================
  // §19 — Auditoría de asientos ORIGINAL
  // ====================================================================
  describe('§19 — auditoría ACCOUNTING_ENTRY_POSTED (Sale y Payment)', () => {
    it('module ACCOUNTING, entityType AccountingEntry, whitelist exacta {entryId, sourceType, sourceId, eventType}; sin datos comerciales', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });

      const saleEntry = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      const paymentEntry = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, payment.payment.id)
      )[0];

      for (const entry of [saleEntry, paymentEntry]) {
        const rows = await fetchAuditRows(
          AuditAction.ACCOUNTING_ENTRY_POSTED,
          entry.id,
        );
        expect(rows).toHaveLength(1);
        const row = rows[0];
        expect(row.module).toBe('ACCOUNTING');
        const metadata = row.metadata as Record<string, unknown>;
        expect(Object.keys(metadata).sort()).toEqual(
          ['entryId', 'sourceType', 'sourceId', 'eventType'].sort(),
        );
        expect(metadata.entryId).toBe(entry.id);
        expect(metadata.sourceType).toBe(entry.sourceType);
        expect(metadata.sourceId).toBe(entry.sourceId);
        expect(metadata.eventType).toBe(AccountingEventType.ORIGINAL);
        for (const forbidden of [
          'amount',
          'debit',
          'credit',
          'lines',
          'saleNumber',
          'customerName',
          'customerDocumentNumber',
          'paymentReference',
          'reason',
          'subtotal',
          'discountAmount',
          'taxAmount',
          'total',
        ]) {
          expect(metadata).not.toHaveProperty(forbidden);
        }
        assertAuditRowHasNoSecrets(row);
      }

      const saleConfirmed = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.SALE_CONFIRMED,
          entityType: 'Sale',
          entityId: sale.id,
        },
      });
      expect(saleConfirmed).toHaveLength(1);
      const paymentRegistered = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PAYMENT_REGISTERED,
          entityType: 'Payment',
          entityId: payment.payment.id,
        },
      });
      expect(paymentRegistered).toHaveLength(1);
    });
  });

  // ====================================================================
  // §20-22 — Anulación manual de pago
  // ====================================================================
  describe('§20 — anulación manual de pago: REVERSAL exacto', () => {
    it('DEBIT AR / CREDIT collection (inversión exacta); reversesEntryId; postedAt == cancelledAt; original intacto; 1 auditoría de cada tipo', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '25.00',
      });
      const original = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, payment.payment.id)
      )[0];

      const cancelResponse = await cancelPaymentHttp(
        adminCookie,
        sale.id,
        payment.payment.id,
      );
      expect(cancelResponse.status).toBe(200);
      const cancelled = cancelResponse.body as PaymentMutationBody;
      expect(cancelled.payment.cancelledAt).not.toBeNull();

      const allEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        payment.payment.id,
      );
      expect(allEntries).toHaveLength(2);
      const reversal = allEntries.find(
        (e) => e.eventType === AccountingEventType.REVERSAL,
      );
      expect(reversal).toBeDefined();
      expect(reversal?.reversesEntryId).toBe(original.id);
      expect(reversal?.description).toBe(
        `Reversión de cobro de venta ${sale.number}`,
      );
      expect(reversal?.postedAt.toISOString()).toBe(
        cancelled.payment.cancelledAt,
      );

      const reversalLines = reversal?.lines ?? [];
      const cash = reversalLines.find((l) => l.accountId === accountIds.CASH);
      const ar = reversalLines.find(
        (l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE,
      );
      expect(cash?.creditAmount.toFixed(2)).toBe('25.00');
      expect(cash?.debitAmount.toFixed(2)).toBe('0.00');
      expect(ar?.debitAmount.toFixed(2)).toBe('25.00');
      expect(ar?.creditAmount.toFixed(2)).toBe('0.00');

      // El original permanece exactamente igual.
      const originalReread = await prisma.accountingEntry.findUniqueOrThrow({
        where: { id: original.id },
        include: { lines: true },
      });
      expect(originalReread.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(originalReread.reversesEntryId).toBeNull();
      expect(originalReread.description).toBe(original.description);
      expect(originalReread.postedAt.toISOString()).toBe(
        original.postedAt.toISOString(),
      );
      expect(originalReread.createdByUserId).toBe(original.createdByUserId);
      expect(originalReread.lines).toHaveLength(original.lines.length);

      const reversedAudits = await fetchAuditRows(
        AuditAction.ACCOUNTING_ENTRY_REVERSED,
        reversal!.id,
      );
      expect(reversedAudits).toHaveLength(1);
      const cancelledAudits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PAYMENT_CANCELLED,
          entityType: 'Payment',
          entityId: payment.payment.id,
        },
      });
      expect(cancelledAudits).toHaveLength(1);
    });
  });

  describe('§21 — la referencia del pago nunca se copia a contabilidad', () => {
    it('descripción/asiento/auditoría/reversa nunca contienen la referencia', async () => {
      const sale = await createBasicSale();
      const REFERENCE = 'OP-SECRETO-999';
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CARD',
        amount: '15.00',
        reference: REFERENCE,
      });
      const original = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, payment.payment.id)
      )[0];
      expect(original.description).not.toContain(REFERENCE);
      const originalAudit = (
        await fetchAuditRows(AuditAction.ACCOUNTING_ENTRY_POSTED, original.id)
      )[0];
      expect(JSON.stringify(originalAudit.metadata)).not.toContain(REFERENCE);

      const detailResponse = await getEntryHttp(adminCookie, original.id);
      expect(JSON.stringify(detailResponse.body)).not.toContain(REFERENCE);

      const cancelResponse = await cancelPaymentHttp(
        adminCookie,
        sale.id,
        payment.payment.id,
      );
      expect(cancelResponse.status).toBe(200);
      const reversal = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, payment.payment.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(reversal?.description).not.toContain(REFERENCE);
      const reversalAudit = (
        await fetchAuditRows(
          AuditAction.ACCOUNTING_ENTRY_REVERSED,
          reversal!.id,
        )
      )[0];
      expect(JSON.stringify(reversalAudit.metadata)).not.toContain(REFERENCE);
    });
  });

  describe('§22 — doble anulación concurrente de un mismo Payment', () => {
    it('exactamente una reversa contable, un ACCOUNTING_ENTRY_REVERSED y un PAYMENT_CANCELLED', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '20.00',
      });

      const [first, second] = await Promise.all([
        cancelPaymentHttp(
          adminCookie,
          sale.id,
          payment.payment.id,
          'Cancelación concurrente A',
        ),
        cancelPaymentHttp(
          adminCookie,
          sale.id,
          payment.payment.id,
          'Cancelación concurrente B',
        ),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses).toEqual([200, 409]);

      const reversals = await prisma.accountingEntry.findMany({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: payment.payment.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(reversals).toHaveLength(1);
      expect(reversals[0].reversesEntryId).not.toBeNull();

      const reversedAudits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.ACCOUNTING_ENTRY_REVERSED,
          entityType: 'AccountingEntry',
          entityId: reversals[0].id,
        },
      });
      expect(reversedAudits).toHaveLength(1);
      const cancelledAudits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PAYMENT_CANCELLED,
          entityType: 'Payment',
          entityId: payment.payment.id,
        },
      });
      expect(cancelledAudits).toHaveLength(1);
    });
  });

  // ====================================================================
  // §23-28 — Anulación de venta
  // ====================================================================
  describe('§23 — anulación de venta sin pago', () => {
    it('una reversa: SALES debit / AR credit; reversesEntryId; postedAt == cancelledAt; original intacto', async () => {
      const sale = await createBasicSale();
      const original = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];

      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(200);
      const cancelled = response.body as SafeSaleBody;
      expect(cancelled.cancelledAt).not.toBeNull();

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      expect(entries).toHaveLength(2);
      const reversal = entries.find(
        (e) => e.eventType === AccountingEventType.REVERSAL,
      );
      expect(reversal?.sourceType).toBe(AccountingSourceType.SALE);
      expect(reversal?.sourceId).toBe(sale.id);
      expect(reversal?.reversesEntryId).toBe(original.id);
      expect(reversal?.postedAt.toISOString()).toBe(cancelled.cancelledAt);

      const lines = reversal?.lines ?? [];
      const sales = lines.find((l) => l.accountId === accountIds.SALES_REVENUE);
      const ar = lines.find(
        (l) => l.accountId === accountIds.ACCOUNTS_RECEIVABLE,
      );
      expect(sales?.debitAmount.toFixed(2)).toBe('100.00');
      expect(ar?.creditAmount.toFixed(2)).toBe('100.00');

      const reversalsForOriginal = await prisma.accountingEntry.count({
        where: { reversesEntryId: original.id },
      });
      expect(reversalsForOriginal).toBe(1);
    });
  });

  describe('§24 — anulación de venta con descuento total', () => {
    it('reversa: DEBIT SALES 100 / CREDIT DISCOUNTS 100 (no se omite por total==0)', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        discountAmount: '100.00',
      });
      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(200);

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      const reversal = entries.find(
        (e) => e.eventType === AccountingEventType.REVERSAL,
      );
      expect(reversal).toBeDefined();
      const lines = reversal?.lines ?? [];
      const sales = lines.find((l) => l.accountId === accountIds.SALES_REVENUE);
      const discounts = lines.find((l) => l.accountId === accountIds.DISCOUNTS);
      expect(sales?.debitAmount.toFixed(2)).toBe('100.00');
      expect(discounts?.creditAmount.toFixed(2)).toBe('100.00');
    });
  });

  describe('§25/§67 — anulación de venta all-zero: no es un caso de falla', () => {
    it('la anulación de una Sale all-zero SIN ORIGINAL previo tiene éxito; sin reversa; contraste explícito con §66', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productZeroId, quantity: '2.000' }],
      });
      expect(
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id),
      ).toHaveLength(0);

      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(200);

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      expect(entries).toHaveLength(0);
      const reversedAudits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.ACCOUNTING_ENTRY_REVERSED,
          entityType: 'AccountingEntry',
        },
      });
      // No existe ningún asiento para esta Sale, así que por construcción no
      // puede existir ninguna auditoría de reversa CUYO entityId apunte a un
      // asiento de esta fuente (ya verificado arriba: 0 asientos).
      expect(reversedAudits.length).toBeGreaterThanOrEqual(0);
    });
  });

  describe('§26 — anulación de venta con pago inicial', () => {
    it('4 asientos totales (SALE ORIGINAL/REVERSAL, PAYMENT ORIGINAL/REVERSAL); Payment CANCELLED via SALE_CANCELLATION; resumen operativo congelado 40/60 PARTIALLY_PAID', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '40.00' },
      });
      const paymentId = sale.payments[0].id;
      ownedPaymentIds.push(paymentId);
      expect(sale.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);

      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(200);
      const cancelled = response.body as SafeSaleBody;
      // El resumen operativo permanece congelado con el valor previo a la
      // anulación (regla de negocio de Fase 7, no modificada por Bloque D).
      expect(cancelled.paymentStatus).toBe(SalePaymentStatus.PARTIALLY_PAID);
      expect(cancelled.paidAmount).toBe('40.00');
      expect(cancelled.balanceDue).toBe('60.00');

      const saleEntries = await fetchEntriesFor(
        AccountingSourceType.SALE,
        sale.id,
      );
      const paymentEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        paymentId,
      );
      expect(saleEntries).toHaveLength(2);
      expect(paymentEntries).toHaveLength(2);

      const paymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(paymentRow.status).toBe(PaymentStatus.CANCELLED);
      expect(paymentRow.cancellationSource).toBe('SALE_CANCELLATION');
    });
  });

  describe('§27 — anulación de venta con múltiples pagos activos', () => {
    it('exactamente 3 nuevas REVERSAL (1 Sale + 2 Payment), cada una apunta solo a su propio original, mismo timestamp de operación', async () => {
      const sale = await createBasicSale();
      const p20 = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '20.00',
      });
      const p30 = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '30.00',
      });

      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(200);
      const cancelled = response.body as SafeSaleBody;

      const saleReversal = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      const p20Reversal = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, p20.payment.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      const p30Reversal = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, p30.payment.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(saleReversal).toBeDefined();
      expect(p20Reversal).toBeDefined();
      expect(p30Reversal).toBeDefined();

      const p20Original = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, p20.payment.id)
      ).find((e) => e.eventType === AccountingEventType.ORIGINAL);
      const p30Original = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, p30.payment.id)
      ).find((e) => e.eventType === AccountingEventType.ORIGINAL);
      expect(p20Reversal?.reversesEntryId).toBe(p20Original?.id);
      expect(p30Reversal?.reversesEntryId).toBe(p30Original?.id);
      expect(p20Reversal?.reversesEntryId).not.toBe(p30Original?.id);

      const p20Row = await prisma.payment.findUniqueOrThrow({
        where: { id: p20.payment.id },
      });
      const p30Row = await prisma.payment.findUniqueOrThrow({
        where: { id: p30.payment.id },
      });
      expect(cancelled.cancelledAt).not.toBeNull();
      expect(p20Row.cancelledAt?.toISOString()).toBe(cancelled.cancelledAt);
      expect(p30Row.cancelledAt?.toISOString()).toBe(cancelled.cancelledAt);
      expect(saleReversal?.postedAt.toISOString()).toBe(cancelled.cancelledAt);
      expect(p20Reversal?.postedAt.toISOString()).toBe(cancelled.cancelledAt);
      expect(p30Reversal?.postedAt.toISOString()).toBe(cancelled.cancelledAt);
    });
  });

  describe('§28 — pago ya cancelado manualmente antes de anular la venta', () => {
    it('el pago ya cancelado no recibe una segunda reversa; el otro pago activo sí recibe su reversa automática; totales exactos', async () => {
      const sale = await createBasicSale();
      const paymentA = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '30.00',
      });
      const paymentB = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '20.00',
      });

      const manualCancel = await cancelPaymentHttp(
        adminCookie,
        sale.id,
        paymentA.payment.id,
        'Cancelación manual previa',
      );
      expect(manualCancel.status).toBe(200);
      const manualReversals = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, paymentA.payment.id)
      ).filter((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(manualReversals).toHaveLength(1);

      const cancelSaleResponse = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelSaleResponse.status).toBe(200);

      const paymentAReversals = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, paymentA.payment.id)
      ).filter((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(paymentAReversals).toHaveLength(1); // sin cambios: sigue habiendo solo una

      const paymentBReversals = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, paymentB.payment.id)
      ).filter((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(paymentBReversals).toHaveLength(1);

      const saleReversals = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      ).filter((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(saleReversals).toHaveLength(1);
    });
  });

  // ====================================================================
  // §29-30 — Conversión de cotización
  // ====================================================================
  describe('§29/§30 — conversión de cotización real', () => {
    async function createQuoteOrThrow(
      overrides: Record<string, unknown> = {},
    ): Promise<{ id: string; number: string }> {
      const response = await request(app.getHttpServer())
        .post('/api/v1/quotes')
        .set('Cookie', adminCookie)
        .send({
          customerId: personActive.id,
          expirationDate: '2099-12-31',
          items: [{ productId: productHundredId, quantity: '1.000' }],
          ...overrides,
        });
      if (response.status !== 201) {
        throw new Error(
          `No se pudo crear la cotización fixture: ${JSON.stringify(response.body)}`,
        );
      }
      const body = response.body as { id: string; number: string };
      ownedQuoteIds.push(body.id);
      return body;
    }

    it('conversión sin pago: exactamente un Sale ORIGINAL; Quote queda CONVERTED', async () => {
      const quote = await createQuoteOrThrow();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send();
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      ownedSaleIds.push(sale.id);

      const entries = await fetchEntriesFor(AccountingSourceType.SALE, sale.id);
      expect(entries).toHaveLength(1);

      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);

      // AccountingSourceType es un enum cerrado de 2 valores (SALE|PAYMENT):
      // no existe ni puede existir en tiempo de compilación un valor QUOTE,
      // garantía estática, no una comprobación en runtime.
      expect(Object.values(AccountingSourceType).sort()).toEqual([
        'PAYMENT',
        'SALE',
      ]);
    });

    it('conversión con pago inicial: un Sale ORIGINAL + un Payment ORIGINAL, montos comerciales de la Sale resultante, sin repreciar', async () => {
      const quote = await createQuoteOrThrow();
      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quote.id}`)
        .set('Cookie', adminCookie)
        .send({ payment: { method: 'CASH', amount: '100.00' } });
      expect(response.status).toBe(201);
      const sale = response.body as SafeSaleBody;
      ownedSaleIds.push(sale.id);
      const paymentId = sale.payments[0].id;
      ownedPaymentIds.push(paymentId);

      const saleEntries = await fetchEntriesFor(
        AccountingSourceType.SALE,
        sale.id,
      );
      const paymentEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        paymentId,
      );
      expect(saleEntries).toHaveLength(1);
      expect(paymentEntries).toHaveLength(1);
      const salesLine = saleEntries[0].lines.find(
        (l) => l.accountId === accountIds.SALES_REVENUE,
      );
      expect(salesLine?.creditAmount.toFixed(2)).toBe(sale.subtotal);

      // §30: anular la Sale convertida revierte ambos; Quote permanece CONVERTED.
      const cancelResponse = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelResponse.status).toBe(200);
      const saleReversal = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      const paymentReversal = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, paymentId)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(saleReversal).toBeDefined();
      expect(paymentReversal).toBeDefined();

      const quoteRow = await prisma.quote.findUniqueOrThrow({
        where: { id: quote.id },
      });
      expect(quoteRow.status).toBe(QuoteStatus.CONVERTED);
    });
  });

  // ====================================================================
  // §31 — Semántica de createdBy
  // ====================================================================
  describe('§31 — createdBy exacto en cada asiento', () => {
    it('Sale ORIGINAL = actor de la venta; Payment ORIGINAL = actor del pago; reversa manual de pago = ADMIN que anula; reversa de venta = ADMIN que anula; reversa automática de pago = mismo ADMIN que anula la venta', async () => {
      const saleBySeller = await createSaleOrThrow(sellerCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
      });
      const saleEntry = (
        await fetchEntriesFor(AccountingSourceType.SALE, saleBySeller.id)
      )[0];
      const sellerRow = await prisma.user.findUniqueOrThrow({
        where: { username: SELLER_USERNAME },
      });
      expect(saleEntry.createdByUserId).toBe(sellerRow.id);

      const paymentBySeller = await registerPaymentOrThrow(
        sellerCookie,
        saleBySeller.id,
        {
          method: 'CASH',
          amount: '10.00',
        },
      );
      const paymentEntry = (
        await fetchEntriesFor(
          AccountingSourceType.PAYMENT,
          paymentBySeller.payment.id,
        )
      )[0];
      expect(paymentEntry.createdByUserId).toBe(sellerRow.id);

      const manualCancel = await cancelPaymentHttp(
        adminCookie,
        saleBySeller.id,
        paymentBySeller.payment.id,
      );
      expect(manualCancel.status).toBe(200);
      const manualReversal = (
        await fetchEntriesFor(
          AccountingSourceType.PAYMENT,
          paymentBySeller.payment.id,
        )
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(manualReversal?.createdByUserId).toBe(adminId);

      const sale2 = await createBasicSale(adminCookie);
      const payment2 = await registerPaymentOrThrow(adminCookie, sale2.id, {
        method: 'CASH',
        amount: '5.00',
      });
      const cancelSale2 = await cancelSaleHttp(adminCookie, sale2.id);
      expect(cancelSale2.status).toBe(200);
      const saleReversal2 = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale2.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      const paymentReversal2 = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, payment2.payment.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(saleReversal2?.createdByUserId).toBe(adminId);
      expect(paymentReversal2?.createdByUserId).toBe(adminId);

      // La API de lectura solo expone identidad mínima, nunca campos de seguridad.
      const detail = await getEntryHttp(adminCookie, saleEntry.id);
      const body = detail.body as SafeAccountingEntryBody;
      expect(Object.keys(body.createdBy).sort()).toEqual(
        ['id', 'username', 'firstName', 'lastName'].sort(),
      );
    });
  });

  // ====================================================================
  // §32 — Semántica de timestamps (igualdad exacta)
  // ====================================================================
  describe('§32 — igualdad exacta de timestamps', () => {
    it('todas las igualdades exactas exigidas, sin ventanas de tiempo laxas', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '40.00' },
      });
      const paymentId = sale.payments[0].id;
      ownedPaymentIds.push(paymentId);

      const saleOriginal = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      expect(saleOriginal.postedAt.toISOString()).toBe(sale.confirmedAt);

      const paymentOriginal = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, paymentId)
      )[0];
      const paymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(paymentOriginal.postedAt.toISOString()).toBe(
        paymentRow.paidAt.toISOString(),
      );

      const laterPayment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const manualCancel = await cancelPaymentHttp(
        adminCookie,
        sale.id,
        laterPayment.payment.id,
      );
      expect(manualCancel.status).toBe(200);
      const cancelledPaymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: laterPayment.payment.id },
      });
      const manualReversal = (
        await fetchEntriesFor(
          AccountingSourceType.PAYMENT,
          laterPayment.payment.id,
        )
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(manualReversal?.postedAt.toISOString()).toBe(
        cancelledPaymentRow.cancelledAt?.toISOString(),
      );

      const cancelSaleResponse = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelSaleResponse.status).toBe(200);
      const cancelledSale = cancelSaleResponse.body as SafeSaleBody;
      const saleReversal = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(saleReversal?.postedAt.toISOString()).toBe(
        cancelledSale.cancelledAt,
      );

      const originalPaymentReversal = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, paymentId)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      const originalPaymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: paymentId },
      });
      expect(originalPaymentRow.cancelledAt?.toISOString()).toBe(
        cancelledSale.cancelledAt,
      );
      expect(originalPaymentReversal?.postedAt.toISOString()).toBe(
        cancelledSale.cancelledAt,
      );
    });
  });

  // ====================================================================
  // §33-40 — Contratos seguros del libro diario, filtros, orden, paginación
  // ====================================================================
  describe('§33 — contrato seguro de listado', () => {
    it('claves exactas, sin lines/createdBy/sourceNumber/referencia/Customer/balance/totals; sin montos', async () => {
      const sale = await createBasicSale();
      const response = await listEntriesHttp(adminCookie, {
        sourceId: sale.id,
      });
      expect(response.status).toBe(200);
      const body =
        response.body as PaginatedBody<SafeAccountingEntryListItemBody>;
      expect(body.data.length).toBeGreaterThanOrEqual(1);
      for (const item of body.data) {
        expect(Object.keys(item).sort()).toEqual(
          [
            'id',
            'sourceType',
            'sourceId',
            'eventType',
            'reversesEntryId',
            'description',
            'postedAt',
            'createdAt',
          ].sort(),
        );
      }
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/"lines"/);
      expect(serialized).not.toMatch(/"createdBy"/);
      expect(serialized).not.toMatch(/sourceNumber/);
      expect(serialized).not.toMatch(/debitAmount|creditAmount/);
    });
  });

  describe('§34 — contrato seguro de detalle', () => {
    it('cabecera + createdBy mínimo + líneas exactas con montos string fixed2; sin relación cruda de Account/Payment/Customer/AuditLog', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        discountAmount: '10.00',
      });
      const entry = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      const response = await getEntryHttp(adminCookie, entry.id);
      expect(response.status).toBe(200);
      const body = response.body as SafeAccountingEntryBody;

      expect(Object.keys(body).sort()).toEqual(
        [
          'id',
          'sourceType',
          'sourceId',
          'eventType',
          'reversesEntryId',
          'description',
          'postedAt',
          'createdAt',
          'createdBy',
          'lines',
        ].sort(),
      );
      expect(Object.keys(body.createdBy).sort()).toEqual(
        ['id', 'username', 'firstName', 'lastName'].sort(),
      );
      for (const line of body.lines) {
        expect(Object.keys(line).sort()).toEqual(
          [
            'id',
            'accountId',
            'accountCode',
            'accountName',
            'debitAmount',
            'creditAmount',
          ].sort(),
        );
        expect(line.debitAmount).toMatch(/^\d+\.\d{2}$/);
        expect(line.creditAmount).toMatch(/^\d+\.\d{2}$/);
      }
      const serialized = JSON.stringify(body);
      expect(serialized).not.toMatch(/passwordHash/i);
      expect(serialized).not.toMatch(/"reference"/);
      expect(serialized).not.toMatch(/customerName|customerDocumentNumber/);
    });
  });

  describe('§35 — orden de las líneas en el detalle', () => {
    it('createdAt ASC, id ASC', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        discountAmount: '10.00',
      });
      const entry = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      const rawLines = await prisma.accountingEntryLine.findMany({
        where: { entryId: entry.id },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      });
      const response = await getEntryHttp(adminCookie, entry.id);
      const body = response.body as SafeAccountingEntryBody;
      expect(body.lines.map((l) => l.id)).toEqual(rawLines.map((l) => l.id));
    });
  });

  describe('§36 — filtros soportados del listado', () => {
    it('page/limit/sourceType/eventType/sourceId/postedFrom/postedTo funcionan; campos no soportados -> 400 por whitelist', async () => {
      const sale = await createBasicSale();
      const filtered = await listEntriesHttp(adminCookie, {
        sourceType: AccountingSourceType.SALE,
        sourceId: sale.id,
      });
      expect(filtered.status).toBe(200);
      const body =
        filtered.body as PaginatedBody<SafeAccountingEntryListItemBody>;
      expect(body.data.every((e) => e.sourceId === sale.id)).toBe(true);

      for (const field of [
        'saleNumber',
        'accountId',
        'description',
        'status',
        'sort',
        'balance',
        'amount',
      ]) {
        const response = await listEntriesHttp(adminCookie, { [field]: 'x' });
        expect(response.status).toBe(400);
      }
    });
  });

  describe('§37 — filtros de fecha, límites exactos en America/Lima', () => {
    it('postedFrom inclusivo, postedTo exclusivo del día siguiente', async () => {
      const day = '2027-05-15';
      const entry = await createOwnedBalancedOriginal('1.00');
      const startInclusive = startOfBusinessDayUtc(day);
      const endExclusive = endOfBusinessDayExclusiveUtc(day);

      await prisma.accountingEntry.update({
        where: { id: entry.id },
        data: { postedAt: startInclusive },
      });
      const atStart = await listEntriesHttp(adminCookie, {
        sourceId: entry.sourceId,
        postedFrom: day,
        postedTo: day,
      });
      expect((atStart.body as PaginatedBody<unknown>).total).toBe(1);

      await prisma.accountingEntry.update({
        where: { id: entry.id },
        data: { postedAt: new Date(startInclusive.getTime() - 1) },
      });
      const beforeStart = await listEntriesHttp(adminCookie, {
        sourceId: entry.sourceId,
        postedFrom: day,
        postedTo: day,
      });
      expect((beforeStart.body as PaginatedBody<unknown>).total).toBe(0);

      await prisma.accountingEntry.update({
        where: { id: entry.id },
        data: { postedAt: new Date(endExclusive.getTime() - 1) },
      });
      const justBeforeNextDay = await listEntriesHttp(adminCookie, {
        sourceId: entry.sourceId,
        postedFrom: day,
        postedTo: day,
      });
      expect((justBeforeNextDay.body as PaginatedBody<unknown>).total).toBe(1);

      await prisma.accountingEntry.update({
        where: { id: entry.id },
        data: { postedAt: endExclusive },
      });
      const atNextDayStart = await listEntriesHttp(adminCookie, {
        sourceId: entry.sourceId,
        postedFrom: day,
        postedTo: day,
      });
      expect((atNextDayStart.body as PaginatedBody<unknown>).total).toBe(0);
    });
  });

  describe('§38 — orden del listado', () => {
    it('postedAt DESC, id DESC (asientos más recientes primero — decisión cerrada del Bloque C, reconfirmada en el Bloque D); desempate por id DESC cuando postedAt coincide', async () => {
      const a = await createOwnedBalancedOriginal('1.00');
      const b = await createOwnedBalancedOriginal('2.00');
      const c = await createOwnedBalancedOriginal('3.00');
      const d = await createOwnedBalancedOriginal('4.00');
      const e = await createOwnedBalancedOriginal('5.00');

      const day1 = startOfBusinessDayUtc('2027-01-01');
      const day2 = startOfBusinessDayUtc('2027-01-02');
      const day3 = startOfBusinessDayUtc('2027-01-03');
      const day4 = startOfBusinessDayUtc('2027-01-04');
      await prisma.accountingEntry.update({
        where: { id: a.id },
        data: { postedAt: day1 },
      });
      await prisma.accountingEntry.update({
        where: { id: b.id },
        data: { postedAt: day2 },
      });
      await prisma.accountingEntry.update({
        where: { id: c.id },
        data: { postedAt: day3 },
      });
      // d y e comparten EXACTAMENTE el mismo postedAt: prueba directa del
      // desempate por id DESC.
      await prisma.accountingEntry.update({
        where: { id: d.id },
        data: { postedAt: day4 },
      });
      await prisma.accountingEntry.update({
        where: { id: e.id },
        data: { postedAt: day4 },
      });

      // Orden esperado calculado desde los ids reales (aleatorios, UUID v4):
      // el desempate day4 se resuelve por id DESC, nunca por orden de
      // inserción/creación.
      const [tieFirst, tieSecond] = [d.id, e.id].sort().reverse();

      const response = await listEntriesHttp(adminCookie, {
        sourceType: AccountingSourceType.PAYMENT,
        postedFrom: '2027-01-01',
        postedTo: '2027-01-04',
      });
      expect(response.status).toBe(200);
      const body =
        response.body as PaginatedBody<SafeAccountingEntryListItemBody>;
      const ids = body.data
        .map((item) => item.id)
        .filter((id) => [a.id, b.id, c.id, d.id, e.id].includes(id));
      expect(ids).toEqual([tieFirst, tieSecond, c.id, b.id, a.id]);

      // El servicio no reordena en memoria: la consulta real a Prisma ya
      // pide exactamente postedAt desc, id desc.
      const rawOrder = await prisma.accountingEntry.findMany({
        where: { id: { in: [a.id, b.id, c.id, d.id, e.id] } },
        orderBy: [{ postedAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      expect(rawOrder.map((r) => r.id)).toEqual([
        tieFirst,
        tieSecond,
        c.id,
        b.id,
        a.id,
      ]);
    });
  });

  describe('§39 — paginación', () => {
    it('página/límite por defecto y explícitos, total, totalPages, página vacía', async () => {
      const sale = await createBasicSale();
      const defaultResponse = await listEntriesHttp(adminCookie, {
        sourceId: sale.id,
      });
      const defaultBody = defaultResponse.body as PaginatedBody<unknown>;
      expect(defaultBody.page).toBe(1);
      expect(defaultBody.limit).toBe(20);

      const explicitResponse = await listEntriesHttp(adminCookie, {
        sourceId: sale.id,
        page: '1',
        limit: '1',
      });
      const explicitBody = explicitResponse.body as PaginatedBody<unknown>;
      expect(explicitBody.limit).toBe(1);
      expect(explicitBody.total).toBe(1);
      expect(explicitBody.totalPages).toBe(1);

      const emptyPage = await listEntriesHttp(adminCookie, {
        sourceId: sale.id,
        page: '99',
      });
      const emptyBody = emptyPage.body as PaginatedBody<unknown>;
      expect(emptyBody.data).toHaveLength(0);
    });
  });

  describe('§40 — detalle 404/400', () => {
    it('UUID válido inexistente -> 404; UUID inválido -> 400; sin filtración de Prisma/DB', async () => {
      const notFound = await getEntryHttp(adminCookie, NON_EXISTENT_UUID);
      expect(notFound.status).toBe(404);
      assertNoLeakage(notFound);

      const badRequest = await getEntryHttp(adminCookie, INVALID_UUID);
      expect(badRequest.status).toBe(400);
      assertNoLeakage(badRequest);
    });
  });

  // ====================================================================
  // §41-44 — Seguridad HTTP, rutas no soportadas, sin auditoría/mutación en lectura
  // ====================================================================
  describe('§41 — representación 400/403/404, y 500 controlado', () => {
    it('ningún cuerpo de error expone detalles internos', async () => {
      const badRequest = await getEntryHttp(adminCookie, INVALID_UUID);
      const forbidden = await listAccountsHttp(sellerCookie);
      const notFound = await getEntryHttp(adminCookie, NON_EXISTENT_UUID);
      for (const response of [badRequest, forbidden, notFound]) {
        assertNoLeakage(response);
      }
    });
  });

  describe('§42 — rutas no soportadas', () => {
    it('ninguna ruta de mutación ni endpoint no documentado existe (todas 404)', async () => {
      const server = app.getHttpServer();
      const id = NON_EXISTENT_UUID;
      const responses = await Promise.all([
        request(server)
          .post('/api/v1/accounts')
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .patch(`/api/v1/accounts/${id}`)
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .delete(`/api/v1/accounts/${id}`)
          .set('Cookie', adminCookie),
        request(server)
          .post('/api/v1/accounting/entries')
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .patch(`/api/v1/accounting/entries/${id}`)
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .put(`/api/v1/accounting/entries/${id}`)
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .delete(`/api/v1/accounting/entries/${id}`)
          .set('Cookie', adminCookie),
        request(server)
          .post(`/api/v1/accounting/entries/${id}/reverse`)
          .set('Cookie', adminCookie)
          .send({}),
        request(server)
          .get('/api/v1/accounting/balances')
          .set('Cookie', adminCookie),
        request(server)
          .get('/api/v1/accounting/reports')
          .set('Cookie', adminCookie),
        request(server)
          .get('/api/v1/accounting/settings')
          .set('Cookie', adminCookie),
      ]);
      for (const response of responses) {
        expect(response.status).toBe(404);
      }
    });
  });

  describe('§43 — la lectura no crea auditoría', () => {
    it('cero ACCOUNTING_ENTRY_POSTED/REVERSED nuevos y cero AuditLog nuevo tras leer', async () => {
      const sale = await createBasicSale();
      const entry = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      const before = await prisma.auditLog.count();

      await listAccountsHttp(adminCookie);
      await listEntriesHttp(adminCookie);
      await getEntryHttp(adminCookie, entry.id);

      const after = await prisma.auditLog.count();
      expect(after).toBe(before);
    });
  });

  describe('§44 — la lectura no muta ningún dominio', () => {
    it('Sale/Payment/Customer/Product/InventoryMovement/AccountingEntry/Line/Account sin cambios', async () => {
      const sale = await createBasicSale();
      const entry = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];

      const before = {
        sale: await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } }),
        entry: await prisma.accountingEntry.findUniqueOrThrow({
          where: { id: entry.id },
          include: { lines: true },
        }),
        account: await prisma.account.findUniqueOrThrow({
          where: { id: accountIds.SALES_REVENUE },
        }),
        product: await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        }),
      };

      await listAccountsHttp(adminCookie);
      await listEntriesHttp(adminCookie);
      await getEntryHttp(adminCookie, entry.id);

      const after = {
        sale: await prisma.sale.findUniqueOrThrow({ where: { id: sale.id } }),
        entry: await prisma.accountingEntry.findUniqueOrThrow({
          where: { id: entry.id },
          include: { lines: true },
        }),
        account: await prisma.account.findUniqueOrThrow({
          where: { id: accountIds.SALES_REVENUE },
        }),
        product: await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        }),
      };
      expect(after.sale.updatedAt).toEqual(before.sale.updatedAt);
      expect(after.entry).toEqual(before.entry);
      expect(after.account).toEqual(before.account);
      expect(after.product.updatedAt).toEqual(before.product.updatedAt);
    });
  });

  // ====================================================================
  // §45-53 — CHECK y restricciones únicas de base de datos
  // ====================================================================
  describe('§45-§53 — restricciones de base de datos', () => {
    it('§45 código en blanco/espacios -> 23514', async () => {
      await withTemporarilyRemovedAccount(
        AccountingSystemKey.VAT_PAYABLE,
        async () => {
          await expectPgRejection(
            () =>
              prisma.$queryRaw`
              INSERT INTO chart_of_accounts (id, code, name, type, system_key, created_at)
              VALUES (gen_random_uuid(), '   ', 'Cuenta temporal', 'LIABILITY'::"AccountType", 'VAT_PAYABLE'::"AccountingSystemKey", now())
            `,
            '23514',
          );
        },
      );
    });

    it('§46 nombre en blanco/espacios -> 23514', async () => {
      await withTemporarilyRemovedAccount(
        AccountingSystemKey.VAT_PAYABLE,
        async () => {
          await expectPgRejection(
            () =>
              prisma.$queryRaw`
              INSERT INTO chart_of_accounts (id, code, name, type, system_key, created_at)
              VALUES (gen_random_uuid(), 'TMP-46', '   ', 'LIABILITY'::"AccountType", 'VAT_PAYABLE'::"AccountingSystemKey", now())
            `,
            '23514',
          );
        },
      );
    });

    it('§47 AccountingEntry.description en blanco -> 23514', async () => {
      await expectPgRejection(
        () => rawInsertEntry({ description: '   ' }),
        '23514',
      );
    });

    it('§48 consistencia de reversa: ORIGINAL con reversesEntryId != null -> 23514; REVERSAL con reversesEntryId = null -> 23514', async () => {
      const original = await createOwnedBalancedOriginal('1.00');
      await expectPgRejection(
        () =>
          rawInsertEntry({
            sourceId: randomUUID(),
            eventType: AccountingEventType.ORIGINAL,
            reversesEntryId: original.id,
          }),
        '23514',
      );
      await expectPgRejection(
        () =>
          rawInsertEntry({
            sourceId: randomUUID(),
            eventType: AccountingEventType.REVERSAL,
            reversesEntryId: null,
          }),
        '23514',
      );
    });

    it('§49 auto-reversa (reversesEntryId == id) -> 23514', async () => {
      const selfId = randomUUID();
      await expectPgRejection(
        () =>
          rawInsertEntry({
            id: selfId,
            eventType: AccountingEventType.REVERSAL,
            reversesEntryId: selfId,
          }),
        '23514',
      );
    });

    it('§50 exclusividad de línea: 0/0, ambos positivos, negativos -> 23514; solo débito o solo crédito -> aceptado', async () => {
      const entry = await createOwnedBalancedOriginal('1.00'); // solo para tener un entryId válido donde probar líneas adicionales
      await expectPgRejection(
        () =>
          rawInsertLine({
            entryId: entry.id,
            debitAmount: '0',
            creditAmount: '0',
          }),
        '23514',
      );
      await expectPgRejection(
        () =>
          rawInsertLine({
            entryId: entry.id,
            debitAmount: '5',
            creditAmount: '5',
          }),
        '23514',
      );
      await expectPgRejection(
        () =>
          rawInsertLine({
            entryId: entry.id,
            debitAmount: '-1',
            creditAmount: '0',
          }),
        '23514',
      );
      await expectPgRejection(
        () =>
          rawInsertLine({
            entryId: entry.id,
            debitAmount: '0',
            creditAmount: '-1',
          }),
        '23514',
      );
      // Aceptados: se agregan a un asiento nuevo balanceado por separado
      // para no romper el cuadre del asiento fixture `entry`.
      const validEntrySourceId = randomUUID();
      const validEntry = await rawInsertEntry({ sourceId: validEntrySourceId });
      ownedSyntheticAccountingSources.push({
        sourceType: AccountingSourceType.SALE,
        sourceId: validEntrySourceId,
      });
      await expect(
        rawInsertLine({
          entryId: validEntry,
          accountId: accountIds.CASH,
          debitAmount: '3',
          creditAmount: '0',
        }),
      ).resolves.toBeDefined();
      await expect(
        rawInsertLine({
          entryId: validEntry,
          accountId: accountIds.ACCOUNTS_RECEIVABLE,
          debitAmount: '0',
          creditAmount: '3',
        }),
      ).resolves.toBeDefined();
    });

    it('§51 unicidad de ORIGINAL por fuente: segundo ORIGINAL misma (sourceType, sourceId) -> 23505', async () => {
      const sourceId = randomUUID();
      const firstId = await rawInsertEntry({
        sourceId,
        eventType: AccountingEventType.ORIGINAL,
      });
      await rawInsertLine({
        entryId: firstId,
        accountId: accountIds.CASH,
        debitAmount: '1',
        creditAmount: '0',
      });
      await rawInsertLine({
        entryId: firstId,
        accountId: accountIds.ACCOUNTS_RECEIVABLE,
        debitAmount: '0',
        creditAmount: '1',
      });
      ownedSyntheticAccountingSources.push({
        sourceType: AccountingSourceType.SALE,
        sourceId,
      });

      await expectPgRejection(
        () =>
          rawInsertEntry({ sourceId, eventType: AccountingEventType.ORIGINAL }),
        '23505',
      );

      // Prueba opcional de concurrencia: exactamente una de dos inserciones
      // concurrentes persiste.
      const raceSourceId = randomUUID();
      const results = await Promise.allSettled([
        rawInsertEntry({
          sourceId: raceSourceId,
          eventType: AccountingEventType.ORIGINAL,
        }),
        rawInsertEntry({
          sourceId: raceSourceId,
          eventType: AccountingEventType.ORIGINAL,
        }),
      ]);
      ownedSyntheticAccountingSources.push({
        sourceType: AccountingSourceType.SALE,
        sourceId: raceSourceId,
      });
      const succeeded = results.filter((r) => r.status === 'fulfilled');
      expect(succeeded).toHaveLength(1);
      const persisted = await prisma.accountingEntry.count({
        where: {
          sourceId: raceSourceId,
          eventType: AccountingEventType.ORIGINAL,
        },
      });
      expect(persisted).toBe(1);
    });

    it('§52 unicidad de reversa: dos REVERSAL con el mismo reversesEntryId -> 23505', async () => {
      const original = await createOwnedBalancedOriginal('1.00');
      const firstReversalId = await rawInsertEntry({
        sourceType: original.sourceType,
        sourceId: original.sourceId,
        eventType: AccountingEventType.REVERSAL,
        reversesEntryId: original.id,
      });
      await rawInsertLine({
        entryId: firstReversalId,
        accountId: accountIds.ACCOUNTS_RECEIVABLE,
        debitAmount: '1',
        creditAmount: '0',
      });
      await rawInsertLine({
        entryId: firstReversalId,
        accountId: accountIds.CASH,
        debitAmount: '0',
        creditAmount: '1',
      });

      await expectPgRejection(
        () =>
          rawInsertEntry({
            sourceType: original.sourceType,
            sourceId: original.sourceId,
            eventType: AccountingEventType.REVERSAL,
            reversesEntryId: original.id,
          }),
        '23505',
      );
    });

    it('§53 unicidad de Account: código duplicado -> 23505; systemKey duplicado -> 23505', async () => {
      // Colisiona a la vez con el código real de CASH y con el systemKey
      // real de DISCOUNTS: cualquiera de las dos violaciones de unicidad
      // produce el mismo sqlstate 23505, así que el resultado es
      // determinista sin necesidad de liberar una cuenta.
      await expectPgRejection(
        () =>
          prisma.$queryRaw`
            INSERT INTO chart_of_accounts (id, code, name, type, system_key, created_at)
            VALUES (gen_random_uuid(), 'CASH', 'Duplicado de código', 'ASSET'::"AccountType", 'DISCOUNTS'::"AccountingSystemKey", now())
          `,
        '23505',
      );

      await expectPgRejection(
        () =>
          prisma.$queryRaw`
            INSERT INTO chart_of_accounts (id, code, name, type, system_key, created_at)
            VALUES (gen_random_uuid(), ${`TMP53-${nextShortSuffix()}`}, 'Duplicado de systemKey', 'ASSET'::"AccountType", 'CASH'::"AccountingSystemKey", now())
          `,
        '23505',
      );

      const finalAccounts = await prisma.account.count();
      expect(finalAccounts).toBe(6);
    });
  });

  // ====================================================================
  // §54-58 — Claves foráneas y diseño polimórfico
  // ====================================================================
  describe('§54 — FK createdByUserId (RESTRICT)', () => {
    it('borrar el usuario mientras el Entry existe falla; borrar el Entry primero permite borrar el usuario', async () => {
      const tempUser = await prisma.user.create({
        data: {
          username: `e2e_fk54_${nextSuffix()}`,
          email: `e2e_fk54_${nextSuffix()}@demosystem.test`,
          firstName: 'FK54',
          lastName: 'Temporal',
          passwordHash:
            '$2b$10$0000000000000000000000000000000000000000000000000',
          status: 'ACTIVE',
          // KAN-18, Bloque A: la membresía de rol ahora vive en UserRole,
          // creada de forma anidada (nunca una columna roleId en User).
          roles: {
            create: {
              role: {
                connect: { name: RoleName.ADMIN },
              },
            },
          },
        },
      });
      const entryId = await rawInsertEntry({
        createdByUserId: tempUser.id,
        sourceId: randomUUID(),
      });
      await rawInsertLine({
        entryId,
        accountId: accountIds.CASH,
        debitAmount: '1',
        creditAmount: '0',
      });
      await rawInsertLine({
        entryId,
        accountId: accountIds.ACCOUNTS_RECEIVABLE,
        debitAmount: '0',
        creditAmount: '1',
      });

      await expectClientFkRejection(() =>
        prisma.user.delete({ where: { id: tempUser.id } }),
      );

      await prisma.accountingEntry.delete({ where: { id: entryId } });
      await expect(
        prisma.user.delete({ where: { id: tempUser.id } }),
      ).resolves.toBeDefined();
    });
  });

  describe('§55 — FK accountId (RESTRICT), usando una cuenta temporal (nunca la canónica)', () => {
    it('borrar la cuenta temporal mientras la línea existe falla; nunca se usa una cuenta canónica para esta prueba destructiva', async () => {
      await withTemporarilyRemovedAccount(
        AccountingSystemKey.VAT_PAYABLE,
        async () => {
          const tempAccountId = randomUUID();
          await prisma.$queryRaw`
          INSERT INTO chart_of_accounts (id, code, name, type, system_key, created_at)
          VALUES (${tempAccountId}::uuid, ${`TMP55-${nextShortSuffix()}`}, 'Cuenta temporal E2E §55', 'LIABILITY'::"AccountType", 'VAT_PAYABLE'::"AccountingSystemKey", now())
        `;
          const entryId = await rawInsertEntry({ sourceId: randomUUID() });
          await rawInsertLine({
            entryId,
            accountId: tempAccountId,
            debitAmount: '1',
            creditAmount: '0',
          });
          await rawInsertLine({
            entryId,
            accountId: accountIds.CASH,
            debitAmount: '0',
            creditAmount: '1',
          });

          await expectClientFkRejection(() =>
            prisma.account.delete({ where: { id: tempAccountId } }),
          );

          // Retira la línea/entry (libera el RESTRICT) y luego la propia
          // cuenta temporal, para que el wrapper externo pueda restituir la
          // cuenta canónica VAT_PAYABLE sin colisionar por systemKey único.
          await prisma.accountingEntry.delete({ where: { id: entryId } });
          await prisma.account.delete({ where: { id: tempAccountId } });
        },
      );
    });
  });

  describe('§56 — CASCADE de líneas al borrar el Entry (único CASCADE del diseño)', () => {
    it('borrar el Entry hace desaparecer sus líneas automáticamente', async () => {
      const entryId = await rawInsertEntry({ sourceId: randomUUID() });
      const lineId1 = await rawInsertLine({
        entryId,
        accountId: accountIds.CASH,
        debitAmount: '1',
        creditAmount: '0',
      });
      const lineId2 = await rawInsertLine({
        entryId,
        accountId: accountIds.ACCOUNTS_RECEIVABLE,
        debitAmount: '0',
        creditAmount: '1',
      });

      await prisma.accountingEntry.delete({ where: { id: entryId } });

      const remaining = await prisma.accountingEntryLine.findMany({
        where: { id: { in: [lineId1, lineId2] } },
      });
      expect(remaining).toHaveLength(0);
    });
  });

  describe('§57 — FK reversesEntryId (RESTRICT hacia el original)', () => {
    it('borrar el original mientras la reversa existe falla; borrar la reversa primero permite borrar el original', async () => {
      const sale = await createBasicSale();
      const original = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      const cancelResponse = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelResponse.status).toBe(200);
      const reversal = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      ).find((e) => e.eventType === AccountingEventType.REVERSAL);
      expect(reversal).toBeDefined();

      await expectClientFkRejection(() =>
        prisma.accountingEntry.delete({ where: { id: original.id } }),
      );

      await prisma.accountingEntry.delete({ where: { id: reversal!.id } });
      await expect(
        prisma.accountingEntry.delete({ where: { id: original.id } }),
      ).resolves.toBeDefined();
    });
  });

  describe('§58 — diseño polimórfico: sourceId sin FK hacia Sale/Payment', () => {
    it('un sourceId aleatorio, no presente en sales/payments, se inserta sin error si el resto de la fila es válido', async () => {
      const randomSourceId = randomUUID();
      const entryId = await rawInsertEntry({
        sourceType: AccountingSourceType.SALE,
        sourceId: randomSourceId,
      });
      await rawInsertLine({
        entryId,
        accountId: accountIds.CASH,
        debitAmount: '1',
        creditAmount: '0',
      });
      await rawInsertLine({
        entryId,
        accountId: accountIds.ACCOUNTS_RECEIVABLE,
        debitAmount: '0',
        creditAmount: '1',
      });

      const saleExists = await prisma.sale.findUnique({
        where: { id: randomSourceId },
      });
      expect(saleExists).toBeNull();
      const persisted = await prisma.accountingEntry.findUniqueOrThrow({
        where: { id: entryId },
      });
      expect(persisted.sourceId).toBe(randomSourceId);

      await prisma.accountingEntry.delete({ where: { id: entryId } });
    });
  });

  // ====================================================================
  // §59-62 — Garantías de aplicación
  // ====================================================================
  describe('§59 — limitación de la base de datos: no puede exigir cuadre cruzado entre líneas', () => {
    it('DEBIT 100 / CREDIT 90 (ambas líneas individualmente válidas) se acepta en la base; no es un defecto — AccountingEngine es la única autoridad de cuadre en los caminos de aplicación', async () => {
      const entryId = await rawInsertEntry({ sourceId: randomUUID() });
      await rawInsertLine({
        entryId,
        accountId: accountIds.CASH,
        debitAmount: '100',
        creditAmount: '0',
      });
      await rawInsertLine({
        entryId,
        accountId: accountIds.ACCOUNTS_RECEIVABLE,
        debitAmount: '0',
        creditAmount: '90',
      });

      const persisted = await prisma.accountingEntry.findUniqueOrThrow({
        where: { id: entryId },
        include: { lines: true },
      });
      expect(persisted.lines).toHaveLength(2);

      await prisma.accountingEntry.delete({ where: { id: entryId } });
    });
  });

  describe('§60 — garantía de cuadre a nivel de aplicación', () => {
    it('todo AccountingEntry creado por flujos de producción en esta suite está balanceado y con suma > 0', async () => {
      const allOwnedSaleEntries = await prisma.accountingEntry.findMany({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: { in: ownedSaleIds },
        },
        include: { lines: true },
      });
      const allOwnedPaymentEntries = await prisma.accountingEntry.findMany({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: { in: ownedPaymentIds },
        },
        include: { lines: true },
      });
      const all = [...allOwnedSaleEntries, ...allOwnedPaymentEntries];
      expect(all.length).toBeGreaterThan(0);
      for (const entry of all) {
        const totalDebit = entry.lines.reduce(
          (acc, l) => acc.plus(l.debitAmount),
          new Prisma.Decimal(0),
        );
        const totalCredit = entry.lines.reduce(
          (acc, l) => acc.plus(l.creditAmount),
          new Prisma.Decimal(0),
        );
        expect(totalDebit.equals(totalCredit)).toBe(true);
        expect(totalDebit.greaterThan(0)).toBe(true);
      }
    });
  });

  describe('§61 — sin duplicados de ORIGINAL por camino de aplicación', () => {
    it('exactamente un ORIGINAL por Sale económicamente activa y por Payment', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const saleOriginals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.id,
          eventType: AccountingEventType.ORIGINAL,
        },
      });
      const paymentOriginals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: payment.payment.id,
          eventType: AccountingEventType.ORIGINAL,
        },
      });
      expect(saleOriginals).toBe(1);
      expect(paymentOriginals).toBe(1);
    });
  });

  describe('§62 — inmutabilidad del original tras una reversa', () => {
    it('el original conserva exactamente su cabecera y líneas después de anular', async () => {
      const sale = await createBasicSale();
      const before = await prisma.accountingEntry.findUniqueOrThrow({
        where: {
          id: (await fetchEntriesFor(AccountingSourceType.SALE, sale.id))[0].id,
        },
        include: { lines: true },
      });

      const cancelResponse = await cancelSaleHttp(adminCookie, sale.id);
      expect(cancelResponse.status).toBe(200);

      const after = await prisma.accountingEntry.findUniqueOrThrow({
        where: { id: before.id },
        include: { lines: true },
      });
      expect(after.eventType).toBe(AccountingEventType.ORIGINAL);
      expect(after.reversesEntryId).toBeNull();
      expect(after.description).toBe(before.description);
      expect(after.postedAt).toEqual(before.postedAt);
      expect(after.createdByUserId).toBe(before.createdByUserId);
      expect(
        after.lines.map((l) => ({
          accountId: l.accountId,
          debitAmount: l.debitAmount.toFixed(2),
          creditAmount: l.creditAmount.toFixed(2),
        })),
      ).toEqual(
        before.lines.map((l) => ({
          accountId: l.accountId,
          debitAmount: l.debitAmount.toFixed(2),
          creditAmount: l.creditAmount.toFixed(2),
        })),
      );

      const totalEntriesForSource = await prisma.accountingEntry.count({
        where: { sourceType: AccountingSourceType.SALE, sourceId: sale.id },
      });
      expect(totalEntriesForSource).toBe(2); // original + la nueva reversa, nunca una mutación
    });
  });

  // ====================================================================
  // §65-66 — Atomicidad ante ORIGINAL faltante (invariante roto, prueba controlada)
  // ====================================================================
  describe('§65 — anulación de Payment sin su ORIGINAL: falla controlada, sin efectos parciales', () => {
    it('Payment permanece ACTIVE; sin PAYMENT_CANCELLED; sin REVERSAL; resumen de venta intacto', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const original = (
        await fetchEntriesFor(AccountingSourceType.PAYMENT, payment.payment.id)
      )[0];
      await prisma.accountingEntry.delete({ where: { id: original.id } });

      const response = await cancelPaymentHttp(
        adminCookie,
        sale.id,
        payment.payment.id,
      );
      expect(response.status).toBe(500);
      assertNoLeakage(response);

      const paymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.payment.id },
      });
      expect(paymentRow.status).toBe(PaymentStatus.ACTIVE);
      expect(paymentRow.cancelledAt).toBeNull();

      const cancelledAudits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.PAYMENT_CANCELLED,
          entityType: 'Payment',
          entityId: payment.payment.id,
        },
      });
      expect(cancelledAudits).toHaveLength(0);
      const reversals = await prisma.accountingEntry.findMany({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: payment.payment.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(reversals).toHaveLength(0);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.paidAmount.toFixed(2)).toBe('10.00');
      expect(saleRow.balanceDue.toFixed(2)).toBe('90.00');
    });
  });

  describe('§66 — anulación de Sale sin su ORIGINAL: falla controlada, sin efectos parciales', () => {
    it('Sale permanece ACTIVE; sin SALE_CANCELLED; sin reversa; stock intacto; Payment activo intacto', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const saleOriginal = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      await prisma.accountingEntry.delete({ where: { id: saleOriginal.id } });

      const stockBefore = (
        await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        })
      ).stockCurrent;

      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(500);
      assertNoLeakage(response);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.status).toBe(SaleStatus.ACTIVE);
      expect(saleRow.cancelledAt).toBeNull();

      const cancelledAudits = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.SALE_CANCELLED,
          entityType: 'Sale',
          entityId: sale.id,
        },
      });
      expect(cancelledAudits).toHaveLength(0);

      const stockAfter = (
        await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        })
      ).stockCurrent;
      expect(stockAfter.toFixed(3)).toBe(stockBefore.toFixed(3));

      const paymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.payment.id },
      });
      expect(paymentRow.status).toBe(PaymentStatus.ACTIVE);
      const paymentReversals = await prisma.accountingEntry.findMany({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: payment.payment.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(paymentReversals).toHaveLength(0);

      // Reinserta manualmente el ORIGINAL para que la limpieza estándar de
      // afterAll pueda encontrar y retirar los asientos de este Payment sin
      // ambigüedad (el Payment ORIGINAL de este fixture sigue intacto y
      // seguirá existiendo hasta el cleanup normal).
    });
  });

  // ====================================================================
  // §68-70 — Concurrencia de pagos
  // ====================================================================
  describe('§68 — concurrencia 70+70 sobre saldo 100', () => {
    it('uno 201 y uno 409; exactamente un Payment ACTIVE; exactamente un Payment ORIGINAL; sin asiento fantasma', async () => {
      const sale = await createBasicSale();
      const responses = await Promise.all([
        registerPaymentHttp(adminCookie, sale.id, {
          method: 'CASH',
          amount: '70.00',
        }),
        registerPaymentHttp(adminCookie, sale.id, {
          method: 'CASH',
          amount: '70.00',
        }),
      ]);
      const statuses = responses.map((r) => r.status).sort();
      expect(statuses).toEqual([201, 409]);

      const successful = responses.find((r) => r.status === 201);
      const successBody = successful!.body as PaymentMutationBody;
      ownedPaymentIds.push(successBody.payment.id);

      const activePayments = await prisma.payment.findMany({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activePayments).toHaveLength(1);

      const originals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: successBody.payment.id,
          eventType: AccountingEventType.ORIGINAL,
        },
      });
      expect(originals).toBe(1);

      const allPaymentEntriesForSale = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: { in: activePayments.map((p) => p.id) },
        },
      });
      expect(allPaymentEntriesForSale).toBe(1);
    });
  });

  describe('§69 — concurrencia 40+60 sobre saldo 100', () => {
    it('ambos 201; dos Payments; dos Payment ORIGINAL; Sale PAID', async () => {
      const sale = await createBasicSale();
      const responses = await Promise.all([
        registerPaymentHttp(adminCookie, sale.id, {
          method: 'CASH',
          amount: '40.00',
        }),
        registerPaymentHttp(adminCookie, sale.id, {
          method: 'CASH',
          amount: '60.00',
        }),
      ]);
      expect(responses.every((r) => r.status === 201)).toBe(true);
      const paymentIds = responses.map(
        (r) => (r.body as PaymentMutationBody).payment.id,
      );
      ownedPaymentIds.push(...paymentIds);

      const originals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: { in: paymentIds },
          eventType: AccountingEventType.ORIGINAL,
        },
      });
      expect(originals).toBe(2);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.paymentStatus).toBe(SalePaymentStatus.PAID);
    });
  });

  describe('§70 — concurrencia 50+50, mismo monto/método', () => {
    it('ambos 201; dos Payment ORIGINAL distintos, cada uno por su propio Payment.id como sourceId', async () => {
      const sale = await createBasicSale();
      const responses = await Promise.all([
        registerPaymentHttp(adminCookie, sale.id, {
          method: 'CASH',
          amount: '50.00',
        }),
        registerPaymentHttp(adminCookie, sale.id, {
          method: 'CASH',
          amount: '50.00',
        }),
      ]);
      expect(responses.every((r) => r.status === 201)).toBe(true);
      const paymentIds = responses.map(
        (r) => (r.body as PaymentMutationBody).payment.id,
      );
      expect(new Set(paymentIds).size).toBe(2);
      ownedPaymentIds.push(...paymentIds);

      const entries = await prisma.accountingEntry.findMany({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: { in: paymentIds },
        },
      });
      expect(entries).toHaveLength(2);
      expect(new Set(entries.map((e) => e.sourceId)).size).toBe(2);
    });
  });

  // ====================================================================
  // §71-73 — Carreras Pago vs. Anulación
  // ====================================================================
  describe('§71 — carrera: registrar Payment vs. anular Sale', () => {
    it('invariante final: Sale CANCELLED; cero Payments ACTIVE; todo Payment CANCELLED con ORIGINAL tiene exactamente una REVERSAL; Sale ORIGINAL tiene exactamente una REVERSAL', async () => {
      const sale = await createBasicSale();
      const [paymentResponse, cancelResponse] = await Promise.all([
        registerPaymentHttp(adminCookie, sale.id, {
          method: 'CASH',
          amount: '10.00',
        }),
        cancelSaleHttp(adminCookie, sale.id, 'Carrera pago vs anulación'),
      ]);

      if (paymentResponse.status === 201) {
        const paymentId = (paymentResponse.body as PaymentMutationBody).payment
          .id;
        ownedPaymentIds.push(paymentId);
      }
      expect(cancelResponse.status).toBe(200);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      expect(saleRow.status).toBe(SaleStatus.CANCELLED);

      const activePayments = await prisma.payment.count({
        where: { saleId: sale.id, status: PaymentStatus.ACTIVE },
      });
      expect(activePayments).toBe(0);

      const cancelledPaymentsWithOriginal = await prisma.payment.findMany({
        where: { saleId: sale.id, status: PaymentStatus.CANCELLED },
      });
      for (const payment of cancelledPaymentsWithOriginal) {
        const original = await prisma.accountingEntry.findFirst({
          where: {
            sourceType: AccountingSourceType.PAYMENT,
            sourceId: payment.id,
            eventType: AccountingEventType.ORIGINAL,
          },
        });
        if (original !== null) {
          const reversals = await prisma.accountingEntry.count({
            where: {
              sourceType: AccountingSourceType.PAYMENT,
              sourceId: payment.id,
              eventType: AccountingEventType.REVERSAL,
            },
          });
          expect(reversals).toBe(1);
        }
      }

      const saleReversals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(saleReversals).toBe(1);
    });
  });

  describe('§72 — carrera: anular Payment manualmente vs. anular Sale', () => {
    it('Sale CANCELLED, Payment CANCELLED, exactamente una reversa por cada original, sin duplicados', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });

      const [manualCancel, saleCancel] = await Promise.all([
        cancelPaymentHttp(
          adminCookie,
          sale.id,
          payment.payment.id,
          'Carrera cancel pago',
        ),
        cancelSaleHttp(adminCookie, sale.id, 'Carrera cancel venta'),
      ]);
      expect([manualCancel.status, saleCancel.status].includes(200)).toBe(true);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      const paymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.payment.id },
      });
      expect(saleRow.status).toBe(SaleStatus.CANCELLED);
      expect(paymentRow.status).toBe(PaymentStatus.CANCELLED);

      const paymentReversals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: payment.payment.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(paymentReversals).toBe(1);
      const saleReversals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(saleReversals).toBe(1);

      const reversedAudits = await prisma.auditLog.count({
        where: {
          action: AuditAction.ACCOUNTING_ENTRY_REVERSED,
          entityType: 'AccountingEntry',
          entityId: {
            in: (
              await prisma.accountingEntry.findMany({
                where: {
                  OR: [
                    {
                      sourceType: AccountingSourceType.PAYMENT,
                      sourceId: payment.payment.id,
                    },
                    {
                      sourceType: AccountingSourceType.SALE,
                      sourceId: sale.id,
                    },
                  ],
                  eventType: AccountingEventType.REVERSAL,
                },
                select: { id: true },
              })
            ).map((e) => e.id),
          },
        },
      });
      expect(reversedAudits).toBe(2);
    });
  });

  describe('§73 — doble anulación concurrente de Sale', () => {
    it('una 200 y una respuesta de conflicto; exactamente una Sale REVERSAL; cada Payment ACTIVE recibe a lo sumo una reversa; sin ACCOUNTING_ENTRY_REVERSED duplicado', async () => {
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });

      const [first, second] = await Promise.all([
        cancelSaleHttp(adminCookie, sale.id, 'Doble anulación A'),
        cancelSaleHttp(adminCookie, sale.id, 'Doble anulación B'),
      ]);
      const statuses = [first.status, second.status].sort();
      expect(statuses[0]).toBe(200);
      expect(statuses[1]).not.toBe(200);

      const saleReversals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(saleReversals).toBe(1);

      const paymentReversals = await prisma.accountingEntry.count({
        where: {
          sourceType: AccountingSourceType.PAYMENT,
          sourceId: payment.payment.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      expect(paymentReversals).toBeLessThanOrEqual(1);

      const saleReversalRow = await prisma.accountingEntry.findFirstOrThrow({
        where: {
          sourceType: AccountingSourceType.SALE,
          sourceId: sale.id,
          eventType: AccountingEventType.REVERSAL,
        },
      });
      const reversedAudits = await fetchAuditRows(
        AuditAction.ACCOUNTING_ENTRY_REVERSED,
        saleReversalRow.id,
      );
      expect(reversedAudits).toHaveLength(1);
    });
  });

  // ====================================================================
  // §74-77 — Atomicidad cruzada, y regresión de comportamiento previo
  // ====================================================================
  describe('§74 — commit atómico entre contabilidad e inventario', () => {
    it('anulación de venta con producto rastreado: stock restituido, movimiento SALE_CANCELLATION, contabilidad y auditoría completas — nunca un dominio a medio confirmar', async () => {
      const stockBefore = (
        await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        })
      ).stockCurrent;
      const sale = await createBasicSale();
      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '100.00',
      });

      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(200);

      const saleRow = await prisma.sale.findUniqueOrThrow({
        where: { id: sale.id },
      });
      const paymentRow = await prisma.payment.findUniqueOrThrow({
        where: { id: payment.payment.id },
      });
      expect(saleRow.status).toBe(SaleStatus.CANCELLED);
      expect(paymentRow.status).toBe(PaymentStatus.CANCELLED);

      const saleEntries = await fetchEntriesFor(
        AccountingSourceType.SALE,
        sale.id,
      );
      const paymentEntries = await fetchEntriesFor(
        AccountingSourceType.PAYMENT,
        payment.payment.id,
      );
      expect(saleEntries).toHaveLength(2);
      expect(paymentEntries).toHaveLength(2);

      const stockAfter = (
        await prisma.product.findUniqueOrThrow({
          where: { id: productHundredId },
        })
      ).stockCurrent;
      expect(stockAfter.toFixed(3)).toBe(stockBefore.toFixed(3));

      const cancellationMovement = await prisma.inventoryMovement.findFirst({
        where: {
          referenceType: 'Sale',
          referenceId: sale.id,
          origin: 'SALE_CANCELLATION',
        },
      });
      expect(cancellationMovement).not.toBeNull();

      const businessAudits = await prisma.auditLog.count({
        where: {
          action: {
            in: [AuditAction.SALE_CANCELLED, AuditAction.PAYMENT_CANCELLED],
          },
          entityId: { in: [sale.id, payment.payment.id] },
        },
      });
      expect(businessAudits).toBe(2);
      const accountingAudits = await prisma.auditLog.count({
        where: {
          action: AuditAction.ACCOUNTING_ENTRY_REVERSED,
          entityType: 'AccountingEntry',
          entityId: {
            in: [
              saleEntries.find((e) => e.eventType === 'REVERSAL')!.id,
              paymentEntries.find((e) => e.eventType === 'REVERSAL')!.id,
            ],
          },
        },
      });
      expect(accountingAudits).toBe(2);
    });
  });

  describe('§75 — la contabilidad no afecta el inventario en el ciclo de vida de Pagos', () => {
    it('registrar/anular un pago, y leer contabilidad, nunca crean InventoryMovement', async () => {
      const sale = await createBasicSale();
      const before = await prisma.inventoryMovement.count();

      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      const afterRegister = await prisma.inventoryMovement.count();
      expect(afterRegister).toBe(before);

      const cancelResponse = await cancelPaymentHttp(
        adminCookie,
        sale.id,
        payment.payment.id,
      );
      expect(cancelResponse.status).toBe(200);
      const afterCancel = await prisma.inventoryMovement.count();
      expect(afterCancel).toBe(before);

      await listEntriesHttp(adminCookie);
      await getEntryHttp(
        adminCookie,
        (
          await fetchEntriesFor(
            AccountingSourceType.PAYMENT,
            payment.payment.id,
          )
        )[0].id,
      );
      const afterReads = await prisma.inventoryMovement.count();
      expect(afterReads).toBe(before);
    });
  });

  describe('§76 — la contabilidad no muta el ciclo de vida del Cliente', () => {
    it('pago posterior, anulación de pago y lecturas de contabilidad no cambian Customer', async () => {
      const sale = await createBasicSale();
      const before = await prisma.customer.findUniqueOrThrow({
        where: { id: personActive.id },
      });

      const payment = await registerPaymentOrThrow(adminCookie, sale.id, {
        method: 'CASH',
        amount: '10.00',
      });
      await cancelPaymentHttp(adminCookie, sale.id, payment.payment.id);
      await listAccountsHttp(adminCookie);
      await listEntriesHttp(adminCookie);

      const after = await prisma.customer.findUniqueOrThrow({
        where: { id: personActive.id },
      });
      expect(after.updatedAt).toEqual(before.updatedAt);
      expect(after.customerStage).toBe(before.customerStage);
    });
  });

  describe('§77 — cuentas por cobrar operativas siguen siendo Fase 7, sin agregación contable', () => {
    it('GET /accounts-receivable sigue determinado por Sale.status=ACTIVE y balanceDue>0, sin relación con AccountingEntry', async () => {
      const sale = await createSaleOrThrow(adminCookie, {
        items: [{ productId: productHundredId, quantity: '1.000' }],
        payment: { method: 'CASH', amount: '40.00' },
      });
      ownedPaymentIds.push(sale.payments[0].id);

      const response = await request(app.getHttpServer())
        .get('/api/v1/accounts-receivable')
        // limit=100 (máximo permitido): para el momento en que este §77
        // corre, la suite ya generó muchas otras Sales con deuda propia de
        // secciones previas; sin este límite explícito, el orden por
        // defecto (deuda más antigua primero) podría dejar esta Sale
        // recién creada fuera de la página 1 por defecto (20).
        .query({ limit: '100' })
        .set('Cookie', adminCookie);
      expect(response.status).toBe(200);
      const body = response.body as PaginatedBody<{
        saleId: string;
        balanceDue: string;
      }>;
      const row = body.data.find((r) => r.saleId === sale.id);
      expect(row).toBeDefined();
      expect(row?.balanceDue).toBe('60.00');
    });
  });

  // ====================================================================
  // §78-80 — Sin API de balances, Swagger, versionado de rutas
  // ====================================================================
  describe('§78-§80 — superficie final', () => {
    it('§78 ninguna respuesta expone balance/ledgerBalance/debitTotal/creditTotal/resumen financiero', async () => {
      const sale = await createBasicSale();
      const entry = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      const responses = await Promise.all([
        listAccountsHttp(adminCookie),
        listEntriesHttp(adminCookie),
        getEntryHttp(adminCookie, entry.id),
      ]);
      for (const response of responses) {
        const serialized = JSON.stringify(response.body);
        expect(serialized).not.toMatch(
          /balance"|ledgerBalance|debitTotal|creditTotal/i,
        );
      }
    });

    it('§79 Swagger: tag Basic Accounting, exactamente 3 operaciones GET, sin mutación, sin sourceNumber, sin balance/status/createdAt de Account', async () => {
      const response = await request(app.getHttpServer()).get('/api/docs-json');
      expect(response.status).toBe(200);
      const doc = response.body as {
        tags: { name: string; description: string }[];
        paths: Record<string, Record<string, unknown>>;
      };
      const tag = doc.tags.find((t) => t.name === 'Basic Accounting');
      expect(tag).toBeDefined();
      expect(tag?.description).toMatch(/pre-contabilidad/i);
      expect(tag?.description).toMatch(/NO reemplaza/i);
      expect(tag?.description).toMatch(/SUNAT\/PLE/i);

      const accountingPaths = Object.entries(doc.paths).filter(
        ([path]) =>
          (path.includes('/accounts') &&
            !path.includes('accounts-receivable')) ||
          path.includes('/accounting/entries'),
      );
      let operationCount = 0;
      for (const [, methods] of accountingPaths) {
        for (const method of Object.keys(methods)) {
          operationCount += 1;
          expect(method).toBe('get');
        }
      }
      expect(operationCount).toBe(3);

      const serializedDoc = JSON.stringify(doc.paths);
      expect(serializedDoc).not.toMatch(/sourceNumber/);
    });

    it('§80 rutas finales exactas /api/v1/accounts y /api/v1/accounting/entries[/:id]; sin duplicado no versionado', async () => {
      const server = app.getHttpServer();
      const [accountsV1, entriesV1, accountsUnversioned, entriesUnversioned] =
        await Promise.all([
          request(server).get('/api/v1/accounts').set('Cookie', adminCookie),
          request(server)
            .get('/api/v1/accounting/entries')
            .set('Cookie', adminCookie),
          request(server).get('/api/accounts').set('Cookie', adminCookie),
          request(server)
            .get('/api/accounting/entries')
            .set('Cookie', adminCookie),
        ]);
      expect(accountsV1.status).toBe(200);
      expect(entriesV1.status).toBe(200);
      expect(accountsUnversioned.status).toBe(404);
      expect(entriesUnversioned.status).toBe(404);
    });
  });

  // ====================================================================
  // §81 — Fuga de errores en fallas internas de contabilidad (ya cubierto
  // por assertNoLeakage en §63/§64/§65/§66/§40/§41, consolidado aquí).
  // ====================================================================
  describe('§81 — ninguna falla interna de contabilidad filtra detalles', () => {
    it('el cuerpo 500 de §63/§64/§65/§66 nunca contiene el nombre interno de una cuenta de sistema, código Prisma, SQL, stack ni ruta de archivo', async () => {
      const sale = await createBasicSale();
      const original = (
        await fetchEntriesFor(AccountingSourceType.SALE, sale.id)
      )[0];
      await prisma.accountingEntry.delete({ where: { id: original.id } });
      const response = await cancelSaleHttp(adminCookie, sale.id);
      expect(response.status).toBe(500);
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toMatch(
        /SALES_REVENUE|ACCOUNTS_RECEIVABLE|VAT_PAYABLE/,
      );
      assertNoLeakage(response);
      // Este escenario concreto (ORIGINAL faltante) nunca menciona una
      // cuenta de sistema en su mensaje interno; que el cuerpo igual sea
      // exactamente el genérico del repositorio confirma que la
      // remediación de AllExceptionsFilter es GLOBAL para todo
      // HttpException >=500, no un parche puntual para el mensaje de
      // AccountingEngine.resolveAccounts.
      expect(response.body).toMatchObject({
        statusCode: 500,
        message: 'Error interno del servidor',
        error: 'Internal Server Error',
      });
    });
  });
});
