import { BadRequestException, NotFoundException } from '@nestjs/common';
import {
  CategoryStatus,
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  ProductStatus,
  ProductType,
  RoleName,
  UnitStatus,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { InventoryService } from './inventory.service';
import { INVENTORY_MOVEMENT_SAFE_SELECT } from './mappers/inventory-movement.mapper';
import { StockMovementEngine } from './stock-movement.engine';
import { RegisterMovementInput } from './types/register-movement.input';
import { SafeInventoryMovement } from './types/safe-inventory-movement';
import { StockMovementCommand } from './types/stock-movement-command';

const PRODUCT_ID = 'product-1';
const ACTOR_ID = 'actor-1';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface FakeTx {
  marker: 'tx';
}

const FAKE_TX: FakeTx = { marker: 'tx' };

function makeInput(
  overrides: Partial<RegisterMovementInput> = {},
): RegisterMovementInput {
  return {
    productId: PRODUCT_ID,
    quantity: '5.000',
    reason: 'Motivo de prueba',
    notes: null,
    actorUserId: ACTOR_ID,
    ipAddress: '127.0.0.1',
    ...overrides,
  };
}

function makeSafeMovement(
  overrides: Partial<SafeInventoryMovement> = {},
): SafeInventoryMovement {
  return {
    id: 'movement-1',
    product: { id: PRODUCT_ID, sku: 'SKU-1', name: 'Producto uno' },
    movementType: InventoryMovementType.ENTRY,
    origin: InventoryMovementOrigin.MANUAL,
    quantity: '5.000',
    previousStock: '0.000',
    newStock: '5.000',
    reason: 'Motivo de prueba',
    notes: null,
    createdBy: {
      id: ACTOR_ID,
      username: 'jdoe',
      firstName: 'Juan',
      lastName: 'Doe',
    },
    createdAt: NOW,
    ...overrides,
  };
}

interface ProductFindUniqueArgs {
  where: { id: string };
  select?: Record<string, unknown>;
}
interface MovementFindUniqueArgs {
  where: { id: string };
  select?: Record<string, unknown>;
}
interface MovementFindManyArgs {
  where?: Record<string, unknown>;
  select?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}
interface MovementCountArgs {
  where?: Record<string, unknown>;
}

function createPrismaMock() {
  return {
    $queryRaw: jest.fn<Promise<unknown[]>, [Prisma.Sql]>(),
    $transaction: jest.fn((callback: (tx: FakeTx) => unknown) =>
      callback(FAKE_TX),
    ),
    product: {
      findUnique: jest.fn<Promise<unknown>, [ProductFindUniqueArgs]>(),
    },
    inventoryMovement: {
      findUnique: jest.fn<Promise<unknown>, [MovementFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, [MovementFindManyArgs]>(),
      count: jest.fn<Promise<number>, [MovementCountArgs]>(),
    },
  };
}

function createEngineMock() {
  return {
    apply: jest.fn<
      Promise<SafeInventoryMovement>,
      [FakeTx, StockMovementCommand]
    >(),
  };
}

function makeMovementRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'movement-1',
    product: { id: PRODUCT_ID, sku: 'SKU-1', name: 'Producto uno' },
    movementType: InventoryMovementType.ENTRY,
    origin: InventoryMovementOrigin.MANUAL,
    quantity: new Prisma.Decimal('5.000'),
    previousStock: new Prisma.Decimal('0.000'),
    newStock: new Prisma.Decimal('5.000'),
    reason: 'Motivo de prueba',
    notes: null,
    createdBy: {
      id: ACTOR_ID,
      username: 'jdoe',
      firstName: 'Juan',
      lastName: 'Doe',
    },
    createdAt: NOW,
    ...overrides,
  };
}

function makeProductStockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PRODUCT_ID,
    sku: 'SKU-1',
    name: 'Producto uno',
    productType: ProductType.PRODUCT,
    isInventoryTracked: true,
    status: ProductStatus.ACTIVE,
    stockCurrent: new Prisma.Decimal('10.000'),
    stockMinimum: new Prisma.Decimal('2.000'),
    category: { status: CategoryStatus.ACTIVE },
    unit: { status: UnitStatus.ACTIVE, abbreviation: 'un', allowDecimal: true },
    ...overrides,
  };
}

function makeLowStockRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'product-1',
    sku: 'SKU-1',
    name: 'Producto uno',
    stockCurrent: new Prisma.Decimal('1.000'),
    stockMinimum: new Prisma.Decimal('5.000'),
    categoryId: 'category-1',
    categoryName: 'Categoria uno',
    unitId: 'unit-1',
    unitAbbreviation: 'un',
    ...overrides,
  };
}

describe('InventoryService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let engine: ReturnType<typeof createEngineMock>;
  let service: InventoryService;

  beforeEach(() => {
    prisma = createPrismaMock();
    engine = createEngineMock();
    service = new InventoryService(
      prisma as unknown as PrismaService,
      engine as unknown as StockMovementEngine,
    );
  });

  describe('registerInitialBalance', () => {
    it('abre una transacción y delega en engine.apply con ENTRY + INITIAL_BALANCE', async () => {
      const expected = makeSafeMovement({
        origin: InventoryMovementOrigin.INITIAL_BALANCE,
      });
      engine.apply.mockResolvedValue(expected);

      const result = await service.registerInitialBalance(makeInput());

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(engine.apply).toHaveBeenCalledTimes(1);
      const [tx, command] = engine.apply.mock.calls[0];
      expect(tx).toBe(FAKE_TX);
      expect(command.movementType).toBe(InventoryMovementType.ENTRY);
      expect(command.origin).toBe(InventoryMovementOrigin.INITIAL_BALANCE);
      expect(command.referenceType).toBeNull();
      expect(command.referenceId).toBeNull();
      expect(Prisma.Decimal.isDecimal(command.quantity)).toBe(true);
      expect(command.quantity.equals(new Prisma.Decimal('5'))).toBe(true);
      expect(command.reason).toBe('Motivo de prueba');
      expect(command.actorUserId).toBe(ACTOR_ID);
      expect(command.ipAddress).toBe('127.0.0.1');
      expect(result).toBe(expected);
    });

    it('no cuenta movimientos previos ni ejecuta locks (responsabilidad exclusiva del motor)', async () => {
      engine.apply.mockResolvedValue(makeSafeMovement());

      await service.registerInitialBalance(makeInput());

      expect(prisma.$queryRaw).not.toHaveBeenCalled();
    });
  });

  describe('registerEntry', () => {
    it('siempre usa ENTRY + MANUAL', async () => {
      engine.apply.mockResolvedValue(makeSafeMovement());

      await service.registerEntry(makeInput());

      const [, command] = engine.apply.mock.calls[0];
      expect(command.movementType).toBe(InventoryMovementType.ENTRY);
      expect(command.origin).toBe(InventoryMovementOrigin.MANUAL);
      expect(command.referenceType).toBeNull();
      expect(command.referenceId).toBeNull();
    });
  });

  describe('registerExit', () => {
    it('siempre usa EXIT + MANUAL', async () => {
      engine.apply.mockResolvedValue(makeSafeMovement());

      await service.registerExit(makeInput());

      const [, command] = engine.apply.mock.calls[0];
      expect(command.movementType).toBe(InventoryMovementType.EXIT);
      expect(command.origin).toBe(InventoryMovementOrigin.MANUAL);
    });
  });

  describe('registerPositiveAdjustment', () => {
    it('siempre usa ADJUSTMENT_IN + MANUAL', async () => {
      engine.apply.mockResolvedValue(makeSafeMovement());

      await service.registerPositiveAdjustment(makeInput());

      const [, command] = engine.apply.mock.calls[0];
      expect(command.movementType).toBe(InventoryMovementType.ADJUSTMENT_IN);
      expect(command.origin).toBe(InventoryMovementOrigin.MANUAL);
    });
  });

  describe('registerNegativeAdjustment', () => {
    it('siempre usa ADJUSTMENT_OUT + MANUAL', async () => {
      engine.apply.mockResolvedValue(makeSafeMovement());

      await service.registerNegativeAdjustment(makeInput());

      const [, command] = engine.apply.mock.calls[0];
      expect(command.movementType).toBe(InventoryMovementType.ADJUSTMENT_OUT);
      expect(command.origin).toBe(InventoryMovementOrigin.MANUAL);
    });
  });

  describe('conversión segura de cantidad', () => {
    it('convierte una cantidad válida a Prisma.Decimal', async () => {
      engine.apply.mockResolvedValue(makeSafeMovement());

      await service.registerEntry(makeInput({ quantity: '12.500' }));

      const [, command] = engine.apply.mock.calls[0];
      expect(command.quantity.equals(new Prisma.Decimal('12.5'))).toBe(true);
    });

    it('cantidad inválida → 400 sin abrir transacción', async () => {
      await expect(
        service.registerEntry(makeInput({ quantity: 'no-es-un-numero' })),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(engine.apply).not.toHaveBeenCalled();
    });
  });

  it('notes/ipAddress ausentes se normalizan a null', async () => {
    engine.apply.mockResolvedValue(makeSafeMovement());
    const input = makeInput();
    delete input.notes;
    delete input.ipAddress;

    await service.registerEntry(input);

    const [, command] = engine.apply.mock.calls[0];
    expect(command.notes).toBeNull();
    expect(command.ipAddress).toBeNull();
  });

  it('devuelve el resultado del motor sin alterarlo', async () => {
    const expected = makeSafeMovement();
    engine.apply.mockResolvedValue(expected);

    const result = await service.registerExit(makeInput());

    expect(result).toBe(expected);
  });

  describe('listMovements', () => {
    it('usa página/límite por defecto y el select seguro, ordenado createdAt/id DESC', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([makeMovementRow()]);
      prisma.inventoryMovement.count.mockResolvedValue(1);

      const result = await service.listMovements({});

      expect(result.page).toBe(1);
      expect(result.limit).toBe(20);
      expect(result.total).toBe(1);
      expect(result.data[0].quantity).toBe('5.000');
      const args = prisma.inventoryMovement.findMany.mock.calls[0][0];
      expect(args.select).toEqual(INVENTORY_MOVEMENT_SAFE_SELECT);
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
      expect(args.skip).toBe(0);
      expect(args.take).toBe(20);
    });

    it('limita a un máximo de 100 aunque se pida más', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);

      const result = await service.listMovements({ limit: 500 });

      expect(result.limit).toBe(100);
      const args = prisma.inventoryMovement.findMany.mock.calls[0][0];
      expect(args.take).toBe(100);
    });

    it('filtra por productId/movementType/origin/createdByUserId', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);

      await service.listMovements({
        productId: 'p-1',
        movementType: InventoryMovementType.EXIT,
        origin: InventoryMovementOrigin.MANUAL,
        createdByUserId: 'user-9',
      });

      const args = prisma.inventoryMovement.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        productId: 'p-1',
        movementType: InventoryMovementType.EXIT,
        origin: InventoryMovementOrigin.MANUAL,
        createdByUserId: 'user-9',
      });
    });

    it('filtra por dateFrom/dateTo con límites inclusivos (gte/lte)', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);
      const dateFrom = new Date('2026-01-01T00:00:00.000Z');
      const dateTo = new Date('2026-01-31T23:59:59.999Z');

      await service.listMovements({ dateFrom, dateTo });

      const args = prisma.inventoryMovement.findMany.mock.calls[0][0];
      expect(args.where?.createdAt).toEqual({ gte: dateFrom, lte: dateTo });
    });

    it('busca por sku o name del producto (contains, insensitive)', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);

      await service.listMovements({ search: '  taladro  ' });

      const args = prisma.inventoryMovement.findMany.mock.calls[0][0];
      expect(args.where?.product).toEqual({
        OR: [
          { sku: { contains: 'taladro', mode: 'insensitive' } },
          { name: { contains: 'taladro', mode: 'insensitive' } },
        ],
      });
    });

    it('dateFrom > dateTo → 400, sin consultar la base', async () => {
      const dateFrom = new Date('2026-02-01T00:00:00.000Z');
      const dateTo = new Date('2026-01-01T00:00:00.000Z');

      await expect(
        service.listMovements({ dateFrom, dateTo }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
    });

    it('página vacía es una respuesta válida, no un error', async () => {
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);

      const result = await service.listMovements({});

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('findMovementById', () => {
    it('retorna el movimiento existente, mapeado de forma segura', async () => {
      prisma.inventoryMovement.findUnique.mockResolvedValue(makeMovementRow());

      const result = await service.findMovementById('movement-1');

      expect(result.id).toBe('movement-1');
      expect(result.quantity).toBe('5.000');
      const args = prisma.inventoryMovement.findUnique.mock.calls[0][0];
      expect(args.select).toEqual(INVENTORY_MOVEMENT_SAFE_SELECT);
    });

    it('inexistente → 404', async () => {
      prisma.inventoryMovement.findUnique.mockResolvedValue(null);

      await expect(service.findMovementById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('listProductMovements', () => {
    it('producto inexistente → 404, sin consultar movimientos', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.listProductMovements(PRODUCT_ID, {}),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.inventoryMovement.findMany).not.toHaveBeenCalled();
    });

    it('producto existente sin movimientos → página vacía (200, no 404)', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);

      const result = await service.listProductMovements(PRODUCT_ID, {});

      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
    });

    it('el productId de la ruta es la única fuente del filtro por producto', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);

      await service.listProductMovements(PRODUCT_ID, {});

      const args = prisma.inventoryMovement.findMany.mock.calls[0][0];
      expect(args.where?.productId).toBe(PRODUCT_ID);
    });

    it('verifica existencia con una selección mínima (sin exigir estado activo)', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
      prisma.inventoryMovement.findMany.mockResolvedValue([makeMovementRow()]);
      prisma.inventoryMovement.count.mockResolvedValue(1);

      await service.listProductMovements(PRODUCT_ID, {});

      const findUniqueArgs = prisma.product.findUnique.mock.calls[0][0];
      expect(findUniqueArgs.select).toEqual({ id: true });
    });

    it('producto INACTIVE sigue visible: el historial es histórico', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
      prisma.inventoryMovement.findMany.mockResolvedValue([makeMovementRow()]);
      prisma.inventoryMovement.count.mockResolvedValue(1);

      const result = await service.listProductMovements(PRODUCT_ID, {});

      expect(result.data).toHaveLength(1);
    });

    it('orden estable createdAt DESC, id DESC', async () => {
      prisma.product.findUnique.mockResolvedValue({ id: PRODUCT_ID });
      prisma.inventoryMovement.findMany.mockResolvedValue([]);
      prisma.inventoryMovement.count.mockResolvedValue(0);

      await service.listProductMovements(PRODUCT_ID, {});

      const args = prisma.inventoryMovement.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });
  });

  describe('getProductStock', () => {
    it('producto inexistente → 404', async () => {
      prisma.product.findUnique.mockResolvedValue(null);

      await expect(
        service.getProductStock(PRODUCT_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SERVICE → 400 para cualquier rol', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductStockRow({ productType: ProductType.SERVICE }),
      );

      await expect(
        service.getProductStock(PRODUCT_ID, RoleName.SELLER),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('isInventoryTracked=false → 400', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductStockRow({ isInventoryTracked: false }),
      );

      await expect(
        service.getProductStock(PRODUCT_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('SELLER con producto INACTIVE → 404', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductStockRow({ status: ProductStatus.INACTIVE }),
      );

      await expect(
        service.getProductStock(PRODUCT_ID, RoleName.SELLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SELLER con categoría INACTIVE → 404', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductStockRow({ category: { status: CategoryStatus.INACTIVE } }),
      );

      await expect(
        service.getProductStock(PRODUCT_ID, RoleName.SELLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SELLER con unidad INACTIVE → 404', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductStockRow({
          unit: {
            status: UnitStatus.INACTIVE,
            abbreviation: 'un',
            allowDecimal: true,
          },
        }),
      );

      await expect(
        service.getProductStock(PRODUCT_ID, RoleName.SELLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('SELLER con producto/categoría/unidad ACTIVE → responde', async () => {
      prisma.product.findUnique.mockResolvedValue(makeProductStockRow());

      const result = await service.getProductStock(PRODUCT_ID, RoleName.SELLER);

      expect(result.stockCurrent).toBe('10.000');
      expect(result.stockMinimum).toBe('2.000');
      expect(result.unitAbbreviation).toBe('un');
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s puede consultar el stock de un producto inactivo',
      async (role) => {
        prisma.product.findUnique.mockResolvedValue(
          makeProductStockRow({ status: ProductStatus.INACTIVE }),
        );

        const result = await service.getProductStock(PRODUCT_ID, role);

        expect(result.productId).toBe(PRODUCT_ID);
      },
    );

    it('serializa stockCurrent/stockMinimum a 3 decimales', async () => {
      prisma.product.findUnique.mockResolvedValue(
        makeProductStockRow({
          stockCurrent: new Prisma.Decimal('1'),
          stockMinimum: new Prisma.Decimal('0'),
        }),
      );

      const result = await service.getProductStock(PRODUCT_ID, RoleName.ADMIN);

      expect(result.stockCurrent).toBe('1.000');
      expect(result.stockMinimum).toBe('0.000');
    });
  });

  describe('listLowStock', () => {
    it('incluye las condiciones obligatorias (estado, tipo, categoría/unidad ACTIVE, comparación de columnas)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([makeLowStockRow()])
        .mockResolvedValueOnce([{ total: 1 }]);

      const result = await service.listLowStock({});

      expect(result.data).toHaveLength(1);
      expect(result.total).toBe(1);
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).toContain("p.status = 'ACTIVE'");
      expect(rowsSql.text).toContain("p.product_type = 'PRODUCT'");
      expect(rowsSql.text).toContain('p.is_inventory_tracked = true');
      expect(rowsSql.text).toContain("c.status = 'ACTIVE'");
      expect(rowsSql.text).toContain("u.status = 'ACTIVE'");
      expect(rowsSql.text).toContain('p.stock_current <= p.stock_minimum');
      expect(rowsSql.text).toContain(
        'ORDER BY p.name ASC, p.sku ASC, p.id ASC',
      );
    });

    it('usa la misma condición (WHERE) para filas y count, con LIMIT/OFFSET solo en filas', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.listLowStock({ categoryId: 'cat-1' });

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      const countSql = prisma.$queryRaw.mock.calls[1][0];
      expect(rowsSql.values).toEqual(['cat-1', 20, 0]);
      expect(countSql.values).toEqual(['cat-1']);
      expect(countSql.text).toContain('COUNT(*)::int');
    });

    it('agrega categoryId/unitId/search como condiciones parametrizadas', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.listLowStock({
        categoryId: 'cat-1',
        unitId: 'unit-1',
        search: 'taladro',
      });

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.values).toEqual(
        expect.arrayContaining([
          'cat-1',
          'unit-1',
          '%taladro%',
          '%taladro%',
          20,
          0,
        ]),
      );
    });

    it('calcula LIMIT/OFFSET a partir de page/limit', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.listLowStock({ page: 3, limit: 10 });

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.values).toEqual([10, 20]);
    });

    it('orden fijo name ASC, sku ASC, id ASC (no acepta orderBy del cliente)', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ total: 0 }]);

      await service.listLowStock({});

      const rowsSql = prisma.$queryRaw.mock.calls[0][0];
      expect(rowsSql.text).toContain(
        'ORDER BY p.name ASC, p.sku ASC, p.id ASC',
      );
    });

    it('serializa stockCurrent/stockMinimum a 3 decimales, total como number', async () => {
      prisma.$queryRaw
        .mockResolvedValueOnce([
          makeLowStockRow({
            stockCurrent: new Prisma.Decimal('0'),
            stockMinimum: new Prisma.Decimal('0'),
          }),
        ])
        .mockResolvedValueOnce([{ total: 1 }]);

      const result = await service.listLowStock({});

      expect(result.data[0].stockCurrent).toBe('0.000');
      expect(result.data[0].stockMinimum).toBe('0.000');
      expect(typeof result.total).toBe('number');
    });

    // ================================================================
    // Fase 9, Bloque A (R5) — status/brand/difference
    // ================================================================
    describe('status (Fase 9, R5)', () => {
      it('omitido: preserva EXACTAMENTE el comportamiento histórico (solo ACTIVE hardcodeado)', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.listLowStock({});

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        expect(rowsSql.text).toContain("p.status = 'ACTIVE'");
        expect(rowsSql.values).not.toContain(ProductStatus.INACTIVE);
      });

      it('ACTIVE explícito: mismo resultado que omitido', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.listLowStock({ status: ProductStatus.ACTIVE });

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        expect(rowsSql.text).toContain('p.status =');
        expect(rowsSql.values).toContain(ProductStatus.ACTIVE);
      });

      it('INACTIVE explícito: reemplaza el condicional de estado, resto de reglas sin cambios', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.listLowStock({ status: ProductStatus.INACTIVE });

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        expect(rowsSql.values).toContain(ProductStatus.INACTIVE);
        expect(rowsSql.text).toContain('p.is_inventory_tracked = true');
        expect(rowsSql.text).toContain("c.status = 'ACTIVE'");
        expect(rowsSql.text).toContain("u.status = 'ACTIVE'");
        expect(rowsSql.text).toContain('p.stock_current <= p.stock_minimum');
      });
    });

    describe('brand (Fase 9, R5)', () => {
      it('omitido: sin condición de marca', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.listLowStock({});

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        expect(rowsSql.text).not.toContain('p.brand');
      });

      it('con valor: agrega ILIKE parametrizado, insensible a mayúsculas', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.listLowStock({ brand: 'Bosch' });

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        expect(rowsSql.text).toContain('p.brand ILIKE');
        expect(rowsSql.values).toContain('%Bosch%');
      });

      it('recorta espacios', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.listLowStock({ brand: '  Bosch  ' });

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        expect(rowsSql.values).toContain('%Bosch%');
      });

      it('en blanco (solo espacios) -> 400, sin ejecutar la consulta', async () => {
        await expect(
          service.listLowStock({ brand: '   ' }),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$queryRaw).not.toHaveBeenCalled();
      });

      it('combinado con status y categoryId: todas las condiciones coexisten', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([])
          .mockResolvedValueOnce([{ total: 0 }]);

        await service.listLowStock({
          brand: 'Bosch',
          status: ProductStatus.INACTIVE,
          categoryId: 'cat-1',
        });

        const rowsSql = prisma.$queryRaw.mock.calls[0][0];
        expect(rowsSql.values).toEqual(
          expect.arrayContaining([ProductStatus.INACTIVE, 'cat-1', '%Bosch%']),
        );
      });
    });

    describe('difference (Fase 9, R5)', () => {
      it('stockMinimum - stockCurrent, fixed 3 decimales, fraccionario', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([
            makeLowStockRow({
              stockCurrent: new Prisma.Decimal('7.5'),
              stockMinimum: new Prisma.Decimal('10'),
            }),
          ])
          .mockResolvedValueOnce([{ total: 1 }]);

        const result = await service.listLowStock({});

        expect(result.data[0].difference).toBe('2.500');
      });

      it('stockCurrent == stockMinimum -> "0.000", nunca negativo', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([
            makeLowStockRow({
              stockCurrent: new Prisma.Decimal('10'),
              stockMinimum: new Prisma.Decimal('10'),
            }),
          ])
          .mockResolvedValueOnce([{ total: 1 }]);

        const result = await service.listLowStock({});

        expect(result.data[0].difference).toBe('0.000');
      });

      it('usa Prisma.Decimal (resta exacta), nunca resulta en NaN', async () => {
        prisma.$queryRaw
          .mockResolvedValueOnce([makeLowStockRow()])
          .mockResolvedValueOnce([{ total: 1 }]);

        const result = await service.listLowStock({});

        expect(result.data[0].difference).toBe('4.000');
        expect(result.data[0].difference).not.toContain('NaN');
      });
    });
  });
});
