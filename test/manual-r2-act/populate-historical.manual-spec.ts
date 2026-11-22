import { INestApplication } from '@nestjs/common';
import {
  AccountType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  CustomerType,
  DocumentType,
  InventoryValuationMethod,
  ProductStatus,
  ProductType,
  PurchaseInvoiceDocumentType,
  SupplierDocumentType,
} from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { businessToday } from '../../src/common/date/business-date';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from '../helpers/constants';
import { createE2eApp } from '../helpers/e2e-app';
import { login } from '../helpers/http';
import { createTestPrismaClient } from '../helpers/prisma-test-client';

/**
 * R2-ACT — PROCEDIMIENTO MANUAL (no forma parte de `npm run test:e2e`).
 *
 * Paso 1 de 2: puebla una base PREVIA a R2-ACT (33 migraciones) con datos
 * históricos reales generados por el código ANTERIOR a R2-ACT (productos con
 * decimales y con stock cero, movimientos, ventas —una anulada—, recepciones
 * —una anulada— y capas de valorización). NO limpia nada: la base es
 * descartable y el resultado se migra después con
 * `20261031000000_activate_stock_by_location`.
 * Se ejecuta con `--testRegex '.*\.manual-spec\.ts$'` y el código de `src/`
 * del commit base (sin los cambios de R2-ACT). Ver docs/r2-migration-plan.md.
 *
 * Escribe en test/manual-r2-act/.state.json los ids que usa el paso 2.
 */
interface IdBody {
  id: string;
}
interface InvoiceBody {
  id: string;
  lines: { id: string }[];
}

