import { INestApplication } from '@nestjs/common';
import { DocumentType, PrismaClient, RoleName } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * R2-B1 — snapshot `prices_include_tax` (preparación de esquema únicamente).
 * Verifica contra PostgreSQL real que la migración dejó las tres columnas
 * obligatorias y SIN default (todo escritor debe fijar la semántica), que
 * las CHECK aritméticas existentes siguen vigentes, y que los escritores
 * reales de este bloque persisten la semántica histórica (false) sin
 * alterar ningún monto. La copia Sale -> ElectronicDocument se verifica en
 * electronic-invoicing-api.e2e-spec.ts (emisión real bajo MockProvider).
 */
describe('R2-B1 — prices_include_tax (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  const SELLER_USERNAME = 'e2e_seller_r2b1';
  const SELLER_PASSWORD = 'SellerR2B1Snapshot123';

  let adminCookie: string;
  let sellerCookie: string;
  let categoryId: string;
  let unitId: string;

  const ownedCustomerIds: string[] = [];
  const ownedProductIds: string[] = [];
  const ownedSaleIds: string[] = [];
  const ownedQuoteIds: string[] = [];

  const RUN_ID = Date.now();
  let counter = 0;
  function nextSuffix(): string {
    counter += 1;
    return `${RUN_ID}${counter}`;
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_r2b1@demosystem.test',
      password: SELLER_PASSWORD,
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

    // Secuencias NV/COT: mismo criterio que el resto de suites que crean
    // Sales/Quotes reales (upsert defensivo aquí, retiro en afterAll).
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

    const category = await prisma.category.findFirstOrThrow({
      where: { code: 'SERVICIOS' },
    });
    categoryId = category.id;
    const unit = await prisma.unit.findFirstOrThrow({ where: { code: 'SER' } });
    unitId = unit.id;
  }, 120000);

  afterAll(async () => {
    try {
      if (ownedSaleIds.length > 0) {
        await prisma.accountingEntry.deleteMany({
          where: {
            sourceType: 'SALE',
            sourceId: { in: ownedSaleIds },
            eventType: 'REVERSAL',
          },
        });
        await prisma.accountingEntry.deleteMany({
          where: { sourceType: 'SALE', sourceId: { in: ownedSaleIds } },
        });
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Sale', entityId: { in: ownedSaleIds } },
        });
        await prisma.inventoryMovement.deleteMany({
          where: { referenceType: 'Sale', referenceId: { in: ownedSaleIds } },
        });
        await prisma.sale.deleteMany({ where: { id: { in: ownedSaleIds } } });
      }
      if (ownedQuoteIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Quote', entityId: { in: ownedQuoteIds } },
        });
        await prisma.quote.deleteMany({ where: { id: { in: ownedQuoteIds } } });
      }
      await prisma.documentSequence.deleteMany({
        where: {
          documentType: { in: [DocumentType.SALE, DocumentType.QUOTE] },
        },
      });
      if (ownedProductIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Product', entityId: { in: ownedProductIds } },
        });
        await prisma.product.deleteMany({
          where: { id: { in: ownedProductIds } },
        });
      }
      if (ownedCustomerIds.length > 0) {
        await prisma.auditLog.deleteMany({
          where: { entityType: 'Customer', entityId: { in: ownedCustomerIds } },
        });
        await prisma.customer.deleteMany({
          where: { id: { in: ownedCustomerIds } },
        });
      }
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  });

  async function createServiceProduct(salePrice: string): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/products')
      .set('Cookie', adminCookie)
      .send({
        sku: `R2B1-${nextSuffix()}`,
        name: 'Servicio fixture R2-B1',
        productType: 'SERVICE',
        categoryId,
        unitId,
        salePrice,
        isInventoryTracked: false,
      });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    ownedProductIds.push(id);
    return id;
  }

  async function createCustomer(): Promise<string> {
    const response = await request(app.getHttpServer())
      .post('/api/v1/customers')
      .set('Cookie', sellerCookie)
      .send({
        customerType: 'PERSON',
        customerStage: 'CUSTOMER',
        name: `Cliente R2-B1 ${nextSuffix()}`,
      });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    ownedCustomerIds.push(id);
    return id;
  }

  async function createQuote(): Promise<string> {
    const customerId = await createCustomer();
    const productId = await createServiceProduct('118.00');
    const response = await request(app.getHttpServer())
      .post('/api/v1/quotes')
      .set('Cookie', sellerCookie)
      .send({ customerId, items: [{ productId, quantity: '1' }] });
    expect(response.status).toBe(201);
    const id = (response.body as { id: string }).id;
    ownedQuoteIds.push(id);
    return id;
  }

  describe('estructura de la migración', () => {
    it.each(['quotes', 'sales', 'electronic_documents'])(
      '%s.prices_include_tax: boolean, NOT NULL y sin DEFAULT SQL',
      async (table) => {
        const rows = await prisma.$queryRaw<
          {
            data_type: string;
            is_nullable: string;
            column_default: string | null;
          }[]
        >`
          SELECT data_type, is_nullable, column_default
          FROM information_schema.columns
          WHERE table_schema = 'public'
            AND table_name = ${table}
            AND column_name = 'prices_include_tax'
        `;
        expect(rows).toEqual([
          { data_type: 'boolean', is_nullable: 'NO', column_default: null },
        ]);
      },
    );

    it('las CHECK aritméticas de cotizaciones, ventas y comprobantes siguen vigentes', async () => {
      const rows = await prisma.$queryRaw<{ conname: string }[]>`
        SELECT conname
        FROM pg_constraint
        WHERE contype = 'c'
          AND conname IN (
            'quotes_total_arithmetic',
            'quote_items_line_arithmetic',
            'sales_total_arithmetic',
            'sales_paid_balance_arithmetic',
            'sale_items_line_arithmetic',
            'electronic_documents_taxable_base_arithmetic',
            'electronic_documents_total_arithmetic',
            'electronic_document_items_line_arithmetic'
          )
      `;
      expect(rows).toHaveLength(8);
    });

    it('ninguna fila de quotes/sales/electronic_documents queda con valor nulo', async () => {
      const rows = await prisma.$queryRaw<{ nulls: bigint }[]>`
        SELECT
          (SELECT COUNT(*) FROM quotes WHERE prices_include_tax IS NULL)
          + (SELECT COUNT(*) FROM sales WHERE prices_include_tax IS NULL)
          + (SELECT COUNT(*) FROM electronic_documents WHERE prices_include_tax IS NULL)
          AS nulls
      `;
      expect(Number(rows[0].nulls)).toBe(0);
    });
  });

  describe('escritores: semántica explícita por documento', () => {
    it('R2-B3: POST /quotes persiste pricesIncludeTax=true', async () => {
      const quoteId = await createQuote();
      const row = await prisma.quote.findUniqueOrThrow({
        where: { id: quoteId },
      });
      expect(row.pricesIncludeTax).toBe(true);
    });

    it('R2-B4: POST /sales (venta directa) persiste pricesIncludeTax=true', async () => {
      const customerId = await createCustomer();
      const productId = await createServiceProduct('118.00');
      const response = await request(app.getHttpServer())
        .post('/api/v1/sales')
        .set('Cookie', sellerCookie)
        .send({ customerId, items: [{ productId, quantity: '1' }] });
      expect(response.status).toBe(201);
      const saleId = (response.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const row = await prisma.sale.findUniqueOrThrow({
        where: { id: saleId },
      });
      expect(row.pricesIncludeTax).toBe(true);
    });

    it('POST /sales/from-quote copia pricesIncludeTax y los montos VERBATIM de la cotización', async () => {
      const quoteId = await createQuote();
      const quote = await prisma.quote.findUniqueOrThrow({
        where: { id: quoteId },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteId}`)
        .set('Cookie', sellerCookie)
        .send({});
      expect(response.status).toBe(201);
      const saleId = (response.body as { id: string }).id;
      ownedSaleIds.push(saleId);

      const sale = await prisma.sale.findUniqueOrThrow({
        where: { id: saleId },
      });
      expect(sale.pricesIncludeTax).toBe(quote.pricesIncludeTax);
      expect(sale.pricesIncludeTax).toBe(true);
      expect(sale.subtotal.equals(quote.subtotal)).toBe(true);
      expect(sale.discountAmount.equals(quote.discountAmount)).toBe(true);
      expect(sale.taxAmount.equals(quote.taxAmount)).toBe(true);
      expect(sale.total.equals(quote.total)).toBe(true);
      expect(sale.taxEnabled).toBe(quote.taxEnabled);
      expect(sale.taxRate.equals(quote.taxRate)).toBe(true);
    });

    it('R2-B3/R2-B4: los detalles de cotización y de venta exponen pricesIncludeTax; el listado de cotizaciones no', async () => {
      const quoteId = await createQuote();
      const detail = await request(app.getHttpServer())
        .get(`/api/v1/quotes/${quoteId}`)
        .set('Cookie', sellerCookie);
      expect(detail.status).toBe(200);
      expect(detail.body).toHaveProperty('pricesIncludeTax', true);

      const list = await request(app.getHttpServer())
        .get('/api/v1/quotes')
        .set('Cookie', sellerCookie);
      expect(list.status).toBe(200);
      for (const item of (list.body as { data: object[] }).data) {
        expect(item).not.toHaveProperty('pricesIncludeTax');
      }

      const conversion = await request(app.getHttpServer())
        .post(`/api/v1/sales/from-quote/${quoteId}`)
        .set('Cookie', sellerCookie)
        .send({});
      expect(conversion.status).toBe(201);
      ownedSaleIds.push((conversion.body as { id: string }).id);
      expect(conversion.body).toHaveProperty('pricesIncludeTax', true);
    });
  });
});
