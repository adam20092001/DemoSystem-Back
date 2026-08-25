import {
  BadRequestException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { RoleName } from '@prisma/client';
import { PrismaService } from '../database/prisma.service';
import { AuditAction } from './audit-action.enum';
import { AuditQueryService } from './audit-query.service';

const NOW = new Date('2026-03-15T10:00:00.000Z');

function makeListRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'audit-1',
    user: {
      id: 'user-1',
      username: 'admin',
      firstName: 'Ana',
      lastName: 'Diaz',
    },
    module: 'CONFIGURATION',
    action: AuditAction.CONFIGURATION_UPDATED,
    entityType: 'CompanySettings',
    entityId: 'settings-1',
    description: 'Configuración de la empresa actualizada',
    createdAt: NOW,
    ...overrides,
  };
}

function makeDetailRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    ...makeListRow(),
    metadata: { changedFields: ['businessName'] },
    ipAddress: '203.0.113.5',
    ...overrides,
  };
}

function createPrismaMock() {
  return {
    auditLog: {
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>]>(),
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };
}

describe('AuditQueryService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let service: AuditQueryService;

  beforeEach(() => {
    prisma = createPrismaMock();
    prisma.auditLog.findMany.mockResolvedValue([makeListRow()]);
    prisma.auditLog.count.mockResolvedValue(1);
    prisma.auditLog.findUnique.mockResolvedValue(makeDetailRow());
    service = new AuditQueryService(prisma as unknown as PrismaService);
  });

  describe('list — defensa de rol a nivel de servicio', () => {
    it('ADMIN: consulta normalmente', async () => {
      await expect(service.list({}, RoleName.ADMIN)).resolves.toBeDefined();
      expect(prisma.auditLog.findMany).toHaveBeenCalledTimes(1);
    });

    it('MANAGEMENT: consulta normalmente', async () => {
      await expect(
        service.list({}, RoleName.MANAGEMENT),
      ).resolves.toBeDefined();
    });

    it('SELLER: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(service.list({}, RoleName.SELLER)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
      expect(prisma.auditLog.count).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(service.list({}, RoleName.WAREHOUSE)).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.list({}, 'GUEST' as RoleName),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });
  });

  describe('list — filtros', () => {
    it('aplica from/to/userId/module/action/entityType/entityId combinados', async () => {
      await service.list(
        {
          from: '2026-03-01',
          to: '2026-03-31',
          userId: 'user-1',
          module: 'CONFIGURATION',
          action: AuditAction.CONFIGURATION_UPDATED,
          entityType: 'CompanySettings',
          entityId: 'settings-1',
        },
        RoleName.ADMIN,
      );

      const call = prisma.auditLog.findMany.mock.calls[0][0] as {
        where: { AND: Record<string, unknown>[] };
      };
      expect(call.where.AND).toHaveLength(7);
    });

    it('sin filtros: where vacío', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.auditLog.findMany.mock.calls[0][0] as {
        where: Record<string, unknown>;
      };
      expect(call.where).toEqual({});
    });

    it('usa exactamente el mismo where para count() y findMany()', async () => {
      await service.list({ module: 'SALES' }, RoleName.ADMIN);
      const findManyWhere = prisma.auditLog.findMany.mock.calls[0][0] as {
        where: unknown;
      };
      const countWhere = prisma.auditLog.count.mock.calls[0][0] as {
        where: unknown;
      };
      expect(findManyWhere.where).toEqual(countWhere.where);
    });

    it('from > to -> BadRequestException sin tocar Prisma', async () => {
      await expect(
        service.list({ from: '2026-03-31', to: '2026-03-01' }, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
    });

    it('from == to: permitido (un solo día)', async () => {
      await expect(
        service.list({ from: '2026-03-01', to: '2026-03-01' }, RoleName.ADMIN),
      ).resolves.toBeDefined();
    });

    it('solo from: permitido', async () => {
      await expect(
        service.list({ from: '2026-03-01' }, RoleName.ADMIN),
      ).resolves.toBeDefined();
    });

    it('solo to: permitido', async () => {
      await expect(
        service.list({ to: '2026-03-31' }, RoleName.ADMIN),
      ).resolves.toBeDefined();
    });
  });

  describe('list — paginación y orden', () => {
    it('usa page/limit por defecto (1/20)', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.auditLog.findMany.mock.calls[0][0] as {
        skip: number;
        take: number;
      };
      expect(call.skip).toBe(0);
      expect(call.take).toBe(20);
    });

    it('respeta page/limit provistos', async () => {
      await service.list({ page: 3, limit: 10 }, RoleName.ADMIN);
      const call = prisma.auditLog.findMany.mock.calls[0][0] as {
        skip: number;
        take: number;
      };
      expect(call.skip).toBe(20);
      expect(call.take).toBe(10);
    });

    it('orden fijo createdAt DESC, id DESC', async () => {
      await service.list({}, RoleName.ADMIN);
      const call = prisma.auditLog.findMany.mock.calls[0][0] as {
        orderBy: unknown;
      };
      expect(call.orderBy).toEqual([{ createdAt: 'desc' }, { id: 'desc' }]);
    });

    it('resultado vacío: total 0, totalPages 0', async () => {
      prisma.auditLog.findMany.mockResolvedValue([]);
      prisma.auditLog.count.mockResolvedValue(0);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data).toEqual([]);
      expect(result.total).toBe(0);
      expect(result.totalPages).toBe(0);
    });
  });

  describe('list — mapeo seguro', () => {
    it('nunca expone metadata ni ipAddress en el listado', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0]).not.toHaveProperty('metadata');
      expect(result.data[0]).not.toHaveProperty('ipAddress');
    });

    it('user null se preserva tal cual (login fallido sin actor)', async () => {
      prisma.auditLog.findMany.mockResolvedValue([
        makeListRow({ user: null, entityId: null }),
      ]);
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].user).toBeNull();
    });

    it('user seguro solo con id/username/firstName/lastName', async () => {
      const result = await service.list({}, RoleName.ADMIN);
      expect(result.data[0].user).toEqual({
        id: 'user-1',
        username: 'admin',
        firstName: 'Ana',
        lastName: 'Diaz',
      });
    });
  });

  describe('findOne — defensa de rol a nivel de servicio', () => {
    it('ADMIN: consulta normalmente', async () => {
      await expect(
        service.findOne('audit-1', RoleName.ADMIN),
      ).resolves.toBeDefined();
    });

    it('MANAGEMENT: consulta normalmente', async () => {
      await expect(
        service.findOne('audit-1', RoleName.MANAGEMENT),
      ).resolves.toBeDefined();
    });

    it('SELLER: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.findOne('audit-1', RoleName.SELLER),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.auditLog.findUnique).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: ForbiddenException sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.findOne('audit-1', RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.auditLog.findUnique).not.toHaveBeenCalled();
    });

    it('rol desconocido: falla cerrado sin ejecutar ninguna consulta a Prisma', async () => {
      await expect(
        service.findOne('audit-1', 'GUEST' as RoleName),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.auditLog.findUnique).not.toHaveBeenCalled();
    });
  });

  describe('findOne — política de IP y metadata', () => {
    it('ADMIN: metadata presente e ipAddress real', async () => {
      const result = await service.findOne('audit-1', RoleName.ADMIN);
      expect(result.metadata).toEqual({ changedFields: ['businessName'] });
      expect(result.ipAddress).toBe('203.0.113.5');
    });

    it('MANAGEMENT: misma metadata, ipAddress siempre null', async () => {
      const result = await service.findOne('audit-1', RoleName.MANAGEMENT);
      expect(result.metadata).toEqual({ changedFields: ['businessName'] });
      expect(result.ipAddress).toBeNull();
    });

    it('metadata almacenada como null se devuelve null', async () => {
      prisma.auditLog.findUnique.mockResolvedValue(
        makeDetailRow({ metadata: null }),
      );
      const result = await service.findOne('audit-1', RoleName.ADMIN);
      expect(result.metadata).toBeNull();
    });

    it('ipAddress almacenada como null se devuelve null para ADMIN', async () => {
      prisma.auditLog.findUnique.mockResolvedValue(
        makeDetailRow({ ipAddress: null }),
      );
      const result = await service.findOne('audit-1', RoleName.ADMIN);
      expect(result.ipAddress).toBeNull();
    });

    it('la clave ipAddress siempre está presente para MANAGEMENT, aunque el valor real no sea null', async () => {
      const result = await service.findOne('audit-1', RoleName.MANAGEMENT);
      expect(result).toHaveProperty('ipAddress');
      expect(result.ipAddress).toBeNull();
    });

    it('usuario seguro solo con id/username/firstName/lastName', async () => {
      const result = await service.findOne('audit-1', RoleName.ADMIN);
      expect(result.user).toEqual({
        id: 'user-1',
        username: 'admin',
        firstName: 'Ana',
        lastName: 'Diaz',
      });
    });
  });

  describe('findOne — no encontrado', () => {
    it('id inexistente -> NotFoundException', async () => {
      prisma.auditLog.findUnique.mockResolvedValue(null);
      await expect(
        service.findOne('missing-id', RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
