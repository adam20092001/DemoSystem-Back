import { Prisma, PrismaClient } from '@prisma/client';

/**
 * R2-ACT — utilidades de fixtures para pruebas E2E.
 *
 * Desde R2-ACT, products.stock_current y la suma de stock_balances deben
 * coincidir AL COMMIT (triggers diferidos). Un fixture que escriba
 * `stockCurrent` directamente con Prisma, sin su saldo por ubicación, será
 * rechazado por la base de datos — a propósito: estas funciones escriben
 * producto y saldo MAIN/DEFAULT en UNA misma transacción. No deshabilitan ni
 * eluden ningún trigger.
 *
 * Los productos con stock 0 no llevan fila de saldo ("sin fila" = 0), igual
 * que el backfill de la migración.
 */

type Db = PrismaClient | Prisma.TransactionClient;

/** id de la ubicación DEFAULT del almacén predeterminado (MAIN/DEFAULT). */
export async function getDefaultLocationId(db: Db): Promise<string> {
  const location = await db.warehouseLocation.findFirst({
    where: { isDefault: true, warehouse: { isDefault: true } },
    select: { id: true },
  });
  if (location === null) {
    throw new Error('Fixture: no existe la ubicación MAIN/DEFAULT');
  }
  return location.id;
}

/**
 * Fija el stock consolidado de un producto Y su saldo MAIN/DEFAULT en una
 * misma transacción (elimina cualquier otro saldo del producto, para que la
 * suma por ubicación sea exactamente `quantity`).
 */
export async function setProductStock(
  prisma: PrismaClient,
  productId: string,
  quantity: Prisma.Decimal.Value,
): Promise<void> {
  const qty = new Prisma.Decimal(quantity);
  await prisma.$transaction(async (tx) => {
    const locationId = await getDefaultLocationId(tx);
    await tx.stockBalance.deleteMany({ where: { productId } });
    if (qty.greaterThan(0)) {
      await tx.stockBalance.create({
        data: { productId, locationId, quantity: qty },
      });
    }
    await tx.product.update({
      where: { id: productId },
      data: { stockCurrent: qty },
    });
  });
}

/** Crea un producto con stock inicial y su saldo MAIN/DEFAULT, coherentes. */
export async function createProductWithStock(
  prisma: PrismaClient,
  data: Prisma.ProductUncheckedCreateInput,
  quantity: Prisma.Decimal.Value = 0,
): Promise<{ id: string }> {
  const qty = new Prisma.Decimal(quantity);
  return prisma.$transaction(async (tx) => {
    const locationId = await getDefaultLocationId(tx);
    const product = await tx.product.create({
      data: { ...data, stockCurrent: qty },
      select: { id: true },
    });
    if (qty.greaterThan(0)) {
      await tx.stockBalance.create({
        data: { productId: product.id, locationId, quantity: qty },
      });
    }
    return product;
  });
}

/**
 * Elimina productos junto con sus saldos por ubicación en una misma
 * transacción (stock_balances.product_id es RESTRICT; borrar solo los saldos
 * dejaría el consolidado desconciliado y el trigger lo rechazaría).
 * Los movimientos deben haberse eliminado antes, como ya hacían las suites.
 */
export async function deleteProductsWithBalances(
  prisma: PrismaClient,
  productIds: string[],
): Promise<void> {
  if (productIds.length === 0) return;
  await prisma.$transaction([
    prisma.stockBalance.deleteMany({
      where: { productId: { in: productIds } },
    }),
    prisma.product.deleteMany({ where: { id: { in: productIds } } }),
  ]);
}

/** true si la migración R2-ACT está aplicada (existe su trigger de conciliación). */
export async function isStockLocationActivated(db: Db): Promise<boolean> {
  const rows = await db.$queryRaw<{ n: bigint }[]>`
    SELECT count(*)::bigint AS n FROM pg_trigger
    WHERE tgname = 'r2_stock_check_products_upd' AND NOT tgisinternal`;
  return Number(rows[0]?.n ?? 0) > 0;
}

/**
 * Sustituto directo de `prisma.product.create(args)` para suites que crean
 * productos con stock inicial: si `data.stockCurrent` > 0 crea, en la MISMA
 * transacción, el saldo MAIN/DEFAULT equivalente (sin él, el trigger diferido
 * rechazaría el COMMIT). Con stock 0 o ausente no hay saldo ("sin fila" = 0).
 * Requiere que `args` seleccione el id (comportamiento por defecto).
 */
export async function createProductRow<T extends Prisma.ProductCreateArgs>(
  prisma: PrismaClient,
  args: T,
): Promise<Prisma.ProductGetPayload<T>> {
  const raw = (args.data as { stockCurrent?: Prisma.Decimal.Value | null })
    .stockCurrent;
  const stock = new Prisma.Decimal(raw ?? 0);
  if (!stock.greaterThan(0)) {
    return prisma.product.create(args) as unknown as Promise<
      Prisma.ProductGetPayload<T>
    >;
  }
  return prisma.$transaction(async (tx) => {
    const locationId = await getDefaultLocationId(tx);
    const row = (await tx.product.create(args)) as unknown as { id?: string };
    if (typeof row.id !== 'string') {
      throw new Error('createProductRow: el select de args debe incluir id');
    }
    await tx.stockBalance.create({
      data: { productId: row.id, locationId, quantity: stock },
    });
    return row as Prisma.ProductGetPayload<T>;
  });
}

/**
 * Sustituto de `prisma.product.deleteMany(args)`: elimina también los saldos
 * por ubicación de esos productos en la misma transacción (stock_balances
 * .product_id es RESTRICT y el trigger rechazaría borrar solo los saldos).
 */
export async function deleteProductRows(
  prisma: PrismaClient,
  args: Prisma.ProductDeleteManyArgs,
): Promise<Prisma.BatchPayload> {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.product.findMany({
      where: args.where,
      select: { id: true },
    });
    await tx.stockBalance.deleteMany({
      where: { productId: { in: rows.map((row) => row.id) } },
    });
    return tx.product.deleteMany(args);
  });
}

/** Sustituto de `prisma.product.delete(args)` (saldos + producto en una transacción). */
export async function deleteProductRow(
  prisma: PrismaClient,
  args: Prisma.ProductDeleteArgs,
): Promise<unknown> {
  return prisma.$transaction(async (tx) => {
    const row = await tx.product.findUnique({
      where: args.where,
      select: { id: true },
    });
    if (row !== null) {
      await tx.stockBalance.deleteMany({ where: { productId: row.id } });
    }
    return tx.product.delete(args);
  });
}

/**
 * Fija los saldos por ubicación de un producto Y su consolidado (= suma) en
 * una sola transacción. Reemplaza cualquier saldo previo del producto. Para
 * fixtures multi-ubicación (la API de R2-ACT solo opera sobre MAIN/DEFAULT).
 */
export async function setProductLocationBalances(
  prisma: PrismaClient,
  productId: string,
  balances: { locationId: string; quantity: Prisma.Decimal.Value }[],
): Promise<void> {
  const rows = balances.map((b) => ({
    locationId: b.locationId,
    quantity: new Prisma.Decimal(b.quantity),
  }));
  const total = rows.reduce(
    (sum, row) => sum.plus(row.quantity),
    new Prisma.Decimal(0),
  );
  await prisma.$transaction(async (tx) => {
    await tx.stockBalance.deleteMany({ where: { productId } });
    for (const row of rows) {
      await tx.stockBalance.create({
        data: { productId, locationId: row.locationId, quantity: row.quantity },
      });
    }
    await tx.product.update({
      where: { id: productId },
      data: { stockCurrent: total },
    });
  });
}
