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
import { WarehousesService } from './warehouses.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

type AsyncFn = jest.Mock<Promise<unknown>, unknown[]>;

function warehouseRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'wh-1',
    code: 'SUR',
    name: 'Almacén Sur',
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
    warehouse: {
      create: jest.fn() as AsyncFn,
      findUnique: jest.fn() as AsyncFn,
      update: jest.fn() as AsyncFn,
    },
    warehouseLocation: {
      create: jest.fn() as AsyncFn,
      findMany: jest.fn() as AsyncFn,
    },
    stockBalance: { count: jest.fn() as AsyncFn },
    inventoryMovement: { count: jest.fn() as AsyncFn },
    saleItem: { count: jest.fn() as AsyncFn },
    purchaseReceiptLine: { count: jest.fn() as AsyncFn },
  };
  return {
    tx,
    warehouse: {
      findUnique: jest.fn() as AsyncFn,
      findMany: jest.fn() as AsyncFn,
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
    ...overrides,
  };
}

describe('WarehousesService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let audit: { record: jest.Mock<Promise<void>, [Record<string, unknown>]> };
  let service: WarehousesService;

  beforeEach(() => {
    prisma = createPrismaMock();
    audit = {
      record: jest
        .fn<Promise<void>, [Record<string, unknown>]>()
        .mockResolvedValue(undefined),
    };
    service = new WarehousesService(
      prisma as unknown as PrismaService,
      audit as unknown as AuditService,
    );
    prisma.tx.warehouse.create.mockResolvedValue(warehouseRow());
    prisma.tx.warehouse.update.mockResolvedValue(warehouseRow());
    prisma.tx.warehouse.findUnique.mockResolvedValue({ id: 'wh-1' });
    prisma.tx.warehouseLocation.create.mockResolvedValue({ id: 'loc-1' });
    prisma.tx.warehouseLocation.findMany.mockResolvedValue([{ id: 'loc-1' }]);
    prisma.tx.stockBalance.count.mockResolvedValue(0);
    prisma.tx.inventoryMovement.count.mockResolvedValue(0);
    prisma.tx.saleItem.count.mockResolvedValue(0);
    prisma.tx.purchaseReceiptLine.count.mockResolvedValue(0);
    prisma.warehouse.findUnique.mockResolvedValue(warehouseRow());
    prisma.warehouse.findMany.mockResolvedValue([warehouseRow()]);
    prisma.warehouse.count.mockResolvedValue(1);
  });

  describe('create', () => {
    it('crea el almacén ACTIVE no predeterminado y su ubicación DEFAULT en la misma transacción', async () => {
      const result = await service.create(
        input({ code: 'SUR', name: 'Almacén Sur' }) as never,
      );

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      const warehouseCall = prisma.tx.warehouse.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(warehouseCall.data).toMatchObject({
        code: 'SUR',
        status: WarehouseStatus.ACTIVE,
        isDefault: false,
      });
      const locationCall = prisma.tx.warehouseLocation.create.mock
        .calls[0][0] as { data: Record<string, unknown> };
      expect(locationCall.data).toMatchObject({
        warehouseId: 'wh-1',
        code: 'DEFAULT',
        isDefault: true,
        status: WarehouseStatus.ACTIVE,
      });
      expect(result.id).toBe('wh-1');
    });

    it('normaliza el código a mayúsculas sin espacios y la descripción vacía a null', async () => {
      await service.create(
        input({
          code: '  nor-te ',
          name: ' Norte ',
          description: '   ',
        }) as never,
      );
      const call = prisma.tx.warehouse.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).toMatchObject({
        code: 'NOR-TE',
        name: 'Norte',
        description: null,
      });
    });

    it.each(['', 'A B', 'ÑANDU', '-X', 'X'.repeat(21), 'A/B'])(
      'rechaza el código inválido %p con 400 sin abrir transacción',
      async (code) => {
        await expect(
          service.create(input({ code, name: 'x' }) as never),
        ).rejects.toBeInstanceOf(BadRequestException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );

    it('rechaza un nombre solo con espacios', async () => {
      await expect(
        service.create(input({ code: 'SUR', name: '   ' }) as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('audita WAREHOUSE_CREATED con code y defaultLocationId, dentro de la transacción', async () => {
      await service.create(input({ code: 'SUR', name: 'Sur' }) as never);
      const call = audit.record.mock.calls[0][0];
      expect(call).toMatchObject({
        userId: ACTOR_ID,
        module: 'WAREHOUSES',
        action: AuditAction.WAREHOUSE_CREATED,
        entityType: 'Warehouse',
        entityId: 'wh-1',
        metadata: { code: 'SUR', defaultLocationId: 'loc-1' },
        client: prisma.tx,
      });
    });

    it('propaga el error de unicidad de la base sin pre-check (la transacción hace rollback)', async () => {
      const dup = new Error('P2002');
      prisma.tx.warehouse.create.mockRejectedValue(dup);
      await expect(
        service.create(input({ code: 'MAIN', name: 'x' }) as never),
      ).rejects.toBe(dup);
      expect(prisma.tx.warehouseLocation.create).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([
      RoleName.WAREHOUSE,
      RoleName.PURCHASING,
      RoleName.MANAGEMENT,
      RoleName.SELLER,
      RoleName.ACCOUNTANT,
    ])('rechaza a %s con 403 sin tocar la base', async (requesterRole) => {
      await expect(
        service.create(input({ requesterRole, code: 'X', name: 'x' }) as never),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });
  });

  describe('lectura', () => {
    it.each([
      RoleName.ADMIN,
      RoleName.WAREHOUSE,
      RoleName.MANAGEMENT,
      RoleName.SELLER,
    ])('%s puede listar y consultar', async (role) => {
      await expect(service.list({}, role)).resolves.toMatchObject({
        total: 1,
      });
      await expect(service.findOne('wh-1', role)).resolves.toMatchObject({
        id: 'wh-1',
      });
    });

    it.each([RoleName.PURCHASING, RoleName.ACCOUNTANT])(
      '%s recibe 403 al leer',
      async (role) => {
        await expect(service.list({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        await expect(service.findOne('wh-1', role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(prisma.warehouse.findMany).not.toHaveBeenCalled();
      },
    );

    it('findOne responde 404 si no existe', async () => {
      prisma.warehouse.findUnique.mockResolvedValue(null);
      await expect(service.findOne('x', RoleName.ADMIN)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('list aplica filtros, tope de límite y orden fijo (principal primero)', async () => {
      await service.list(
        { status: WarehouseStatus.ACTIVE, search: ' sur ', limit: 500 },
        RoleName.ADMIN,
      );
      const call = prisma.warehouse.findMany.mock.calls[0][0] as {
        where: { status: string; OR: unknown[] };
        take: number;
        orderBy: unknown;
      };
      expect(call.where.status).toBe('ACTIVE');
      expect(call.where.OR).toHaveLength(2);
      expect(call.take).toBe(100);
      expect(call.orderBy).toEqual([{ isDefault: 'desc' }, { code: 'asc' }]);
    });
  });

  describe('update', () => {
    it('solo permite nombre y descripción; audita los campos tocados', async () => {
      await service.update(
        input({
          warehouseId: 'wh-1',
          name: ' Nuevo ',
          description: null,
        }) as never,
      );
      const call = prisma.tx.warehouse.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(call.data).toEqual({ name: 'Nuevo', description: null });
      expect(call.data).not.toHaveProperty('code');
      expect(call.data).not.toHaveProperty('status');
      expect(call.data).not.toHaveProperty('isDefault');
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.WAREHOUSE_UPDATED,
        metadata: { updatedFields: ['name', 'description'] },
      });
    });

    it('rechaza un payload vacío con 400', async () => {
      await expect(
        service.update(input({ warehouseId: 'wh-1' }) as never),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('404 si el almacén no existe', async () => {
      prisma.tx.warehouse.findUnique.mockResolvedValue(null);
      await expect(
        service.update(input({ warehouseId: 'x', name: 'n' }) as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('403 para un rol sin permiso', async () => {
      await expect(
        service.update(
          input({
            requesterRole: RoleName.WAREHOUSE,
            warehouseId: 'wh-1',
            name: 'n',
          }) as never,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });
  });

  describe('activate / deactivate', () => {
    function lockedRow(status: WarehouseStatus, isDefault = false) {
      prisma.tx.$queryRaw.mockResolvedValue([
        { id: 'wh-1', status, is_default: isDefault },
      ]);
    }

    it('desactiva un almacén sin dependencias y audita el estado previo', async () => {
      lockedRow(WarehouseStatus.ACTIVE);
      prisma.tx.warehouse.update.mockResolvedValue(
        warehouseRow({ status: WarehouseStatus.INACTIVE }),
      );
      const result = await service.deactivate(
        input({ warehouseId: 'wh-1' }) as never,
      );
      expect(result.status).toBe(WarehouseStatus.INACTIVE);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.WAREHOUSE_DEACTIVATED,
        metadata: { previousStatus: WarehouseStatus.ACTIVE },
      });
    });

    it('bloquea (409) desactivar el almacén principal sin siquiera consultar dependencias', async () => {
      lockedRow(WarehouseStatus.ACTIVE, true);
      await expect(
        service.deactivate(input({ warehouseId: 'wh-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.warehouseLocation.findMany).not.toHaveBeenCalled();
      expect(prisma.tx.warehouse.update).not.toHaveBeenCalled();
      expect(audit.record).not.toHaveBeenCalled();
    });

    it.each([
      ['saldo distinto de cero', 'stockBalance'],
      ['movimientos', 'inventoryMovement'],
      ['líneas de venta', 'saleItem'],
      ['líneas de recepción', 'purchaseReceiptLine'],
    ] as const)(
      'bloquea (409) si alguna ubicación tiene %s',
      async (_label, key) => {
        lockedRow(WarehouseStatus.ACTIVE);
        prisma.tx[key].count.mockResolvedValue(1);
        await expect(
          service.deactivate(input({ warehouseId: 'wh-1' }) as never),
        ).rejects.toBeInstanceOf(ConflictException);
        expect(prisma.tx.warehouse.update).not.toHaveBeenCalled();
        expect(audit.record).not.toHaveBeenCalled();
      },
    );

    it('solo cuenta saldos distintos de cero como stock', async () => {
      lockedRow(WarehouseStatus.ACTIVE);
      await service.deactivate(input({ warehouseId: 'wh-1' }) as never);
      expect(prisma.tx.stockBalance.count).toHaveBeenCalledWith({
        where: { locationId: { in: ['loc-1'] }, quantity: { not: 0 } },
      });
    });

    it('409 si ya estaba inactivo / ya activo', async () => {
      lockedRow(WarehouseStatus.INACTIVE);
      await expect(
        service.deactivate(input({ warehouseId: 'wh-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
      lockedRow(WarehouseStatus.ACTIVE);
      await expect(
        service.activate(input({ warehouseId: 'wh-1' }) as never),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('activa un almacén inactivo', async () => {
      lockedRow(WarehouseStatus.INACTIVE);
      prisma.tx.warehouse.update.mockResolvedValue(warehouseRow());
      await service.activate(input({ warehouseId: 'wh-1' }) as never);
      expect(audit.record.mock.calls[0][0]).toMatchObject({
        action: AuditAction.WAREHOUSE_ACTIVATED,
        metadata: { previousStatus: WarehouseStatus.INACTIVE },
      });
    });

    it('404 si el almacén no existe', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.deactivate(input({ warehouseId: 'x' }) as never),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([RoleName.WAREHOUSE, RoleName.PURCHASING, RoleName.MANAGEMENT])(
      '%s recibe 403 al activar/desactivar',
      async (requesterRole) => {
        await expect(
          service.deactivate(
            input({ requesterRole, warehouseId: 'wh-1' }) as never,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.activate(
            input({ requesterRole, warehouseId: 'wh-1' }) as never,
          ),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });
});
