import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RoleName, UnitStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { UnitsService } from './units.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

interface UnitFindUniqueArgs {
  where: { id?: string; code?: string };
}
interface UnitCreateArgs {
  data: Record<string, unknown>;
}
interface UnitUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface UnitFindManyArgs {
  where?: Record<string, unknown>;
  skip?: number;
  take?: number;
}
interface UnitCountArgs {
  where?: Record<string, unknown>;
}
interface ProductCountArgs {
  where?: Record<string, unknown>;
}

function makeUnitRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'unit-1',
    code: 'KG',
    name: 'Kilogramo',
    abbreviation: 'KG',
    allowDecimal: true,
    status: UnitStatus.ACTIVE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    unit: {
      findUnique: jest.fn<Promise<unknown>, [UnitFindUniqueArgs]>(),
      create: jest.fn<Promise<unknown>, [UnitCreateArgs]>(),
      update: jest.fn<Promise<unknown>, [UnitUpdateArgs]>(),
    },
    product: {
      count: jest.fn<Promise<number>, [ProductCountArgs?]>(),
    },
  };

  return {
    tx,
    unit: {
      findUnique: jest.fn<Promise<unknown>, [UnitFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, [UnitFindManyArgs]>(),
      count: jest.fn<Promise<number>, [UnitCountArgs?]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

describe('UnitsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: UnitsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new UnitsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('createUnit', () => {
    const validInput = {
      code: '  kg  ',
      name: '  Kilogramo  ',
      abbreviation: '  kg  ',
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.1',
    };

    beforeEach(() => {
      prisma.tx.unit.create.mockResolvedValue(makeUnitRow());
    });

    it('crea la unidad y devuelve la forma segura', async () => {
      const result = await service.createUnit(validInput);

      expect(result.code).toBe('KG');
      expect(result.status).toBe(UnitStatus.ACTIVE);
    });

    it('normaliza code y abbreviation (trim+uppercase) y name (trim)', async () => {
      await service.createUnit(validInput);

      const createArgs = prisma.tx.unit.create.mock.calls[0][0];
      expect(createArgs.data.code).toBe('KG');
      expect(createArgs.data.name).toBe('Kilogramo');
      expect(createArgs.data.abbreviation).toBe('KG');
      expect(createArgs.data.status).toBe(UnitStatus.ACTIVE);
    });

    it('allowDecimal por defecto es false cuando no se envía', async () => {
      await service.createUnit(validInput);

      const createArgs = prisma.tx.unit.create.mock.calls[0][0];
      expect(createArgs.data.allowDecimal).toBe(false);
    });

    it('respeta allowDecimal cuando se envía explícito', async () => {
      await service.createUnit({ ...validInput, allowDecimal: true });

      const createArgs = prisma.tx.unit.create.mock.calls[0][0];
      expect(createArgs.data.allowDecimal).toBe(true);
    });

    it('propaga sin capturar un error de código duplicado', async () => {
      prisma.tx.unit.create.mockRejectedValue(new Error('P2002 simulado'));

      await expect(service.createUnit(validInput)).rejects.toThrow(
        'P2002 simulado',
      );
    });

    it('registra UNIT_CREATED dentro de la misma transacción', async () => {
      await service.createUnit(validInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UNIT_CREATED,
          userId: ACTOR_ID,
          client: prisma.tx,
        }),
      );
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(service.createUnit(validInput)).rejects.toThrow(
        'fallo de auditoría',
      );
      expect(prisma.tx.unit.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('updateUnit', () => {
    it('rechaza un update sin ningún campo con BadRequestException', async () => {
      await expect(
        service.updateUnit({ unitId: 'unit-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('edita correctamente y registra UNIT_UPDATED', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue({ id: 'unit-1', code: 'KG' });
      prisma.tx.unit.update.mockResolvedValue(
        makeUnitRow({ name: 'Kilogramos' }),
      );

      const result = await service.updateUnit({
        unitId: 'unit-1',
        name: '  Kilogramos  ',
        actorUserId: ACTOR_ID,
      });

      expect(result.name).toBe('Kilogramos');
      const updateArgs = prisma.tx.unit.update.mock.calls[0][0];
      expect(updateArgs.data.name).toBe('Kilogramos');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.UNIT_UPDATED,
          metadata: { updatedFields: ['name'] },
        }),
      );
    });

    it('lanza NotFoundException si la unidad no existe', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue(null);

      await expect(
        service.updateUnit({
          unitId: 'missing',
          name: 'Cualquiera',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('activateUnit', () => {
    it('activa correctamente y registra UNIT_ACTIVATED', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue({
        id: 'unit-1',
        code: 'KG',
        status: UnitStatus.INACTIVE,
      });
      prisma.tx.unit.update.mockResolvedValue(makeUnitRow());

      const result = await service.activateUnit({
        unitId: 'unit-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UnitStatus.ACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.UNIT_ACTIVATED }),
      );
    });

    it('lanza ConflictException si ya está activa', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue({
        id: 'unit-1',
        code: 'KG',
        status: UnitStatus.ACTIVE,
      });

      await expect(
        service.activateUnit({ unitId: 'unit-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue(null);

      await expect(
        service.activateUnit({ unitId: 'missing', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('deactivateUnit', () => {
    it('desactiva correctamente y registra UNIT_DEACTIVATED', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue({
        id: 'unit-1',
        code: 'KG',
        status: UnitStatus.ACTIVE,
      });
      prisma.tx.product.count.mockResolvedValue(0);
      prisma.tx.unit.update.mockResolvedValue(
        makeUnitRow({ status: UnitStatus.INACTIVE }),
      );

      const result = await service.deactivateUnit({
        unitId: 'unit-1',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UnitStatus.INACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.UNIT_DEACTIVATED }),
      );
    });

    it('lanza ConflictException si ya está inactiva', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue({
        id: 'unit-1',
        code: 'KG',
        status: UnitStatus.INACTIVE,
      });

      await expect(
        service.deactivateUnit({ unitId: 'unit-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('bloquea la desactivación si existe al menos un producto ACTIVE', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue({
        id: 'unit-1',
        code: 'KG',
        status: UnitStatus.ACTIVE,
      });
      prisma.tx.product.count.mockResolvedValue(1);

      await expect(
        service.deactivateUnit({ unitId: 'unit-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.unit.update).not.toHaveBeenCalled();
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.tx.unit.findUnique.mockResolvedValue(null);

      await expect(
        service.deactivateUnit({ unitId: 'missing', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('listUnits', () => {
    it('devuelve una respuesta paginada con los defaults', async () => {
      prisma.unit.findMany.mockResolvedValue([makeUnitRow()]);
      prisma.unit.count.mockResolvedValue(1);

      const result = await service.listUnits({}, RoleName.ADMIN);

      expect(result).toEqual({
        data: [expect.objectContaining({ id: 'unit-1' })],
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(prisma.unit.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          skip: 0,
          take: 20,
          orderBy: { code: 'asc' },
        }),
      );
    });

    it('filtra por allowDecimal cuando se especifica', async () => {
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.unit.count.mockResolvedValue(0);

      await service.listUnits({ allowDecimal: true }, RoleName.ADMIN);

      const args = prisma.unit.findMany.mock.calls[0][0];
      expect(args.where?.allowDecimal).toBe(true);
    });

    it('SELLER siempre ve solo ACTIVE, aunque pida status=INACTIVE', async () => {
      prisma.unit.findMany.mockResolvedValue([]);
      prisma.unit.count.mockResolvedValue(0);

      await service.listUnits({ status: UnitStatus.INACTIVE }, RoleName.SELLER);

      const args = prisma.unit.findMany.mock.calls[0][0];
      expect(args.where?.status).toBe(UnitStatus.ACTIVE);
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s puede pedir explícitamente status=INACTIVE',
      async (role) => {
        prisma.unit.findMany.mockResolvedValue([]);
        prisma.unit.count.mockResolvedValue(0);

        await service.listUnits({ status: UnitStatus.INACTIVE }, role);

        const args = prisma.unit.findMany.mock.calls[0][0];
        expect(args.where?.status).toBe(UnitStatus.INACTIVE);
      },
    );
  });

  describe('findUnitById', () => {
    it('devuelve la unidad si existe', async () => {
      prisma.unit.findUnique.mockResolvedValue(makeUnitRow());

      const result = await service.findUnitById('unit-1', RoleName.ADMIN);

      expect(result.id).toBe('unit-1');
    });

    it('lanza NotFoundException si no existe', async () => {
      prisma.unit.findUnique.mockResolvedValue(null);

      await expect(
        service.findUnitById('missing', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('oculta una unidad INACTIVE a SELLER con 404', async () => {
      prisma.unit.findUnique.mockResolvedValue(
        makeUnitRow({ status: UnitStatus.INACTIVE }),
      );

      await expect(
        service.findUnitById('unit-1', RoleName.SELLER),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it.each([RoleName.ADMIN, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s sí puede ver el detalle de una unidad INACTIVE',
      async (role) => {
        prisma.unit.findUnique.mockResolvedValue(
          makeUnitRow({ status: UnitStatus.INACTIVE }),
        );

        const result = await service.findUnitById('unit-1', role);

        expect(result.status).toBe(UnitStatus.INACTIVE);
      },
    );
  });
});
