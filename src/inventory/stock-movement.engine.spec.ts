import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import {
  CategoryStatus,
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  ProductStatus,
  ProductType,
  UnitStatus,
} from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { MAX_STOCK_VALUE } from './constants/inventory-decimal.constants';
import { INVENTORY_MOVEMENT_SAFE_SELECT } from './mappers/inventory-movement.mapper';
import { StockMovementEngine } from './stock-movement.engine';
import { StockMovementCommand } from './types/stock-movement-command';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR_ID = '22222222-2222-4222-8222-222222222222';
const CATEGORY_ID = '33333333-3333-4333-8333-333333333333';
const UNIT_ID = '44444444-4444-4444-8444-444444444444';
const MOVEMENT_ID = '55555555-5555-4555-8555-555555555555';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface LockedProductRowShape {
  productId: string;
  productType: ProductType;
  isInventoryTracked: boolean;
  productStatus: ProductStatus;
  stockCurrent: Prisma.Decimal;
  categoryId: string;
  categoryStatus: CategoryStatus;
  unitId: string;
  unitStatus: UnitStatus;
  allowDecimal: boolean;
}

interface ProductUpdateArgs {
  where: { id: string };
  data: { stockCurrent: Prisma.Decimal };
}

interface InventoryMovementCreateArgs {
  data: Record<string, unknown>;
  select?: Record<string, unknown>;
}

interface InventoryMovementCountArgs {
  where: { productId: string };
}

function makeLockedRow(
  overrides: Partial<LockedProductRowShape> = {},
): LockedProductRowShape {
  return {
    productId: PRODUCT_ID,
    productType: ProductType.PRODUCT,
    isInventoryTracked: true,
    productStatus: ProductStatus.ACTIVE,
    stockCurrent: new Prisma.Decimal('10.000'),
    categoryId: CATEGORY_ID,
    categoryStatus: CategoryStatus.ACTIVE,
    unitId: UNIT_ID,
    unitStatus: UnitStatus.ACTIVE,
    allowDecimal: true,
    ...overrides,
  };
}

function makeCommand(
  overrides: Partial<StockMovementCommand> = {},
): StockMovementCommand {
  return {
    productId: PRODUCT_ID,
    quantity: new Prisma.Decimal('5.000'),
    movementType: InventoryMovementType.ENTRY,
    origin: InventoryMovementOrigin.MANUAL,
    reason: 'Movimiento de prueba',
    notes: null,
    actorUserId: ACTOR_ID,
    ipAddress: null,
    referenceType: null,
    referenceId: null,
    ...overrides,
  };
}

function makeMovementRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: MOVEMENT_ID,
    product: { id: PRODUCT_ID, sku: 'SKU-1', name: 'Producto uno' },
    movementType: InventoryMovementType.ENTRY,
    origin: InventoryMovementOrigin.MANUAL,
    quantity: new Prisma.Decimal('5.000'),
    previousStock: new Prisma.Decimal('10.000'),
    newStock: new Prisma.Decimal('15.000'),
    reason: 'Movimiento de prueba',
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

