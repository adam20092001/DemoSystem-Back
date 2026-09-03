import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { PaymentMethodAccountingDestination, RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { PaymentMethodsService } from './payment-methods.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeMethodRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'pm-1',
    code: 'CASH',
    name: 'Efectivo',
    active: true,
    requiresReference: false,
    affectsCashDrawer: true,
    accountingDestination: PaymentMethodAccountingDestination.CASH,
    sortOrder: 10,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface FindManyArgs {
  where?: Record<string, unknown>;
}
interface FindUniqueArgs {
  where: Record<string, unknown>;
  select?: Record<string, unknown>;
}
interface CreateArgs {
  data: Record<string, unknown>;
}
interface UpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}

function createPrismaMock() {
  const tx = {
    paymentMethod: {
      findUnique: jest.fn<Promise<unknown>, [FindUniqueArgs]>(),
      create: jest.fn<Promise<unknown>, [CreateArgs]>(),
      update: jest.fn<Promise<unknown>, [UpdateArgs]>(),
    },
  };

  return {
    tx,
    paymentMethod: {
      findMany: jest.fn<Promise<unknown[]>, [FindManyArgs]>(),
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

describe('PaymentMethodsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: PaymentMethodsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new PaymentMethodsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('listPaymentMethods — autorización de lectura', () => {
    it('ADMIN: lista solo activos por defecto', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([makeMethodRow()]);

      const result = await service.listPaymentMethods({}, RoleName.ADMIN);

      expect(result).toHaveLength(1);
      expect(prisma.paymentMethod.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: { active: true } }),
      );
    });

    it('MANAGEMENT: también puede leer (solo activos)', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([]);

      await expect(
        service.listPaymentMethods({}, RoleName.MANAGEMENT),
      ).resolves.toEqual([]);
    });

    it('SELLER: también puede leer (solo activos)', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([]);

      await expect(
        service.listPaymentMethods({}, RoleName.SELLER),
      ).resolves.toEqual([]);
    });

    it('WAREHOUSE: ForbiddenException sin consultar Prisma', async () => {
      await expect(
        service.listPaymentMethods({}, RoleName.WAREHOUSE),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.paymentMethod.findMany).not.toHaveBeenCalled();
    });

    it('ADMIN + includeInactive=true: consulta sin filtro de active', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.listPaymentMethods(
        { includeInactive: true },
        RoleName.ADMIN,
      );

      expect(prisma.paymentMethod.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ where: {} }),
      );
    });

    it('MANAGEMENT + includeInactive=true: ForbiddenException, nunca degrada en silencio', async () => {
      await expect(
        service.listPaymentMethods(
          { includeInactive: true },
          RoleName.MANAGEMENT,
        ),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.paymentMethod.findMany).not.toHaveBeenCalled();
    });

    it('SELLER + includeInactive=true: ForbiddenException', async () => {
      await expect(
        service.listPaymentMethods({ includeInactive: true }, RoleName.SELLER),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('ordena por sortOrder ASC, name ASC, code ASC', async () => {
      prisma.paymentMethod.findMany.mockResolvedValue([]);

      await service.listPaymentMethods({}, RoleName.ADMIN);

      expect(prisma.paymentMethod.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          orderBy: [{ sortOrder: 'asc' }, { name: 'asc' }, { code: 'asc' }],
        }),
      );
    });
  });

  describe('createPaymentMethod', () => {
    const baseInput = {
      code: 'yape',
      name: '  Yape  ',
      requiresReference: true,
      affectsCashDrawer: false,
      accountingDestination: PaymentMethodAccountingDestination.BANK,
      requesterRole: RoleName.ADMIN,
      actorUserId: ACTOR_ID,
    };

    it('ADMIN: normaliza code a mayúsculas, name con trim, crea active=true y audita PAYMENT_METHOD_CREATED', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(null);
      prisma.tx.paymentMethod.create.mockResolvedValue(
        makeMethodRow({
          id: 'pm-2',
          code: 'YAPE',
          name: 'Yape',
          active: true,
          requiresReference: true,
          affectsCashDrawer: false,
          accountingDestination: PaymentMethodAccountingDestination.BANK,
          sortOrder: 0,
        }),
      );

      const result = await service.createPaymentMethod(baseInput);

      const createCall = prisma.tx.paymentMethod.create.mock.calls[0]?.[0];
      expect(createCall?.data).toEqual({
        code: 'YAPE',
        name: 'Yape',
        active: true,
        requiresReference: true,
        affectsCashDrawer: false,
        accountingDestination: PaymentMethodAccountingDestination.BANK,
        sortOrder: 0,
      });
      expect(result.code).toBe('YAPE');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAYMENT_METHOD_CREATED',
          entityType: 'PaymentMethod',
        }),
      );
      const auditCall = auditService.record.mock.calls[0]?.[0] as {
        metadata: { code: string; name: string };
      };
      expect(auditCall.metadata.code).toBe('YAPE');
      expect(auditCall.metadata.name).toBe('Yape');
    });

    it('SELLER: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.createPaymentMethod({
          ...baseInput,
          requesterRole: RoleName.SELLER,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('MANAGEMENT: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.createPaymentMethod({
          ...baseInput,
          requesterRole: RoleName.MANAGEMENT,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('code con formato inválido -> BadRequestException', async () => {
      await expect(
        service.createPaymentMethod({ ...baseInput, code: '1INVALID' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('code de un solo carácter -> BadRequestException', async () => {
      await expect(
        service.createPaymentMethod({ ...baseInput, code: 'x' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('code duplicado -> ConflictException', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(makeMethodRow());

      await expect(
        service.createPaymentMethod(baseInput),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.paymentMethod.create).not.toHaveBeenCalled();
    });

    it('name en blanco tras trim -> BadRequestException', async () => {
      await expect(
        service.createPaymentMethod({ ...baseInput, name: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sortOrder negativo -> BadRequestException', async () => {
      await expect(
        service.createPaymentMethod({ ...baseInput, sortOrder: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('sortOrder omitido -> default 0', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(null);
      prisma.tx.paymentMethod.create.mockResolvedValue(
        makeMethodRow({ sortOrder: 0 }),
      );

      await service.createPaymentMethod(baseInput);

      const createCall = prisma.tx.paymentMethod.create.mock.calls[0]?.[0] as {
        data: { sortOrder: number };
      };
      expect(createCall.data.sortOrder).toBe(0);
    });
  });

  describe('updatePaymentMethod', () => {
    const baseInput = {
      paymentMethodId: 'pm-1',
      requesterRole: RoleName.ADMIN,
      actorUserId: ACTOR_ID,
    };

    it('ADMIN: actualiza name y audita PAYMENT_METHOD_UPDATED con changedFields/oldValues/newValues', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ name: 'Efectivo' }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({ name: 'Efectivo (caja)' }),
      );

      const result = await service.updatePaymentMethod({
        ...baseInput,
        name: 'Efectivo (caja)',
      });

      expect(result.name).toBe('Efectivo (caja)');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'PAYMENT_METHOD_UPDATED',
          entityType: 'PaymentMethod',
          metadata: {
            code: 'CASH',
            changedFields: ['name'],
            oldValues: { name: 'Efectivo' },
            newValues: { name: 'Efectivo (caja)' },
          },
        }),
      );
    });

    it('SELLER: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.updatePaymentMethod({
          ...baseInput,
          requesterRole: RoleName.SELLER,
          name: 'X',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('MANAGEMENT: ForbiddenException sin abrir transacción', async () => {
      await expect(
        service.updatePaymentMethod({
          ...baseInput,
          requesterRole: RoleName.MANAGEMENT,
          name: 'X',
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('body vacío -> BadRequestException sin abrir transacción', async () => {
      await expect(
        service.updatePaymentMethod(baseInput),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('id inexistente -> NotFoundException', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(null);

      await expect(
        service.updatePaymentMethod({ ...baseInput, name: 'X' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('requiresReference update', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ requiresReference: false }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({ requiresReference: true }),
      );

      const result = await service.updatePaymentMethod({
        ...baseInput,
        requiresReference: true,
      });

      expect(result.requiresReference).toBe(true);
      expect(prisma.tx.paymentMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: { requiresReference: true },
        }),
      );
    });

    it('affectsCashDrawer update', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ affectsCashDrawer: true }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({ affectsCashDrawer: false }),
      );

      await service.updatePaymentMethod({
        ...baseInput,
        affectsCashDrawer: false,
      });

      expect(prisma.tx.paymentMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { affectsCashDrawer: false } }),
      );
    });

    it('accountingDestination update', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({
          accountingDestination: PaymentMethodAccountingDestination.CASH,
        }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({
          accountingDestination: PaymentMethodAccountingDestination.BANK,
        }),
      );

      await service.updatePaymentMethod({
        ...baseInput,
        accountingDestination: PaymentMethodAccountingDestination.BANK,
      });

      expect(prisma.tx.paymentMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: {
            accountingDestination: PaymentMethodAccountingDestination.BANK,
          },
        }),
      );
    });

    it('sortOrder update', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ sortOrder: 10 }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({ sortOrder: 25 }),
      );

      await service.updatePaymentMethod({ ...baseInput, sortOrder: 25 });

      expect(prisma.tx.paymentMethod.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { sortOrder: 25 } }),
      );
    });

    it('sortOrder negativo -> BadRequestException', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ sortOrder: 10 }),
      );

      await expect(
        service.updatePaymentMethod({ ...baseInput, sortOrder: -1 }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.paymentMethod.update).not.toHaveBeenCalled();
    });

    it('desactivar (active true->false) audita PAYMENT_METHOD_DEACTIVATED', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ active: true }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({ active: false }),
      );

      const result = await service.updatePaymentMethod({
        ...baseInput,
        active: false,
      });

      expect(result.active).toBe(false);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_METHOD_DEACTIVATED' }),
      );
    });

    it('reactivar (active false->true) audita PAYMENT_METHOD_ACTIVATED', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ active: false }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({ active: true }),
      );

      const result = await service.updatePaymentMethod({
        ...baseInput,
        active: true,
      });

      expect(result.active).toBe(true);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_METHOD_ACTIVATED' }),
      );
    });

    it('active transiciona junto con otros campos en el mismo PATCH: UNA sola fila ACTIVATED/DEACTIVATED, nunca una UPDATED adicional', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ active: true, name: 'Efectivo', sortOrder: 10 }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({
          active: false,
          name: 'Efectivo (legacy)',
          sortOrder: 999,
        }),
      );

      await service.updatePaymentMethod({
        ...baseInput,
        active: false,
        name: 'Efectivo (legacy)',
        sortOrder: 999,
      });

      expect(auditService.record).toHaveBeenCalledTimes(1);
      const auditCall = auditService.record.mock.calls[0]?.[0] as {
        action: string;
        metadata: { changedFields: string[] };
      };
      expect(auditCall.action).toBe('PAYMENT_METHOD_DEACTIVATED');
      expect(auditCall.metadata.changedFields.sort()).toEqual(
        ['active', 'name', 'sortOrder'].sort(),
      );
    });

    it('active reenviado con el mismo valor ya vigente no cuenta como transición (queda como UPDATED si algo más cambió)', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ active: true, name: 'Efectivo' }),
      );
      prisma.tx.paymentMethod.update.mockResolvedValue(
        makeMethodRow({ active: true, name: 'Efectivo (caja)' }),
      );

      await service.updatePaymentMethod({
        ...baseInput,
        active: true,
        name: 'Efectivo (caja)',
      });

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'PAYMENT_METHOD_UPDATED' }),
      );
    });

    it('no-op real (mismos valores ya vigentes): no escribe ni audita, devuelve el recurso actual', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(
        makeMethodRow({ name: 'Efectivo', sortOrder: 10 }),
      );

      const result = await service.updatePaymentMethod({
        ...baseInput,
        name: 'Efectivo',
        sortOrder: 10,
      });

      expect(result.name).toBe('Efectivo');
      expect(prisma.tx.paymentMethod.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('name en blanco tras trim -> BadRequestException', async () => {
      prisma.tx.paymentMethod.findUnique.mockResolvedValue(makeMethodRow());

      await expect(
        service.updatePaymentMethod({ ...baseInput, name: '   ' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.tx.paymentMethod.update).not.toHaveBeenCalled();
    });

    it('code NUNCA participa: UpdatePaymentMethodInput no declara ese campo (verificación de tipos en compilación)', () => {
      const input: Parameters<typeof service.updatePaymentMethod>[0] = {
        ...baseInput,
        name: 'X',
      };
      expect('code' in input).toBe(false);
    });
  });
});
