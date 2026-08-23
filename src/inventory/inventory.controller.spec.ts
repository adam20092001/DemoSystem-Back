import { BadRequestException, RequestMethod } from '@nestjs/common';
import { METHOD_METADATA } from '@nestjs/common/constants';
import {
  InventoryMovementOrigin,
  InventoryMovementType,
  ProductStatus,
  RoleName,
} from '@prisma/client';
import type { Request } from 'express';
import { ROLES_KEY } from '../common/decorators/roles.decorator';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { InventoryController } from './inventory.controller';
import { InventoryService } from './inventory.service';

const PRODUCT_ID = '11111111-1111-4111-8111-111111111111';
const ACTOR: AuthenticatedUser = {
  id: 'actor-1',
  firstName: 'Ana',
  lastName: 'Admin',
  username: 'admin',
  email: 'admin@demosystem.local',
  role: RoleName.ADMIN,
  status: 'ACTIVE',
  mustChangePassword: false,
  lastLoginAt: null,
  createdAt: new Date(),
  updatedAt: new Date(),
};

/** Evita que TS trate la referencia como un método enlazable (unbound-method). */
const controllerPrototype = InventoryController.prototype as unknown as Record<
  string,
  object
>;

function createInventoryServiceMock() {
  return {
    registerInitialBalance: jest.fn<
      Promise<unknown>,
      [Record<string, unknown>]
    >(),
    registerEntry: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    registerExit: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    registerPositiveAdjustment: jest.fn<
      Promise<unknown>,
      [Record<string, unknown>]
    >(),
    registerNegativeAdjustment: jest.fn<
      Promise<unknown>,
      [Record<string, unknown>]
    >(),
    listMovements: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    findMovementById: jest.fn<Promise<unknown>, [string]>(),
    listProductMovements: jest.fn<
      Promise<unknown>,
      [string, Record<string, unknown>]
    >(),
    getProductStock: jest.fn<Promise<unknown>, [string, RoleName]>(),
    listLowStock: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
  };
}