function createTxMock() {
  return {
    $queryRaw: jest.fn<Promise<LockedProductRowShape[]>, [unknown]>(),
    product: {
      update: jest.fn<Promise<unknown>, [ProductUpdateArgs]>(),
    },
    inventoryMovement: {
      create: jest.fn<Promise<unknown>, [InventoryMovementCreateArgs]>(),
      count: jest.fn<Promise<number>, [InventoryMovementCountArgs]>(),
    },
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

type ExpectedErrorType = 'BadRequest' | 'Conflict' | 'NotFound';

function assertErrorType(error: unknown, expected: ExpectedErrorType): void {
  switch (expected) {
    case 'BadRequest':
      expect(error).toBeInstanceOf(BadRequestException);
      break;
    case 'Conflict':
      expect(error).toBeInstanceOf(ConflictException);
      break;
    case 'NotFound':
      expect(error).toBeInstanceOf(NotFoundException);
      break;
  }
}

describe('StockMovementEngine', () => {
  let tx: ReturnType<typeof createTxMock>;
  let txClient: Prisma.TransactionClient;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let engine: StockMovementEngine;

  beforeEach(() => {
    tx = createTxMock();
    txClient = tx as unknown as Prisma.TransactionClient;
    auditService = createAuditServiceMock();
    engine = new StockMovementEngine(auditService as unknown as AuditService);
  });

  function setupLock(row: LockedProductRowShape = makeLockedRow()): void {
    tx.$queryRaw.mockResolvedValue([row]);
  }

  async function captureError(command: StockMovementCommand): Promise<unknown> {
    try {
      await engine.apply(txClient, command);
      return undefined;
    } catch (error) {
      return error;
    }
  }

  describe('operaciones correctas', () => {
    it('ENTRY suma la cantidad al stock', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('10.000') }));
      tx.inventoryMovement.create.mockResolvedValue(
        makeMovementRow({
          movementType: InventoryMovementType.ENTRY,
          previousStock: new Prisma.Decimal('10.000'),
          newStock: new Prisma.Decimal('15.000'),
        }),
      );

      const result = await engine.apply(
        txClient,
        makeCommand({
          movementType: InventoryMovementType.ENTRY,
          quantity: new Prisma.Decimal('5.000'),
        }),
      );

      expect(result.previousStock).toBe('10.000');
      expect(result.newStock).toBe('15.000');
      const updateArgs = tx.product.update.mock.calls[0][0];
      expect(
        updateArgs.data.stockCurrent.equals(new Prisma.Decimal('15')),
      ).toBe(true);
    });

    it('EXIT resta la cantidad al stock', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('10.000') }));
      tx.inventoryMovement.create.mockResolvedValue(
        makeMovementRow({
          movementType: InventoryMovementType.EXIT,
          previousStock: new Prisma.Decimal('10.000'),
          newStock: new Prisma.Decimal('4.000'),
        }),
      );

      const result = await engine.apply(
        txClient,
        makeCommand({
          movementType: InventoryMovementType.EXIT,
          quantity: new Prisma.Decimal('6.000'),
        }),
      );

      expect(result.previousStock).toBe('10.000');
      expect(result.newStock).toBe('4.000');
      const updateArgs = tx.product.update.mock.calls[0][0];
      expect(updateArgs.data.stockCurrent.equals(new Prisma.Decimal('4'))).toBe(
        true,
      );
    });

    it('ADJUSTMENT_IN suma la cantidad al stock', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('10.000') }));
      tx.inventoryMovement.create.mockResolvedValue(
        makeMovementRow({
          movementType: InventoryMovementType.ADJUSTMENT_IN,
          previousStock: new Prisma.Decimal('10.000'),
          newStock: new Prisma.Decimal('13.000'),
        }),
      );

      await engine.apply(
        txClient,
        makeCommand({
          movementType: InventoryMovementType.ADJUSTMENT_IN,
          quantity: new Prisma.Decimal('3.000'),
        }),
      );

      const updateArgs = tx.product.update.mock.calls[0][0];
      expect(
        updateArgs.data.stockCurrent.equals(new Prisma.Decimal('13')),
      ).toBe(true);
    });

    it('ADJUSTMENT_OUT resta la cantidad al stock', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('10.000') }));
      tx.inventoryMovement.create.mockResolvedValue(
        makeMovementRow({
          movementType: InventoryMovementType.ADJUSTMENT_OUT,
          previousStock: new Prisma.Decimal('10.000'),
          newStock: new Prisma.Decimal('8.000'),
        }),
      );

      await engine.apply(
        txClient,
        makeCommand({
          movementType: InventoryMovementType.ADJUSTMENT_OUT,
          quantity: new Prisma.Decimal('2.000'),
        }),
      );

      const updateArgs = tx.product.update.mock.calls[0][0];
      expect(updateArgs.data.stockCurrent.equals(new Prisma.Decimal('8'))).toBe(
        true,
      );
    });

    it('la respuesta serializa quantity/previousStock/newStock con 3 decimales', async () => {
      setupLock();
      tx.inventoryMovement.create.mockResolvedValue(makeMovementRow());

      const result = await engine.apply(txClient, makeCommand());

      expect(result.quantity).toBe('5.000');
      expect(result.previousStock).toBe('10.000');
      expect(result.newStock).toBe('15.000');
      expect(result.notes).toBeNull();
      expect(result.product).toEqual({
        id: PRODUCT_ID,
        sku: 'SKU-1',
        name: 'Producto uno',
      });
      expect(result.createdBy).toEqual({
        id: ACTOR_ID,
        username: 'jdoe',
        firstName: 'Juan',
        lastName: 'Doe',
      });
    });
  });

  describe('validación estructural (antes del lock)', () => {
    it.each<[string, StockMovementCommand, ExpectedErrorType]>([
      [
        'productId inválido',
        makeCommand({ productId: 'not-a-uuid' }),
        'BadRequest',
      ],
      [
        'actorUserId inválido',
        makeCommand({ actorUserId: 'not-a-uuid' }),
        'BadRequest',
      ],
      [
        'quantity no es un Prisma.Decimal real',
        makeCommand({
          quantity: '5.000' as unknown as Prisma.Decimal,
        }),
        'BadRequest',
      ],
      [
        'quantity NaN',
        makeCommand({ quantity: new Prisma.Decimal(NaN) }),
        'BadRequest',
      ],
      [
        'quantity Infinity',
        makeCommand({ quantity: new Prisma.Decimal(Infinity) }),
        'BadRequest',
      ],
      [
        'quantity cero',
        makeCommand({ quantity: new Prisma.Decimal(0) }),
        'BadRequest',
      ],
      [
        'quantity negativa',
        makeCommand({ quantity: new Prisma.Decimal(-5) }),
        'BadRequest',
      ],
      [
        'quantity con más de 3 decimales',
        makeCommand({ quantity: new Prisma.Decimal('1.2345') }),
        'BadRequest',
      ],
      [
        'quantity mayor que MAX_STOCK_VALUE',
        makeCommand({ quantity: MAX_STOCK_VALUE.plus('1') }),
        'BadRequest',
      ],
      ['reason vacío', makeCommand({ reason: '' }), 'BadRequest'],
      ['reason solo espacios', makeCommand({ reason: '   ' }), 'BadRequest'],
      [
        'reason mayor a 200 caracteres',
        makeCommand({ reason: 'a'.repeat(201) }),
        'BadRequest',
      ],
      [
        'notes mayor a 500 caracteres',
        makeCommand({ notes: 'a'.repeat(501) }),
        'BadRequest',
      ],
      [
        'referenceType sin referenceId',
        makeCommand({ referenceType: 'SALE', referenceId: null }),
        'BadRequest',
      ],
      [
        'referenceId sin referenceType',
        makeCommand({ referenceType: null, referenceId: 'ref-1' }),
        'BadRequest',
      ],
      [
        'referenceType mayor a 50 caracteres',
        makeCommand({ referenceType: 'a'.repeat(51), referenceId: 'ref-1' }),
        'BadRequest',
      ],
      [
        'referenceId mayor a 64 caracteres',
        makeCommand({ referenceType: 'SALE', referenceId: 'a'.repeat(65) }),
        'BadRequest',
      ],
      [
        'movementType inválido en tiempo de ejecución',
        makeCommand({
          movementType: 'BOGUS' as unknown as InventoryMovementType,
        }),
        'BadRequest',
      ],
      [
        'origin inválido en tiempo de ejecución',
        makeCommand({
          origin: 'BOGUS' as unknown as InventoryMovementOrigin,
        }),
        'BadRequest',
      ],
      [
        'INITIAL_BALANCE con EXIT',
        makeCommand({
          origin: InventoryMovementOrigin.INITIAL_BALANCE,
          movementType: InventoryMovementType.EXIT,
        }),
        'BadRequest',
      ],
      [
        'SALE con ENTRY',
        makeCommand({
          origin: InventoryMovementOrigin.SALE,
          movementType: InventoryMovementType.ENTRY,
          referenceType: 'SALE',
          referenceId: 'sale-1',
        }),
        'BadRequest',
      ],
      [
        'SALE_CANCELLATION con EXIT',
        makeCommand({
          origin: InventoryMovementOrigin.SALE_CANCELLATION,
          movementType: InventoryMovementType.EXIT,
          referenceType: 'SALE',
          referenceId: 'sale-1',
        }),
        'BadRequest',
      ],
    ])('%s → 400 sin ejecutar el lock', async (_name, command, expected) => {
      const error = await captureError(command);
      expect(error).toBeDefined();
      assertErrorType(error, expected);
      expect(tx.$queryRaw).not.toHaveBeenCalled();
    });

    it('notes vacía tras trim se guarda como null, sin lanzar error', async () => {
      setupLock();
      tx.inventoryMovement.create.mockResolvedValue(makeMovementRow());

      await engine.apply(txClient, makeCommand({ notes: '   ' }));

      const createArgs = tx.inventoryMovement.create.mock.calls[0][0];
      expect(createArgs.data.notes).toBeNull();
    });
  });

  describe('lock y validación del producto', () => {
    it('ejecuta exactamente una consulta de lock', async () => {
      setupLock();
      tx.inventoryMovement.create.mockResolvedValue(makeMovementRow());

      await engine.apply(txClient, makeCommand());

      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('producto inexistente → 404', async () => {
      tx.$queryRaw.mockResolvedValue([]);

      const error = await captureError(makeCommand());

      assertErrorType(error, 'NotFound');
    });

    it('SERVICE → 400', async () => {
      setupLock(makeLockedRow({ productType: ProductType.SERVICE }));

      const error = await captureError(makeCommand());

      assertErrorType(error, 'BadRequest');
    });

    it('producto no inventariado → 400', async () => {
      setupLock(makeLockedRow({ isInventoryTracked: false }));

      const error = await captureError(makeCommand());

      assertErrorType(error, 'BadRequest');
    });

    it('producto INACTIVE → 409', async () => {
      setupLock(makeLockedRow({ productStatus: ProductStatus.INACTIVE }));

      const error = await captureError(makeCommand());

      assertErrorType(error, 'Conflict');
    });

    it('categoría INACTIVE → 409', async () => {
      setupLock(makeLockedRow({ categoryStatus: CategoryStatus.INACTIVE }));

      const error = await captureError(makeCommand());

      assertErrorType(error, 'Conflict');
    });

    it('unidad INACTIVE → 409', async () => {
      setupLock(makeLockedRow({ unitStatus: UnitStatus.INACTIVE }));

      const error = await captureError(makeCommand());

      assertErrorType(error, 'Conflict');
    });

    it('allowDecimal=false con cantidad fraccionaria → 400', async () => {
      setupLock(makeLockedRow({ allowDecimal: false }));

      const error = await captureError(
        makeCommand({ quantity: new Prisma.Decimal('1.500') }),
      );

      assertErrorType(error, 'BadRequest');
    });

    it('allowDecimal=false con cantidad entera → OK', async () => {
      setupLock(makeLockedRow({ allowDecimal: false }));
      tx.inventoryMovement.create.mockResolvedValue(makeMovementRow());

      await expect(
        engine.apply(
          txClient,
          makeCommand({ quantity: new Prisma.Decimal('1.000') }),
        ),
      ).resolves.toBeDefined();
    });

    it('no realiza update/create/audit cuando la validación bajo lock falla', async () => {
      setupLock(makeLockedRow({ productStatus: ProductStatus.INACTIVE }));

      await captureError(makeCommand());

      expect(tx.product.update).not.toHaveBeenCalled();
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('saldo inicial', () => {
    function initialBalanceCommand(
      overrides: Partial<StockMovementCommand> = {},
    ): StockMovementCommand {
      return makeCommand({
        origin: InventoryMovementOrigin.INITIAL_BALANCE,
        movementType: InventoryMovementType.ENTRY,
        referenceType: null,
        referenceId: null,
        ...overrides,
      });
    }

    it('caso correcto: previousStock=0 y sin movimientos previos', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('0') }));
      tx.inventoryMovement.count.mockResolvedValue(0);
      tx.inventoryMovement.create.mockResolvedValue(
        makeMovementRow({
          origin: InventoryMovementOrigin.INITIAL_BALANCE,
          previousStock: new Prisma.Decimal('0.000'),
          newStock: new Prisma.Decimal('5.000'),
        }),
      );

      const result = await engine.apply(txClient, initialBalanceCommand());

      expect(result.origin).toBe(InventoryMovementOrigin.INITIAL_BALANCE);
      expect(tx.inventoryMovement.count).toHaveBeenCalledWith({
        where: { productId: PRODUCT_ID },
      });
      expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
    });

    it('previousStock distinto de cero → 409, aunque no haya movimientos previos', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('3.000') }));
      tx.inventoryMovement.count.mockResolvedValue(0);

      const error = await captureError(initialBalanceCommand());

      assertErrorType(error, 'Conflict');
      expect(tx.inventoryMovement.count).not.toHaveBeenCalled();
    });

    it('movimientos previos existentes → 409', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('0') }));
      tx.inventoryMovement.count.mockResolvedValue(1);

      const error = await captureError(initialBalanceCommand());

      assertErrorType(error, 'Conflict');
      expect(tx.inventoryMovement.create).not.toHaveBeenCalled();
    });

    it('referencia informada con INITIAL_BALANCE → 400', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('0') }));
      tx.inventoryMovement.count.mockResolvedValue(0);

      const error = await captureError(
        initialBalanceCommand({
          referenceType: 'SALE',
          referenceId: 'sale-1',
        }),
      );

      assertErrorType(error, 'BadRequest');
    });
  });

  describe('límites de stock', () => {
    it('EXIT con stock insuficiente → 409', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('3.000') }));

      const error = await captureError(
        makeCommand({
          movementType: InventoryMovementType.EXIT,
          quantity: new Prisma.Decimal('5.000'),
        }),
      );

      assertErrorType(error, 'Conflict');
      expect(tx.product.update).not.toHaveBeenCalled();
    });

    it('ADJUSTMENT_OUT con stock insuficiente → 409', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('3.000') }));

      const error = await captureError(
        makeCommand({
          movementType: InventoryMovementType.ADJUSTMENT_OUT,
          quantity: new Prisma.Decimal('5.000'),
        }),
      );

      assertErrorType(error, 'Conflict');
    });

    it('ENTRY que excede MAX_STOCK_VALUE → 409', async () => {
      setupLock(makeLockedRow({ stockCurrent: MAX_STOCK_VALUE }));

      const error = await captureError(
        makeCommand({
          movementType: InventoryMovementType.ENTRY,
          quantity: new Prisma.Decimal('1.000'),
        }),
      );

      assertErrorType(error, 'Conflict');
      expect(tx.product.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });

  describe('escrituras', () => {
    it('usa el select seguro y los valores normalizados', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('10.000') }));
      tx.inventoryMovement.create.mockResolvedValue(makeMovementRow());

      await engine.apply(
        txClient,
        makeCommand({
          reason: '  Motivo con espacios  ',
          notes: '  notas  ',
        }),
      );

      const createArgs = tx.inventoryMovement.create.mock.calls[0][0];
      expect(createArgs.select).toEqual(INVENTORY_MOVEMENT_SAFE_SELECT);
      expect(createArgs.data.reason).toBe('Motivo con espacios');
      expect(createArgs.data.notes).toBe('notas');
      expect(createArgs.data.origin).toBe(InventoryMovementOrigin.MANUAL);
      expect(createArgs.data.createdByUserId).toBe(ACTOR_ID);
      const previousStock = createArgs.data.previousStock as Prisma.Decimal;
      const newStock = createArgs.data.newStock as Prisma.Decimal;
      expect(previousStock.equals(new Prisma.Decimal('10'))).toBe(true);
      expect(newStock.equals(new Prisma.Decimal('15'))).toBe(true);
    });
  });

  describe('auditoría', () => {
    it('resuelve INVENTORY_INITIAL_BALANCE_CREATED con precedencia sobre ENTRY', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('0') }));
      tx.inventoryMovement.count.mockResolvedValue(0);
      tx.inventoryMovement.create.mockResolvedValue(
        makeMovementRow({ origin: InventoryMovementOrigin.INITIAL_BALANCE }),
      );

      await engine.apply(
        txClient,
        makeCommand({
          origin: InventoryMovementOrigin.INITIAL_BALANCE,
          movementType: InventoryMovementType.ENTRY,
        }),
      );

      expect(auditService.record.mock.calls[0][0].action).toBe(
        AuditAction.INVENTORY_INITIAL_BALANCE_CREATED,
      );
    });

    it.each<[InventoryMovementType, AuditAction]>([
      [InventoryMovementType.ENTRY, AuditAction.INVENTORY_ENTRY_CREATED],
      [InventoryMovementType.EXIT, AuditAction.INVENTORY_EXIT_CREATED],
      [
        InventoryMovementType.ADJUSTMENT_IN,
        AuditAction.INVENTORY_ADJUSTMENT_IN_CREATED,
      ],
      [
        InventoryMovementType.ADJUSTMENT_OUT,
        AuditAction.INVENTORY_ADJUSTMENT_OUT_CREATED,
      ],
    ])('origen MANUAL con %s resuelve %s', async (movementType, action) => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('10.000') }));
      tx.inventoryMovement.create.mockResolvedValue(
        makeMovementRow({ movementType }),
      );

      await engine.apply(
        txClient,
        makeCommand({
          movementType,
          quantity: new Prisma.Decimal('1.000'),
        }),
      );

      expect(auditService.record.mock.calls[0][0].action).toBe(action);
    });

    it('usa la misma transacción como client y una whitelist de 7 claves', async () => {
      setupLock(makeLockedRow({ stockCurrent: new Prisma.Decimal('10.000') }));
      tx.inventoryMovement.create.mockResolvedValue(makeMovementRow());

      await engine.apply(
        txClient,
        makeCommand({ notes: 'nota sensible', reason: 'motivo sensible' }),
      );

      const call = auditService.record.mock.calls[0][0];
      expect(call.client).toBe(txClient);
      const metadata = call.metadata as Record<string, unknown>;
      expect(Object.keys(metadata).sort()).toEqual(
        [
          'movementId',
          'productId',
          'quantity',
          'previousStock',
          'newStock',
          'movementType',
          'origin',
        ].sort(),
      );
      expect(metadata.quantity).toBe('5.000');
      expect(metadata.previousStock).toBe('10.000');
      expect(metadata.newStock).toBe('15.000');
      expect(metadata).not.toHaveProperty('reason');
      expect(metadata).not.toHaveProperty('notes');
      expect(metadata).not.toHaveProperty('referenceId');
    });

    it('propaga el error si auditService.record falla', async () => {
      setupLock();
      tx.inventoryMovement.create.mockResolvedValue(makeMovementRow());
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(engine.apply(txClient, makeCommand())).rejects.toThrow(
        'fallo de auditoría',
      );
    });
  });
});
