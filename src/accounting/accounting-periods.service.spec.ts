import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccountingPeriodStatus, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { AccountingPeriodsService } from './accounting-periods.service';

const ACTOR_ID = 'actor-id';
const PERIOD_ID = 'period-1';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makePeriodRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: PERIOD_ID,
    year: 2026,
    month: 3,
    status: AccountingPeriodStatus.OPEN,
    lastJournalNumber: 0,
    closedAt: null,
    closedBy: null,
    reopenedAt: null,
    reopenedBy: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createTxMock() {
  return {
    accountingPeriod: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    accountingPeriod: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>?]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createAuditServiceMock() {
  return { record: jest.fn<Promise<void>, [Record<string, unknown>]>() };
}

describe('AccountingPeriodsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: AccountingPeriodsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new AccountingPeriodsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('permisos', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer: ForbiddenException sin tocar Prisma',
      async (role) => {
        await expect(service.listPeriods({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(prisma.accountingPeriod.findMany).not.toHaveBeenCalled();
      },
    );

    it('MANAGEMENT puede leer pero no escribir', async () => {
      prisma.accountingPeriod.findMany.mockResolvedValue([]);
      prisma.accountingPeriod.count.mockResolvedValue(0);
      await expect(
        service.listPeriods({}, RoleName.MANAGEMENT),
      ).resolves.toBeDefined();

      await expect(
        service.createPeriod({
          year: 2026,
          month: 5,
          requesterRole: RoleName.MANAGEMENT,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it.each([RoleName.SELLER, RoleName.WAREHOUSE, RoleName.MANAGEMENT])(
      '%s no puede cerrar/reabrir/crear periodos',
      async (role) => {
        await expect(
          service.closePeriod({
            periodId: PERIOD_ID,
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        await expect(
          service.reopenPeriod({
            periodId: PERIOD_ID,
            requesterRole: role,
            actorUserId: ACTOR_ID,
            ipAddress: null,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('createPeriod', () => {
    it('year/month fuera de rango -> BadRequestException', async () => {
      await expect(
        service.createPeriod({
          year: 2026,
          month: 13,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ya existe el periodo -> ConflictException, sin crear nada', async () => {
      prisma.tx.accountingPeriod.findUnique.mockResolvedValue(makePeriodRow());
      await expect(
        service.createPeriod({
          year: 2026,
          month: 3,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.accountingPeriod.create).not.toHaveBeenCalled();
    });

    it('crea el periodo OPEN y audita ACCOUNTING_PERIOD_OPENED exactamente una vez', async () => {
      prisma.tx.accountingPeriod.findUnique.mockResolvedValue(null);
      prisma.tx.accountingPeriod.create.mockResolvedValue(makePeriodRow());

      const result = await service.createPeriod({
        year: 2026,
        month: 3,
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: '10.0.0.1',
      });

      expect(result.status).toBe(AccountingPeriodStatus.OPEN);
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const call = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
      };
      expect(call.action).toBe(AuditAction.ACCOUNTING_PERIOD_OPENED);
      expect(call.metadata).toEqual({ year: 2026, month: 3 });
    });
  });

  describe('closePeriod', () => {
    it('no existe -> NotFoundException', async () => {
      prisma.tx.accountingPeriod.findUnique.mockResolvedValue(null);
      await expect(
        service.closePeriod({
          periodId: PERIOD_ID,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('ya está CLOSED -> ConflictException', async () => {
      prisma.tx.accountingPeriod.findUnique.mockResolvedValue(
        makePeriodRow({ status: AccountingPeriodStatus.CLOSED }),
      );
      await expect(
        service.closePeriod({
          periodId: PERIOD_ID,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.accountingPeriod.update).not.toHaveBeenCalled();
    });

    it('OPEN -> CLOSED: audita ACCOUNTING_PERIOD_CLOSED con year/month', async () => {
      prisma.tx.accountingPeriod.findUnique.mockResolvedValue(makePeriodRow());
      prisma.tx.accountingPeriod.update.mockResolvedValue(
        makePeriodRow({ status: AccountingPeriodStatus.CLOSED }),
      );

      const result = await service.closePeriod({
        periodId: PERIOD_ID,
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });

      expect(result.status).toBe(AccountingPeriodStatus.CLOSED);
      const updateCall = prisma.tx.accountingPeriod.update.mock.calls[0][0] as {
        data: { status: AccountingPeriodStatus };
      };
      expect(updateCall.data.status).toBe(AccountingPeriodStatus.CLOSED);
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const auditCall = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
        metadata: Record<string, unknown>;
      };
      expect(auditCall.action).toBe(AuditAction.ACCOUNTING_PERIOD_CLOSED);
      expect(auditCall.metadata).toEqual({ year: 2026, month: 3 });
    });
  });

  describe('reopenPeriod', () => {
    it('ya está OPEN -> ConflictException', async () => {
      prisma.tx.accountingPeriod.findUnique.mockResolvedValue(
        makePeriodRow({ status: AccountingPeriodStatus.OPEN }),
      );
      await expect(
        service.reopenPeriod({
          periodId: PERIOD_ID,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
          ipAddress: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('CLOSED -> OPEN: audita ACCOUNTING_PERIOD_REOPENED, nunca limpia closedAt/closedBy previos', async () => {
      prisma.tx.accountingPeriod.findUnique.mockResolvedValue(
        makePeriodRow({
          status: AccountingPeriodStatus.CLOSED,
          closedAt: NOW,
          closedBy: { id: 'other-admin' },
        }),
      );
      prisma.tx.accountingPeriod.update.mockResolvedValue(
        makePeriodRow({
          status: AccountingPeriodStatus.OPEN,
          closedAt: NOW,
          closedBy: { id: 'other-admin' },
          reopenedAt: NOW,
        }),
      );

      const result = await service.reopenPeriod({
        periodId: PERIOD_ID,
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
        ipAddress: null,
      });

      expect(result.status).toBe(AccountingPeriodStatus.OPEN);
      expect(result.closedAt).toBe(NOW);
      const updateCall = prisma.tx.accountingPeriod.update.mock.calls[0][0] as {
        data: { status: AccountingPeriodStatus; closedAt?: unknown };
      };
      expect(updateCall.data.status).toBe(AccountingPeriodStatus.OPEN);
      expect(updateCall.data.closedAt).toBeUndefined();
      expect(auditService.record).toHaveBeenCalledTimes(1);
      const auditCall = auditService.record.mock.calls[0][0] as {
        action: AuditAction;
      };
      expect(auditCall.action).toBe(AuditAction.ACCOUNTING_PERIOD_REOPENED);
    });
  });

  describe('findPeriodById', () => {
    it('no existe -> NotFoundException', async () => {
      prisma.accountingPeriod.findUnique.mockResolvedValue(null);
      await expect(
        service.findPeriodById(PERIOD_ID, RoleName.ADMIN),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('existe -> lo devuelve mapeado', async () => {
      prisma.accountingPeriod.findUnique.mockResolvedValue(makePeriodRow());
      const result = await service.findPeriodById(PERIOD_ID, RoleName.ADMIN);
      expect(result.id).toBe(PERIOD_ID);
    });
  });
});
