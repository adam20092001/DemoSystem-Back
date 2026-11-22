import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RoleName, WarehouseStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { WarehouseLocationsService } from './warehouse-locations.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

type AsyncFn = jest.Mock<Promise<unknown>, unknown[]>;

function locationRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'loc-1',
    warehouseId: 'wh-1',
    code: 'A-01',
    name: 'Pasillo A',
    description: null,
    status: WarehouseStatus.ACTIVE,
    isDefault: false,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    $queryRaw: jest.fn() as AsyncFn,
    warehouseLocation: {
      create: jest.fn() as AsyncFn,
      findFirst: jest.fn() as AsyncFn,
      update: jest.fn() as AsyncFn,
    },
    stockBalance: { count: jest.fn() as AsyncFn },
    inventoryMovement: { count: jest.fn() as AsyncFn },
    saleItem: { count: jest.fn() as AsyncFn },
    purchaseReceiptLine: { count: jest.fn() as AsyncFn },
  };
  return {
    tx,
    warehouse: { findUnique: jest.fn() as AsyncFn },
    warehouseLocation: {
      findMany: jest.fn() as AsyncFn,
      findFirst: jest.fn() as AsyncFn,
      count: jest.fn() as AsyncFn,
    },
    $transaction: jest.fn((cb: (client: typeof tx) => unknown) => cb(tx)),
  };
}

function input(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    requesterRole: RoleName.ADMIN,
    actorUserId: ACTOR_ID,
    ipAddress: '10.0.0.1',
    warehouseId: 'wh-1',
    ...overrides,
  };
}