describe('R2-ACT manual 1/2 — poblar datos históricos (código anterior)', () => {
  let app: INestApplication<App>;
  let cookie: string;
  const state: Record<string, string> = {};
  let n = 0;
  const next = (): string => `${Date.now()}${(n += 1)}`;

  const api = (): ReturnType<typeof request> => request(app.getHttpServer());

  function ok(
    res: request.Response,
    expected: number,
    what: string,
  ): request.Response {
    if (res.status !== expected) {
      throw new Error(`${what}: ${res.status} ${JSON.stringify(res.body)}`);
    }
    return res;
  }

  it('puebla', async () => {
    const prisma = createTestPrismaClient();
    app = await createE2eApp();
    try {
      const adminLogin = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_ACTIVE_PASSWORD,
      );
      cookie = adminLogin.cookie;
      const short = Date.now() % 1000000;

      // Catálogo mínimo
      const category = await prisma.category.create({
        data: { code: `HCAT${short}`, name: `Cat histórica ${short}` },
      });
      const unitDec = await prisma.unit.create({
        data: {
          code: `HUD${short}`,
          name: `Unidad decimal ${short}`,
          abbreviation: 'ud',
          allowDecimal: true,
        },
      });
      const customer = await prisma.customer.create({
        data: {
          customerType: CustomerType.PERSON,
          customerStage: CustomerStage.CUSTOMER,
          status: CustomerStatus.ACTIVE,
          name: `Cliente histórico ${short}`,
          creditEnabled: true,
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

      // Mapeos contables sintéticos (compras + COGS)
      const keys: [AccountingSystemKey, AccountType][] = [
        [AccountingSystemKey.ACCOUNTS_PAYABLE, AccountType.LIABILITY],
        [AccountingSystemKey.VAT_RECEIVABLE, AccountType.ASSET],
        [AccountingSystemKey.PURCHASE_RESALE_INVENTORY, AccountType.ASSET],
        [AccountingSystemKey.PURCHASE_INTERNAL_CONSUMPTION, AccountType.ASSET],
        [AccountingSystemKey.PURCHASE_FIXED_ASSET, AccountType.ASSET],
        [AccountingSystemKey.PURCHASE_OPERATING_EXPENSE, AccountType.ASSET],
        [AccountingSystemKey.PURCHASE_OTHER, AccountType.ASSET],
        [AccountingSystemKey.COST_OF_GOODS_SOLD, AccountType.COST],
      ];
      let k = 0;
      for (const [systemKey, type] of keys) {
        k += 1;
        const created = ok(
          await api()
            .post('/api/v1/chart-of-accounts')
            .set('Cookie', cookie)
            .send({
              code: `H${k}${short}`,
              name: `Cuenta histórica ${systemKey}`,
              type,
              isPostable: true,
            }),
          201,
          `cuenta ${systemKey}`,
        );
        ok(
          await api()
            .patch(`/api/v1/chart-of-accounts/system-keys/${systemKey}`)
            .set('Cookie', cookie)
            .send({ accountId: (created.body as IdBody).id }),
          200,
          `mapeo ${systemKey}`,
        );
      }
      const supplier = ok(
        await api()
          .post('/api/v1/suppliers')
          .set('Cookie', cookie)
          .send({
            documentType: SupplierDocumentType.RUC,
            documentNumber: `${Date.now()}`.slice(-11).padStart(11, '0'),
            legalName: `Proveedor histórico ${short}`,
          }),
        201,
        'proveedor',
      );
      const supplierId = (supplier.body as IdBody).id;

      const mkProduct = async (
        label: string,
        extra: Record<string, unknown> = {},
      ): Promise<string> => {
        const row = await prisma.product.create({
          data: {
            sku: `H-${label}-${next()}`,
            name: `Producto histórico ${label}`,
            productType: ProductType.PRODUCT,
            categoryId: category.id,
            unitId: unitDec.id,
            salePrice: '25.00',
            isInventoryTracked: true,
            stockCurrent: '0.000',
            status: ProductStatus.ACTIVE,
            ...extra,
          },
        });
        return row.id;
      };
      const pValued = await mkProduct('VAL', {
        valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
      });
      const pPlain = await mkProduct('PLAIN');
      const pZero = await mkProduct('ZERO');
      const pDec = await mkProduct('DEC');
      const pService = (
        await prisma.product.create({
          data: {
            sku: `H-SRV-${next()}`,
            name: 'Servicio histórico',
            productType: ProductType.SERVICE,
            categoryId: category.id,
            unitId: unitDec.id,
            salePrice: '40.00',
            isInventoryTracked: false,
            status: ProductStatus.ACTIVE,
          },
        })
      ).id;
      Object.assign(state, { pValued, pPlain, pZero, pDec, pService });

      // Inventario manual (motor anterior)
      ok(
        await api()
          .post('/api/v1/inventory/initial-balances')
          .set('Cookie', cookie)
          .send({
            productId: pPlain,
            quantity: '10.500',
            reason: 'Saldo inicial histórico',
          }),
        201,
        'saldo inicial',
      );
      ok(
        await api()
          .post('/api/v1/inventory/entries')
          .set('Cookie', cookie)
          .send({
            productId: pPlain,
            quantity: '2.250',
            reason: 'Entrada histórica',
          }),
        201,
        'entrada',
      );
      ok(
        await api().post('/api/v1/inventory/exits').set('Cookie', cookie).send({
          productId: pPlain,
          quantity: '1.000',
          reason: 'Salida histórica',
        }),
        201,
        'salida',
      );

      // Facturas + recepciones
      const receive = async (
        productId: string,
        quantity: string,
        unitCost: string,
      ): Promise<{ invoiceId: string; receiptId: string }> => {
        const draft = ok(
          await api()
            .post('/api/v1/purchase-invoices')
            .set('Cookie', cookie)
            .send({
              supplierId,
              documentType: PurchaseInvoiceDocumentType.FACTURA,
              documentSeries: 'F777',
              documentNumber: next().slice(-8),
              issueDate: businessToday(),
              lines: [
                {
                  productId,
                  acquisitionKind: 'GOOD',
                  purchasePurpose: 'RESALE_INVENTORY',
                  quantity,
                  unitCost,
                  taxCategory: 'UNAFFECTED',
                },
              ],
            }),
          201,
          'factura',
        );
        const invoice = draft.body as InvoiceBody;
        const confirmed = ok(
          await api()
            .post(`/api/v1/purchase-invoices/${invoice.id}/confirm`)
            .set('Cookie', cookie)
            .send({}),
          200,
          'confirmar factura',
        );
        const lineId = (confirmed.body as InvoiceBody).lines[0].id;
        const receipt = ok(
          await api()
            .post(`/api/v1/purchase-invoices/${invoice.id}/receipts`)
            .set('Cookie', cookie)
            .send({ lines: [{ purchaseInvoiceLineId: lineId, quantity }] }),
          201,
          'recepción',
        );
        return {
          invoiceId: invoice.id,
          receiptId: (receipt.body as IdBody).id,
        };
      };
      await receive(pValued, '10.000', '5.00');
      const recDec = await receive(pDec, '7.125', '3.30');
      const recCancelled = await receive(pPlain, '4.000', '2.00');
      ok(
        await api()
          .post(`/api/v1/purchase-receipts/${recCancelled.receiptId}/cancel`)
          .set('Cookie', cookie)
          .send({ reason: 'Recepción histórica anulada' }),
        200,
        'anular recepción',
      );
      state.histReceiptId = recDec.receiptId; // activa, para anular DESPUÉS de migrar
      state.histReceiptQty = '7.125';

      // Ventas
      const sell = async (
        items: { productId: string; quantity: string }[],
      ): Promise<string> => {
        const res = ok(
          await api()
            .post('/api/v1/sales')
            .set('Cookie', cookie)
            .send({ customerId: customer.id, items }),
          201,
          'venta',
        );
        return (res.body as IdBody).id;
      };
      const saleKeep = await sell([
        { productId: pValued, quantity: '3.000' },
        { productId: pPlain, quantity: '2.000' },
      ]);
      const saleToCancelNow = await sell([
        { productId: pValued, quantity: '1.000' },
      ]);
      ok(
        await api()
          .post(`/api/v1/sales/${saleToCancelNow}/cancel`)
          .set('Cookie', cookie)
          .send({ reason: 'Venta histórica anulada' }),
        200,
        'anular venta',
      );
      const saleService = await sell([
        { productId: pService, quantity: '1.000' },
      ]);
      state.histSaleId = saleKeep; // activa, para anular DESPUÉS de migrar
      state.histServiceSaleId = saleService;
      state.customerId = customer.id;
      state.supplierId = supplierId;

      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const fs = require('node:fs') as typeof import('node:fs');
      fs.writeFileSync(
        'test/manual-r2-act/.state.json',
        JSON.stringify(state, null, 2),
      );
    } finally {
      await app.close();
      await prisma.$disconnect();
    }
  }, 180000);
});
