import { BadRequestException } from '@nestjs/common';
import {
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { InventoryService } from './inventory.service';
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

function createPrismaMock() {
  return {
    $queryRaw: jest.fn(),
    $transaction: jest.fn((callback: (tx: FakeTx) => unknown) =>
      callback(FAKE_TX),
    ),
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
});