describe('InventoryController', () => {
  let inventoryService: ReturnType<typeof createInventoryServiceMock>;
  let controller: InventoryController;

  beforeEach(() => {
    inventoryService = createInventoryServiceMock();
    controller = new InventoryController(
      inventoryService as unknown as InventoryService,
    );
  });

  describe('endpoints de escritura', () => {
    const request = { ip: '203.0.113.5' } as unknown as Request;
    const dto = {
      productId: PRODUCT_ID,
      quantity: '5.000',
      reason: 'Motivo',
      notes: 'Notas',
    };

    it('registerInitialBalance() construye RegisterMovementInput y delega', async () => {
      const expected = { id: 'movement-1' };
      inventoryService.registerInitialBalance.mockResolvedValue(expected);

      const result = await controller.registerInitialBalance(
        dto,
        ACTOR,
        request,
      );

      expect(inventoryService.registerInitialBalance).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        quantity: '5.000',
        reason: 'Motivo',
        notes: 'Notas',
        actorUserId: ACTOR.id,
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });

    it('registerEntry() construye RegisterMovementInput y delega', async () => {
      const expected = { id: 'movement-2' };
      inventoryService.registerEntry.mockResolvedValue(expected);

      const result = await controller.registerEntry(dto, ACTOR, request);

      expect(inventoryService.registerEntry).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        quantity: '5.000',
        reason: 'Motivo',
        notes: 'Notas',
        actorUserId: ACTOR.id,
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });

    it('registerExit() construye RegisterMovementInput y delega', async () => {
      const expected = { id: 'movement-3' };
      inventoryService.registerExit.mockResolvedValue(expected);

      const result = await controller.registerExit(dto, ACTOR, request);

      expect(inventoryService.registerExit).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        quantity: '5.000',
        reason: 'Motivo',
        notes: 'Notas',
        actorUserId: ACTOR.id,
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });

    it('registerPositiveAdjustment() construye RegisterMovementInput y delega', async () => {
      const expected = { id: 'movement-4' };
      inventoryService.registerPositiveAdjustment.mockResolvedValue(expected);

      const result = await controller.registerPositiveAdjustment(
        dto,
        ACTOR,
        request,
      );

      expect(inventoryService.registerPositiveAdjustment).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        quantity: '5.000',
        reason: 'Motivo',
        notes: 'Notas',
        actorUserId: ACTOR.id,
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });

    it('registerNegativeAdjustment() construye RegisterMovementInput y delega', async () => {
      const expected = { id: 'movement-5' };
      inventoryService.registerNegativeAdjustment.mockResolvedValue(expected);

      const result = await controller.registerNegativeAdjustment(
        dto,
        ACTOR,
        request,
      );

      expect(inventoryService.registerNegativeAdjustment).toHaveBeenCalledWith({
        productId: PRODUCT_ID,
        quantity: '5.000',
        reason: 'Motivo',
        notes: 'Notas',
        actorUserId: ACTOR.id,
        ipAddress: '203.0.113.5',
      });
      expect(result).toBe(expected);
    });

    it('notes ausente y sin request.ip se normalizan a null', async () => {
      inventoryService.registerEntry.mockResolvedValue({});
      const dtoWithoutNotes = {
        productId: PRODUCT_ID,
        quantity: '5.000',
        reason: 'Motivo',
      };
      const requestWithoutIp = {} as unknown as Request;

      await controller.registerEntry(dtoWithoutNotes, ACTOR, requestWithoutIp);

      expect(inventoryService.registerEntry).toHaveBeenCalledWith(
        expect.objectContaining({ notes: null, ipAddress: null }),
      );
    });
  });

  describe('endpoints de consulta', () => {
    it('listMovements() convierte dateFrom/dateTo a Date y delega', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      inventoryService.listMovements.mockResolvedValue(expected);

      const result = await controller.listMovements({
        page: 2,
        limit: 10,
        productId: PRODUCT_ID,
        movementType: InventoryMovementType.EXIT,
        origin: InventoryMovementOrigin.MANUAL,
        createdByUserId: 'user-1',
        dateFrom: '2026-01-01T00:00:00.000Z',
        dateTo: '2026-01-31T00:00:00.000Z',
        search: 'taladro',
      });

      expect(inventoryService.listMovements).toHaveBeenCalledWith({
        page: 2,
        limit: 10,
        productId: PRODUCT_ID,
        movementType: InventoryMovementType.EXIT,
        origin: InventoryMovementOrigin.MANUAL,
        createdByUserId: 'user-1',
        dateFrom: new Date('2026-01-01T00:00:00.000Z'),
        dateTo: new Date('2026-01-31T00:00:00.000Z'),
        search: 'taladro',
      });
      expect(result).toBe(expected);
    });

    it('findMovementById() transfiere el id de la ruta', async () => {
      const expected = { id: 'movement-1' };
      inventoryService.findMovementById.mockResolvedValue(expected);

      const result = await controller.findMovementById('movement-1');

      expect(inventoryService.findMovementById).toHaveBeenCalledWith(
        'movement-1',
      );
      expect(result).toBe(expected);
    });

    it('listProductMovements() transfiere productId de la ruta y delega', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      inventoryService.listProductMovements.mockResolvedValue(expected);

      const result = await controller.listProductMovements(PRODUCT_ID, {});

      expect(inventoryService.listProductMovements).toHaveBeenCalledWith(
        PRODUCT_ID,
        expect.objectContaining({ page: undefined, limit: undefined }),
      );
      expect(result).toBe(expected);
    });

    it('listProductMovements() rechaza (promesa) un productId de query que contradiga la ruta', async () => {
      const call = controller.listProductMovements(PRODUCT_ID, {
        productId: 'otro-producto',
      });

      await expect(call).rejects.toBeInstanceOf(BadRequestException);
      expect(inventoryService.listProductMovements).not.toHaveBeenCalled();
    });

    it('getProductStock() pasa productId y el rol del usuario autenticado', async () => {
      const expected = { productId: PRODUCT_ID };
      inventoryService.getProductStock.mockResolvedValue(expected);

      const result = await controller.getProductStock(PRODUCT_ID, ACTOR);

      expect(inventoryService.getProductStock).toHaveBeenCalledWith(
        PRODUCT_ID,
        ACTOR.role,
      );
      expect(result).toBe(expected);
    });

    it('listLowStock() delega con los filtros de query', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      inventoryService.listLowStock.mockResolvedValue(expected);

      const result = await controller.listLowStock({
        categoryId: 'cat-1',
        unitId: 'unit-1',
        search: 'taladro',
      });

      expect(inventoryService.listLowStock).toHaveBeenCalledWith({
        page: undefined,
        limit: undefined,
        categoryId: 'cat-1',
        unitId: 'unit-1',
        search: 'taladro',
      });
      expect(result).toBe(expected);
    });

    it('Fase 9, Bloque A (R5): listLowStock() delega brand/status', async () => {
      const expected = {
        data: [],
        page: 1,
        limit: 20,
        total: 0,
        totalPages: 0,
      };
      inventoryService.listLowStock.mockResolvedValue(expected);

      await controller.listLowStock({
        brand: 'Bosch',
        status: ProductStatus.INACTIVE,
      });

      expect(inventoryService.listLowStock).toHaveBeenCalledWith(
        expect.objectContaining({
          brand: 'Bosch',
          status: ProductStatus.INACTIVE,
        }),
      );
    });
  });

  describe('roles por ruta (matriz aprobada)', () => {
    it.each([
      ['registerInitialBalance', [RoleName.ADMIN, RoleName.WAREHOUSE]],
      ['registerEntry', [RoleName.ADMIN, RoleName.WAREHOUSE]],
      ['registerExit', [RoleName.ADMIN, RoleName.WAREHOUSE]],
      ['registerPositiveAdjustment', [RoleName.ADMIN, RoleName.WAREHOUSE]],
      ['registerNegativeAdjustment', [RoleName.ADMIN, RoleName.WAREHOUSE]],
      [
        'listMovements',
        [RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT],
      ],
      [
        'findMovementById',
        [RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT],
      ],
      [
        'listProductMovements',
        [RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT],
      ],
      [
        'getProductStock',
        [
          RoleName.ADMIN,
          RoleName.WAREHOUSE,
          RoleName.MANAGEMENT,
          RoleName.SELLER,
        ],
      ],
      [
        'listLowStock',
        [RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT],
      ],
    ])('%s expone @Roles(%p)', (methodName, roles) => {
      const metadata = Reflect.getMetadata(
        ROLES_KEY,
        controllerPrototype[methodName],
      ) as RoleName[];
      expect(metadata).toEqual(roles);
    });
  });

  describe('sin PATCH/DELETE de InventoryMovement', () => {
    it('ningún método del controller está decorado con @Patch() o @Delete()', () => {
      const methodNames = Object.getOwnPropertyNames(
        InventoryController.prototype,
      ).filter((name) => name !== 'constructor');

      for (const methodName of methodNames) {
        const method = controllerPrototype[methodName];
        const httpMethod = Reflect.getMetadata(METHOD_METADATA, method) as
          RequestMethod | undefined;
        if (httpMethod === undefined) {
          continue;
        }
        expect(httpMethod).not.toBe(RequestMethod.PATCH);
        expect(httpMethod).not.toBe(RequestMethod.DELETE);
      }
    });
  });
});
