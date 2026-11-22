import { INestApplication } from '@nestjs/common';
import { Prisma, PrismaClient } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from '../helpers/constants';
import { createE2eApp } from '../helpers/e2e-app';
import { login } from '../helpers/http';
import { createTestPrismaClient } from '../helpers/prisma-test-client';
import { getDefaultLocationId } from '../helpers/stock-fixtures';

/**
 * R2-ACT — PROCEDIMIENTO MANUAL (no forma parte de `npm run test:e2e`).
 *
 * Paso 2 de 2: sobre la base poblada por populate-historical.manual-spec.ts y
 * YA migrada con `20261031000000_activate_stock_by_location`, opera con el
 * código de R2-ACT sobre documentos HISTÓRICOS (sin ubicación): anulaciones,
 * reversas y operaciones nuevas. Comprueba que lo histórico no se reescribe.
 * Requiere test/manual-r2-act/.state.json del paso 1.
 */
describe('R2-ACT manual 2/2 — operar sobre datos históricos migrados', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let cookie: string;
  let defaultLocationId: string;
  let state: Record<string, string>;

  const api = (): ReturnType<typeof request> => request(app.getHttpServer());
  const stock = async (id: string): Promise<string> =>
    (
      await prisma.product.findUniqueOrThrow({ where: { id } })
    ).stockCurrent.toFixed(3);
  const balance = async (id: string): Promise<string> =>
    (
      (
        await prisma.stockBalance.aggregate({
          where: { productId: id },
          _sum: { quantity: true },
        })
      )._sum.quantity ?? new Prisma.Decimal(0)
    ).toFixed(3);

  beforeAll(async () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const fs = require('node:fs') as typeof import('node:fs');
    state = JSON.parse(
      fs.readFileSync('test/manual-r2-act/.state.json', 'utf8'),
    ) as Record<string, string>;
    prisma = createTestPrismaClient();
    app = await createE2eApp();
    cookie = (
      await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_ACTIVE_PASSWORD,
      )
    ).cookie;
    defaultLocationId = await getDefaultLocationId(prisma);
  }, 90000);

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  it('estado migrado: históricos sin ubicación, saldos conciliados, CHECK sin validar', async () => {
    const historical = await prisma.inventoryMovement.count({
      where: { locationId: null },
    });
    expect(historical).toBeGreaterThan(0);
    const withLocation = await prisma.inventoryMovement.count({
      where: { locationId: { not: null } },
    });
    expect(withLocation).toBe(0);
    const mismatches = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p.id FROM products p WHERE p.stock_current <> COALESCE(
        (SELECT SUM(b.quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)`);
    expect(mismatches).toHaveLength(0);
    // Productos con stock 0 no tienen fila; los demás, una fila en MAIN/DEFAULT.
    expect(
      await prisma.stockBalance.count({ where: { productId: state.pZero } }),
    ).toBe(0);
    const rows = await prisma.stockBalance.findMany({
      where: { productId: state.pPlain },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].locationId).toBe(defaultLocationId);
    const check = await prisma.$queryRaw<{ validated: boolean }[]>(Prisma.sql`
      SELECT convalidated AS validated FROM pg_constraint
      WHERE conname = 'inventory_movements_location_required_after_act'`);
    expect(check[0].validated).toBe(false);
  });

  it('anular una VENTA histórica reingresa a MAIN/DEFAULT con un movimiento NUEVO con ubicación, sin tocar los históricos', async () => {
    const before = {
      valued: await stock(state.pValued),
      plain: await stock(state.pPlain),
    };
    const historicalSaleMovements = await prisma.inventoryMovement.findMany({
      where: {
        referenceType: 'Sale',
        referenceId: state.histSaleId,
        origin: 'SALE',
      },
      select: { id: true, locationId: true, locationNewStock: true },
    });
    expect(historicalSaleMovements.length).toBe(2);
    historicalSaleMovements.forEach((m) => expect(m.locationId).toBeNull());

    const res = await api()
      .post(`/api/v1/sales/${state.histSaleId}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'Anulación post-migración de venta histórica' });
    expect(res.status).toBe(200);

    expect(await stock(state.pValued)).toBe(
      new Prisma.Decimal(before.valued).plus(3).toFixed(3),
    );
    expect(await stock(state.pPlain)).toBe(
      new Prisma.Decimal(before.plain).plus(2).toFixed(3),
    );
    const reversals = await prisma.inventoryMovement.findMany({
      where: {
        referenceType: 'Sale',
        referenceId: state.histSaleId,
        origin: 'SALE_CANCELLATION',
      },
    });
    expect(reversals).toHaveLength(2);
    for (const r of reversals) {
      expect(r.locationId).toBe(defaultLocationId);
      expect(r.locationPreviousStock).not.toBeNull();
      expect(r.locationNewStock).not.toBeNull();
    }
    // Los movimientos históricos siguen sin ubicación (nunca reescritos).
    const after = await prisma.inventoryMovement.findMany({
      where: { id: { in: historicalSaleMovements.map((m) => m.id) } },
      select: { locationId: true },
    });
    after.forEach((m) => expect(m.locationId).toBeNull());
    expect(await balance(state.pValued)).toBe(await stock(state.pValued));
    expect(await balance(state.pPlain)).toBe(await stock(state.pPlain));
  });

  it('anular una RECEPCIÓN histórica (línea sin ubicación) retira de MAIN/DEFAULT con un movimiento nuevo con ubicación', async () => {
    const line = await prisma.purchaseReceiptLine.findFirstOrThrow({
      where: { purchaseReceiptId: state.histReceiptId },
    });
    expect(line.locationId).toBeNull();
    expect(await stock(state.pDec)).toBe('7.125');

    const res = await api()
      .post(`/api/v1/purchase-receipts/${state.histReceiptId}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'Anulación post-migración de recepción histórica' });
    expect(res.status).toBe(200);

    expect(await stock(state.pDec)).toBe('0.000');
    expect(await balance(state.pDec)).toBe('0.000');
    const exit = await prisma.inventoryMovement.findFirstOrThrow({
      where: {
        referenceType: 'PurchaseReceipt',
        referenceId: state.histReceiptId,
        origin: 'PURCHASE_RECEIPT_CANCELLATION',
      },
    });
    expect(exit.locationId).toBe(defaultLocationId);
    // La línea histórica y su movimiento ENTRY original siguen intactos.
    expect(
      (
        await prisma.purchaseReceiptLine.findUniqueOrThrow({
          where: { id: line.id },
        })
      ).locationId,
    ).toBeNull();
    const original = await prisma.inventoryMovement.findFirstOrThrow({
      where: {
        referenceType: 'PurchaseReceipt',
        referenceId: state.histReceiptId,
        origin: 'PURCHASE_RECEIPT',
      },
    });
    expect(original.locationId).toBeNull();
  });

  it('una venta NUEVA sobre producto histórico persiste ubicación en la línea y el movimiento; el servicio no', async () => {
    const sale = await api()
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send({
        customerId: state.customerId,
        items: [
          { productId: state.pPlain, quantity: '1.000' },
          { productId: state.pService, quantity: '1.000' },
        ],
      });
    expect(sale.status).toBe(201);
    const saleId = (sale.body as { id: string }).id;
    const items = await prisma.saleItem.findMany({ where: { saleId } });
    expect(items).toHaveLength(2);
    for (const item of items) {
      if (item.productId === state.pPlain) {
        expect(item.locationId).toBe(defaultLocationId);
      } else {
        expect(item.locationId).toBeNull();
      }
    }
    const movement = await prisma.inventoryMovement.findFirstOrThrow({
      where: { referenceType: 'Sale', referenceId: saleId },
    });
    expect(movement.locationId).toBe(defaultLocationId);
    expect(await balance(state.pPlain)).toBe(await stock(state.pPlain));
  });

  it('stock insuficiente sigue respondiendo 409 sin efectos parciales', async () => {
    const before = await stock(state.pPlain);
    const res = await api()
      .post('/api/v1/sales')
      .set('Cookie', cookie)
      .send({
        customerId: state.customerId,
        items: [{ productId: state.pPlain, quantity: '99999.000' }],
      });
    expect(res.status).toBe(409);
    expect(await stock(state.pPlain)).toBe(before);
  });

  it('una venta histórica de solo servicios se puede anular (sin movimientos que revertir)', async () => {
    const res = await api()
      .post(`/api/v1/sales/${state.histServiceSaleId}/cancel`)
      .set('Cookie', cookie)
      .send({ reason: 'Servicio histórico' });
    expect(res.status).toBe(200);
  });

  it('la conciliación global se mantiene tras todas las operaciones', async () => {
    const mismatches = await prisma.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT p.id FROM products p WHERE p.stock_current <> COALESCE(
        (SELECT SUM(b.quantity) FROM stock_balances b WHERE b.product_id = p.id), 0)`);
    expect(mismatches).toHaveLength(0);
  });
});
