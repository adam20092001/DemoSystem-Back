import { ForbiddenException } from '@nestjs/common';
import { InventoryValuationMethod, Prisma, RoleName } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { InventoryValuationService } from './inventory-valuation.service';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';

function d(value: string): Prisma.Decimal {
  return new Prisma.Decimal(value);
}

function createPrismaMock() {
  return {
    product: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
    inventoryValuation: {
      groupBy: jest.fn<Promise<unknown[]>, [unknown]>(),
    },
    inventoryMovement: {
      findMany: jest.fn<Promise<unknown[]>, [unknown]>(),
      count: jest.fn<Promise<number>, [unknown]>(),
    },
  };
}

describe('InventoryValuationService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: InventoryValuationService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.product.findMany.mockResolvedValue([]);
    prisma.product.count.mockResolvedValue(0);
    prisma.inventoryValuation.groupBy.mockResolvedValue([]);
    prisma.inventoryMovement.findMany.mockResolvedValue([]);
    prisma.inventoryMovement.count.mockResolvedValue(0);
    service = new InventoryValuationService(prisma as unknown as PrismaService);
  });

  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer (expone costo)',
      async (role) => {
        await expect(
          service.getValuedInventory({}, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.getPendingValuation({}, role),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );

    it.each([RoleName.ADMIN, RoleName.MANAGEMENT, RoleName.ACCOUNTANT])(
      '%s puede leer',
      async (role) => {
        await expect(
          service.getValuedInventory({}, role),
        ).resolves.toBeDefined();
        await expect(
          service.getPendingValuation({}, role),
        ).resolves.toBeDefined();
      },
    );
  });

  describe('getValuedInventory', () => {
    it('filtra siempre por valuationMethod no nulo', async () => {
      await service.getValuedInventory({}, RoleName.ADMIN);
      const call = prisma.product.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.valuationMethod).toEqual({ not: null });
    });

    it('calcula cantidad valorizada y costo promedio ponderado (ORIGINAL - REVERSAL)', async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: PRODUCT_ID,
          sku: 'SKU-1',
          name: 'Producto 1',
          stockCurrent: d('20.000'),
          valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
        },
      ]);
      prisma.product.count.mockResolvedValue(1);
      prisma.inventoryValuation.groupBy
        .mockResolvedValueOnce([
          {
            productId: PRODUCT_ID,
            _sum: { quantity: d('10.000'), totalCost: d('100.00') },
          },
        ])
        .mockResolvedValueOnce([]);

      const result = await service.getValuedInventory({}, RoleName.ADMIN);

      expect(result.data[0].valuedQuantity).toBe('10.000');
      expect(result.data[0].totalValue).toBe('100.00');
      expect(result.data[0].weightedAverageUnitCost).toBe('10.000000');
      expect(result.data[0].physicalStockCurrent).toBe('20.000');
    });

    it('resta las REVERSAL del total ORIGINAL', async () => {
      prisma.product.findMany.mockResolvedValue([
        {
          id: PRODUCT_ID,
          sku: 'SKU-1',
          name: 'Producto 1',
          stockCurrent: d('0.000'),
          valuationMethod: InventoryValuationMethod.MOVING_WEIGHTED_AVERAGE,
        },
      ]);
      prisma.inventoryValuation.groupBy
        .mockResolvedValueOnce([
          {
            productId: PRODUCT_ID,
            _sum: { quantity: d('10.000'), totalCost: d('100.00') },
          },
        ])
        .mockResolvedValueOnce([
          {
            productId: PRODUCT_ID,
            _sum: { quantity: d('4.000'), totalCost: d('40.00') },
          },
        ]);

      const result = await service.getValuedInventory({}, RoleName.ADMIN);

      expect(result.data[0].valuedQuantity).toBe('6.000');
      expect(result.data[0].totalValue).toBe('60.00');
    });
  });

  describe('getPendingValuation', () => {
    it('filtra ENTRY por recepción de compra, producto con valorización habilitada, sin evento registrado', async () => {
      await service.getPendingValuation({}, RoleName.ADMIN);
      const call = prisma.inventoryMovement.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where.origin).toBe('PURCHASE_RECEIPT');
      expect(call.where.movementType).toBe('ENTRY');
      expect(call.where.inventoryValuation).toEqual({ is: null });
    });
  });
});