describe('WarehouseLocationsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { record: jest.Mock<Promise<void>, [Record<string, unknown>]> };
  let service: WarehouseLocationsService;

  /** Responde las dos consultas FOR SHARE (almacén) y FOR UPDATE (ubicación) en orden. */
  function lockRows(
    warehouseStatus: WarehouseStatus,
    location?: { status: WarehouseStatus; isDefault: boolean } | null,
  ) {
    prisma.tx.$queryRaw.mockResolvedValueOnce([
      { id: 'wh-1', status: warehouseStatus },
    ]);
    if (location !== undefined) {
      prisma.tx.$queryRaw.mockResolvedValueOnce(
        location === null
          ? []
          : [
              {
                id: 'loc-1',
                status: location.status,
                is_default: location.isDefault,
              },
            ],
      );
    }
  }

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = {
      record: jest
        .fn<Promise<void>, [Record<string, unknown>]>()
        .mockResolvedValue(undefined),
    };
    service = new WarehouseLocationsService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    prisma.tx.warehouseLocation.create.mockResolvedValue(locationRow());
    prisma.tx.warehouseLocation.findFirst.mockResolvedValue({ id: 'loc-1' });
    prisma.tx.warehouseLocation.update.mockResolvedValue(locationRow());
    prisma.tx.stockBalance.count.mockResolvedValue(0);
    prisma.tx.inventoryMovement.count.mockResolvedValue(0);
    prisma.tx.saleItem.count.mockResolvedValue(0);
    prisma.tx.purchaseReceiptLine.count.mockResolvedValue(0);
    prisma.warehouse.findUnique.mockResolvedValue({ id: 'wh-1' });
    prisma.warehouseLocation.findMany.mockResolvedValue([locationRow()]);
    prisma.warehouseLocation.count.mockResolvedValue(1);
    prisma.warehouseLocation.findFirst.mockResolvedValue(locationRow());
  });

  describe('create', () => {
    it('crea una ubicación ACTIVE no predeterminada en un almacén activo', async () => {
      lockRows(WarehouseStatus.ACTIVE);
      await service.create(
        input({ code: ' a-01 ', name: ' Pasillo A ' }) as never,
      );
      const call = prisma.tx.warehouseLocation.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).toMatchObject({
        warehouseId: 'wh-1',
        code: 'A-01',
        name: 'Pasillo A',
        status: WarehouseStatus.ACTIVE,
        isDefault: false,
      });
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.LOCATION_CREATED,
        metadata: { warehouseId: 'wh-1', code: 'A-01' },
        client: prisma.tx,
      });
    });

    it.each(['DEFAULT', 'default', ' Default '])(
      'el código reservado %p responde 409 sin abrir transacción',
      async (code) => {
        await expect(
          service.create(input({ code, name: 'x' }) as never),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it.each(['', 'A B', 'X'.repeat(31), '_X'])(
      'rechaza el código inválido %p con 400',
      async (code) => {
        await expect(
          service.create(input({ code, name: 'x' }) as never),
        ).rejects.toBeInstanceOf(BadRequestException);
      },
    );

    it('409 en un almacén inactivo: no se crean ubicaciones operativas', async () => {
      lockRows(WarehouseStatus.INACTIVE);
      await expect(
        service.create(input({ code: 'A1', name: 'x' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.warehouseLocation.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('404 si el almacén no existe (no hay operaciones sobre almacenes inexistentes)', async () => {
      prisma.tx.$queryRaw.mockResolvedValueOnce([]);
      await expect(
        service.create(input({ code: 'A1', name: 'x' }) as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tx.warehouseLocation.create).not.toHaveBeenCalled();
    });

    it('propaga el error de unicidad (almacén, código) sin pre-check', async () => {
      lockRows(WarehouseStatus.ACTIVE);
      const dup = new Error('P2002');
      prisma.tx.warehouseLocation.create.mockRejectedValue(dup);
      await expect(
        service.create(input({ code: 'A1', name: 'x' }) as never),
      ).rejects.toBe(dup);
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([RoleName.WAREHOUSE, RoleName.PURCHASING, RoleName.MANAGEMENT])(
      '%s recibe 403',
      async (requesterRole) => {
        await expect(
          service.create(
            input({ requesterRole, code: 'A1', name: 'x' }) as never,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('lectura', () => {
    it('list responde 404 si el almacén no existe', async () => {
      prisma.warehouse.findUnique.mockResolvedValue(null);
      await expect(
        service.list('x', {}, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('list siempre filtra por el almacén de la ruta', async () => {
      await service.list(
        'wh-1',
        { status: WarehouseStatus.ACTIVE },
        RoleName.SELLER,
      );
      const call = prisma.warehouseLocation.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toMatchObject({
        warehouseId: 'wh-1',
        status: 'ACTIVE',
      });
    });

    it('findOne exige que la ubicación pertenezca al almacén de la ruta (404 si es de otro)', async () => {
      prisma.warehouseLocation.findFirst.mockResolvedValue(null);
      await expect(
        service.findOne('wh-otro', 'loc-1', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.warehouseLocation.findFirst.mock.calls[0][0]).toMatchObject(
        {
          where: { id: 'loc-1', warehouseId: 'wh-otro' },
        },
      );
    });

    it.each([RoleName.PURCHASING, RoleName.ACCOUNTANT])(
      '%s recibe 403 al leer',
      async (role) => {
        await expect(service.list('wh-1', {}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(
          service.findOne('wh-1', 'loc-1', role),
        ).rejects.toBeInstanceOf(ForbiddenException);
      },
    );
  });

  describe('update', () => {
    it('solo cambia nombre/descripción y exige pertenencia al almacén', async () => {
      await service.update(
        input({ locationId: 'loc-1', name: ' Nuevo ' }) as never,
      );
      expect(prisma.tx.warehouseLocation.findFirst).toHaveBeenCalledWith({
        where: { id: 'loc-1', warehouseId: 'wh-1' },
        select: { id: true },
      });
      const call = prisma.tx.warehouseLocation.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).toEqual({ name: 'Nuevo' });
    });

    it('404 si la ubicación es de otro almacén', async () => {
      prisma.tx.warehouseLocation.findFirst.mockResolvedValue(null);
      await expect(
        service.update(input({ locationId: 'loc-1', name: 'n' }) as never),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tx.warehouseLocation.update).not.toHaveBeenCalled();
    });

    it('400 con payload vacío', async () => {
      await expect(
        service.update(input({ locationId: 'loc-1' }) as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('deactivate', () => {
    it('desactiva una ubicación no predeterminada sin dependencias', async () => {
      lockRows(WarehouseStatus.ACTIVE, {
        status: WarehouseStatus.ACTIVE,
        isDefault: false,
      });
      prisma.tx.warehouseLocation.update.mockResolvedValue(
        locationRow({ status: WarehouseStatus.INACTIVE }),
      );
      const result = await service.deactivate(
        input({ locationId: 'loc-1' }) as never,
      );
      expect(result.status).toBe(WarehouseStatus.INACTIVE);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.LOCATION_DEACTIVATED,
        metadata: { warehouseId: 'wh-1', previousStatus: 'ACTIVE' },
      });
    });

    it('DEFAULT nunca se desactiva por separado (409), sin consultar dependencias', async () => {
      lockRows(WarehouseStatus.ACTIVE, {
        status: WarehouseStatus.ACTIVE,
        isDefault: true,
      });
      await expect(
        service.deactivate(input({ locationId: 'loc-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.stockBalance.count).not.toHaveBeenCalled();
      expect(prisma.tx.warehouseLocation.update).not.toHaveBeenCalled();
    });

    it.each([
      ['saldo distinto de cero', 'stockBalance'],
      ['movimientos', 'inventoryMovement'],
      ['líneas de venta', 'saleItem'],
      ['líneas de recepción', 'purchaseReceiptLine'],
    ] as const)('bloquea (409) con %s', async (_label, key) => {
      lockRows(WarehouseStatus.ACTIVE, {
        status: WarehouseStatus.ACTIVE,
        isDefault: false,
      });
      prisma.tx[key].count.mockResolvedValue(2);
      await expect(
        service.deactivate(input({ locationId: 'loc-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.warehouseLocation.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it('409 si ya está inactiva; 404 si es de otro almacén', async () => {
      lockRows(WarehouseStatus.ACTIVE, {
        status: WarehouseStatus.INACTIVE,
        isDefault: false,
      });
      await expect(
        service.deactivate(input({ locationId: 'loc-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
      lockRows(WarehouseStatus.ACTIVE, null);
      await expect(
        service.deactivate(input({ locationId: 'loc-1' }) as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('activate', () => {
    it('activa una ubicación inactiva de un almacén activo', async () => {
      lockRows(WarehouseStatus.ACTIVE, {
        status: WarehouseStatus.INACTIVE,
        isDefault: false,
      });
      await service.activate(input({ locationId: 'loc-1' }) as never);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.LOCATION_ACTIVATED,
      });
    });

    it('409 si el almacén está inactivo', async () => {
      lockRows(WarehouseStatus.INACTIVE, {
        status: WarehouseStatus.INACTIVE,
        isDefault: false,
      });
      await expect(
        service.activate(input({ locationId: 'loc-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.warehouseLocation.update).not.toHaveBeenCalled();
    });

    it('409 si ya estaba activa', async () => {
      lockRows(WarehouseStatus.ACTIVE, {
        status: WarehouseStatus.ACTIVE,
        isDefault: false,
      });
      await expect(
        service.activate(input({ locationId: 'loc-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it.each([RoleName.WAREHOUSE, RoleName.PURCHASING])(
      '%s recibe 403 al activar/desactivar',
      async (requesterRole) => {
        await expect(
          service.activate(
            input({ requesterRole, locationId: 'loc-1' }) as never,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.deactivate(
            input({ requesterRole, locationId: 'loc-1' }) as never,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });
});
