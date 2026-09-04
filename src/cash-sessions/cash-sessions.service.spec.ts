import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { CashSessionStatus, Prisma, RoleName } from '@prisma/client';
import { AuditService } from '../audit/audit.service';
import {
  endOfBusinessDayExclusiveUtc,
  startOfBusinessDayUtc,
} from '../common/date/business-date';
import type { AuthenticatedUser } from '../common/types/authenticated-user';
import { PrismaService } from '../database/prisma.service';
import { CashSessionsService } from './cash-sessions.service';

const NOW = new Date('2026-03-15T10:00:00.000Z');

function makeSessionRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'cs-1',
    userId: 'user-1',
    status: CashSessionStatus.OPEN,
    openingAmount: new Prisma.Decimal('100.00'),
    openedAt: NOW,
    closeRequestedAt: null,
    expectedCashAmount: null,
    countedCashAmount: null,
    differenceAmount: null,
    closingObservation: null,
    closedAt: null,
    approvedByUserId: null,
    approvedAt: null,
    approvalComment: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function makeActor(
  overrides: Partial<AuthenticatedUser> = {},
): AuthenticatedUser {
  return {
    id: 'user-1',
    firstName: 'Ana',
    lastName: 'Actor',
    username: 'actor',
    email: 'actor@demosystem.local',
    role: RoleName.SELLER,
    status: 'ACTIVE',
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

interface FindFirstArgs {
  where?: Record<string, unknown>;
}
interface CreateArgs {
  data: Record<string, unknown>;
}
interface FindManyArgs {
  where?: Record<string, unknown>;
  orderBy?: unknown;
  skip?: number;
  take?: number;
}
interface UpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}

function makeSummaryRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    paymentMethodId: 'pm-cash',
    paymentMethodCode: 'CASH',
    paymentMethodName: 'Efectivo',
    totalAmount: new Prisma.Decimal('200.00'),
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    cashSession: {
      findFirst: jest.fn<Promise<unknown>, [FindFirstArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [FindFirstArgs]>(),
      findUniqueOrThrow: jest.fn<Promise<unknown>, [FindFirstArgs]>(),
      create: jest.fn<Promise<unknown>, [CreateArgs]>(),
      update: jest.fn<Promise<unknown>, [UpdateArgs]>(),
    },
    payment: {
      findMany: jest
        .fn<Promise<unknown[]>, [FindManyArgs]>()
        .mockResolvedValue([]),
    },
    cashSessionPaymentMethodSummary: {
      deleteMany: jest.fn<Promise<unknown>, [FindManyArgs]>(),
      createMany: jest.fn<Promise<unknown>, [{ data: unknown[] }]>(),
    },
    $queryRaw: jest.fn<Promise<unknown[]>, [unknown]>(),
    $executeRaw: jest.fn<Promise<number>, [unknown]>(),
  };

  return {
    tx,
    cashSession: {
      findFirst: jest.fn<Promise<unknown>, [FindFirstArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, [FindManyArgs]>(),
      count: jest.fn<Promise<number>, [FindManyArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [FindFirstArgs]>(),
    },
    payment: {
      findMany: jest
        .fn<Promise<unknown[]>, [FindManyArgs]>()
        .mockResolvedValue([]),
    },
    cashSessionPaymentMethodSummary: {
      findMany: jest
        .fn<Promise<unknown[]>, [FindManyArgs]>()
        .mockResolvedValue([]),
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

describe('CashSessionsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: CashSessionsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new CashSessionsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  // ==================================================================
  // open()
  // ==================================================================
  describe('open', () => {
    it('ADMIN abre con openingAmount=0: éxito, audita CASH_SESSION_OPENED', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(null);
      prisma.tx.cashSession.create.mockResolvedValue(
        makeSessionRow({ openingAmount: new Prisma.Decimal('0.00') }),
      );

      const result = await service.open({
        openingAmount: '0',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'user-1',
        ipAddress: '127.0.0.1',
      });

      expect(result.openingAmount).toBe('0.00');
      const createCall = prisma.tx.cashSession.create.mock.calls[0]?.[0] as {
        data: { userId: string; status: string };
      };
      expect(createCall.data.userId).toBe('user-1');
      expect(createCall.data.status).toBe(CashSessionStatus.OPEN);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CASH_SESSION_OPENED',
          entityType: 'CashSession',
          userId: 'user-1',
        }),
      );
      const auditCall = auditService.record.mock.calls[0]?.[0] as {
        metadata: {
          cashSessionId: string;
          userId: string;
          openingAmount: string;
        };
      };
      expect(auditCall.metadata.cashSessionId).toBe('cs-1');
      expect(auditCall.metadata.userId).toBe('user-1');
      expect(auditCall.metadata.openingAmount).toBe('0.00');
    });

    it('ADMIN abre con openingAmount positivo: éxito', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(null);
      prisma.tx.cashSession.create.mockResolvedValue(makeSessionRow());

      const result = await service.open({
        openingAmount: '250.50',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'user-1',
      });
      expect(result.id).toBe('cs-1');
    });

    it('SELLER abre con openingAmount=0: éxito', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(null);
      prisma.tx.cashSession.create.mockResolvedValue(
        makeSessionRow({ openingAmount: new Prisma.Decimal('0.00') }),
      );

      const result = await service.open({
        openingAmount: '0.00',
        requesterRole: RoleName.SELLER,
        actorUserId: 'user-1',
      });
      expect(result.openingAmount).toBe('0.00');
    });

    it('SELLER abre con openingAmount positivo: éxito', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(null);
      prisma.tx.cashSession.create.mockResolvedValue(makeSessionRow());

      const result = await service.open({
        openingAmount: '50.00',
        requesterRole: RoleName.SELLER,
        actorUserId: 'user-1',
      });
      expect(result.id).toBe('cs-1');
    });

    it('openingAmount negativo: 400, sin tocar Prisma', async () => {
      await expect(
        service.open({
          openingAmount: '-10.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('MANAGEMENT: 403, sin tocar Prisma', async () => {
      await expect(
        service.open({
          openingAmount: '10.00',
          requesterRole: RoleName.MANAGEMENT,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: 403, sin tocar Prisma', async () => {
      await expect(
        service.open({
          openingAmount: '10.00',
          requesterRole: RoleName.WAREHOUSE,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('ya existe una sesión OPEN: 409, sin crear, sin auditar', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.OPEN }),
      );

      await expect(
        service.open({
          openingAmount: '10.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.tx.cashSession.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('ya existe una sesión PENDING_APPROVAL: 409, sin crear, sin auditar', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.PENDING_APPROVAL }),
      );

      await expect(
        service.open({
          openingAmount: '10.00',
          requesterRole: RoleName.SELLER,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.tx.cashSession.create).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('P2002 de Postgres (carrera real) se traduce a 409, sin auditar', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(null);
      const p2002 = new Prisma.PrismaClientKnownRequestError(
        'Unique constraint failed',
        { code: 'P2002', clientVersion: '6.0.0' },
      );
      prisma.tx.cashSession.create.mockRejectedValue(p2002);

      await expect(
        service.open({
          openingAmount: '10.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('un error Prisma que NO es P2002 se propaga tal cual', async () => {
      prisma.tx.cashSession.findFirst.mockResolvedValue(null);
      const other = new Prisma.PrismaClientKnownRequestError('Other error', {
        code: 'P2003',
        clientVersion: '6.0.0',
      });
      prisma.tx.cashSession.create.mockRejectedValue(other);

      await expect(
        service.open({
          openingAmount: '10.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toBe(other);
    });
  });

  // ==================================================================
  // close()
  // ==================================================================
  describe('close', () => {
    function mockLockedOpenSession(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      prisma.tx.$queryRaw.mockResolvedValue([
        {
          id: 'cs-1',
          userId: 'user-1',
          status: CashSessionStatus.OPEN,
          openingAmount: new Prisma.Decimal('100.00'),
          ...overrides,
        },
      ]);
    }

    beforeEach(() => {
      prisma.tx.cashSessionPaymentMethodSummary.deleteMany.mockResolvedValue({
        count: 0,
      });
      prisma.tx.cashSessionPaymentMethodSummary.createMany.mockResolvedValue({
        count: 0,
      });
    });

    it('ADMIN, diferencia cero -> CLOSED, audita CASH_SESSION_CLOSED', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([]);
      prisma.tx.cashSession.update.mockResolvedValue(
        makeSessionRow({
          status: CashSessionStatus.CLOSED,
          expectedCashAmount: new Prisma.Decimal('100.00'),
          countedCashAmount: new Prisma.Decimal('100.00'),
          differenceAmount: new Prisma.Decimal('0.00'),
          closedAt: NOW,
        }),
      );

      const result = await service.close({
        countedCashAmount: '100.00',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'user-1',
      });

      expect(result.status).toBe(CashSessionStatus.CLOSED);
      const updateCall = prisma.tx.cashSession.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(CashSessionStatus.CLOSED);
      expect(updateCall.data.approvedByUserId).toBeUndefined();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: 'CASH_SESSION_CLOSED' }),
      );
    });

    it('SELLER, diferencia cero -> CLOSED', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([]);
      prisma.tx.cashSession.update.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      const result = await service.close({
        countedCashAmount: '100.00',
        requesterRole: RoleName.SELLER,
        actorUserId: 'user-1',
      });
      expect(result.status).toBe(CashSessionStatus.CLOSED);
    });

    it('MANAGEMENT: 403, sin tocar Prisma', async () => {
      await expect(
        service.close({
          countedCashAmount: '100.00',
          requesterRole: RoleName.MANAGEMENT,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: 403, sin tocar Prisma', async () => {
      await expect(
        service.close({
          countedCashAmount: '100.00',
          requesterRole: RoleName.WAREHOUSE,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('sin caja sin resolver -> 404', async () => {
      prisma.tx.$queryRaw.mockResolvedValue([]);
      await expect(
        service.close({
          countedCashAmount: '100.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('caja PENDING_APPROVAL -> 409, no puede volver a cerrarse', async () => {
      mockLockedOpenSession({ status: CashSessionStatus.PENDING_APPROVAL });
      await expect(
        service.close({
          countedCashAmount: '100.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.tx.cashSession.update).not.toHaveBeenCalled();
    });

    it('countedCashAmount negativo -> 400, sin tocar Prisma', async () => {
      await expect(
        service.close({
          countedCashAmount: '-1.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('descuadre sin closingObservation -> 400', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([]);
      await expect(
        service.close({
          countedCashAmount: '90.00',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.tx.cashSession.update).not.toHaveBeenCalled();
    });

    it('descuadre con closingObservation en blanco -> 400', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([]);
      await expect(
        service.close({
          countedCashAmount: '90.00',
          closingObservation: '   ',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'user-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('descuadre con closingObservation válida -> PENDING_APPROVAL, audita CASH_SESSION_CLOSING_REQUESTED', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([]);
      prisma.tx.cashSession.update.mockResolvedValue(
        makeSessionRow({
          status: CashSessionStatus.PENDING_APPROVAL,
          differenceAmount: new Prisma.Decimal('-10.00'),
        }),
      );

      const result = await service.close({
        countedCashAmount: '90.00',
        closingObservation: 'Faltante justificado',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'user-1',
      });

      expect(result.status).toBe(CashSessionStatus.PENDING_APPROVAL);
      const updateCall = prisma.tx.cashSession.update.mock.calls[0][0];
      expect(updateCall.data.status).toBe(CashSessionStatus.PENDING_APPROVAL);
      expect(updateCall.data.closedAt).toBeUndefined();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CASH_SESSION_CLOSING_REQUESTED',
        }),
      );
    });

    it('crea una fila de resumen por método efectivamente representado', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([
        {
          amount: new Prisma.Decimal('100.00'),
          status: 'ACTIVE',
          paymentMethodId: 'pm-cash',
          paymentMethodCode: 'CASH',
          paymentMethodName: 'Efectivo',
          paymentMethodAffectsCashDrawer: true,
        },
      ]);
      prisma.tx.cashSession.update.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      await service.close({
        countedCashAmount: '200.00',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'user-1',
      });

      expect(
        prisma.tx.cashSessionPaymentMethodSummary.deleteMany,
      ).toHaveBeenCalledWith({ where: { cashSessionId: 'cs-1' } });
      const createManyCall = prisma.tx.cashSessionPaymentMethodSummary
        .createMany.mock.calls[0][0] as {
        data: { paymentMethodCode: string; totalAmount: unknown }[];
      };
      expect(createManyCall.data).toHaveLength(1);
      expect(createManyCall.data[0].paymentMethodCode).toBe('CASH');
    });

    it('Payment CANCELLED vinculado se excluye del cálculo de expectedCashAmount', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([
        {
          amount: new Prisma.Decimal('999.00'),
          status: 'CANCELLED',
          paymentMethodId: 'pm-cash',
          paymentMethodCode: 'CASH',
          paymentMethodName: 'Efectivo',
          paymentMethodAffectsCashDrawer: true,
        },
      ]);
      prisma.tx.cashSession.update.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      await service.close({
        countedCashAmount: '100.00',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'user-1',
      });

      const updateCall = prisma.tx.cashSession.update.mock.calls[0][0] as {
        data: { expectedCashAmount: Prisma.Decimal };
      };
      expect(updateCall.data.expectedCashAmount.toFixed(2)).toBe('100.00');
    });

    it('usa el snapshot paymentMethodAffectsCashDrawer del Payment, no un dato externo', async () => {
      mockLockedOpenSession();
      prisma.tx.payment.findMany.mockResolvedValue([
        {
          amount: new Prisma.Decimal('300.00'),
          status: 'ACTIVE',
          paymentMethodId: 'pm-card',
          paymentMethodCode: 'CARD',
          paymentMethodName: 'Tarjeta',
          paymentMethodAffectsCashDrawer: false,
        },
      ]);
      prisma.tx.cashSession.update.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      await service.close({
        countedCashAmount: '100.00',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'user-1',
      });

      const updateCall = prisma.tx.cashSession.update.mock.calls[0][0] as {
        data: { expectedCashAmount: Prisma.Decimal };
      };
      // CARD no afecta caja: expectedCashAmount = opening (100), nunca 400.
      expect(updateCall.data.expectedCashAmount.toFixed(2)).toBe('100.00');
    });
  });

  // ==================================================================
  // approve()
  // ==================================================================
  describe('approve', () => {
    function mockPendingSession(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      prisma.tx.cashSession.findUnique.mockResolvedValue({
        id: 'cs-1',
        userId: 'owner-1',
        status: CashSessionStatus.PENDING_APPROVAL,
        expectedCashAmount: new Prisma.Decimal('100.00'),
        countedCashAmount: new Prisma.Decimal('90.00'),
        differenceAmount: new Prisma.Decimal('-10.00'),
        ...overrides,
      });
    }

    it('ADMIN aprueba la caja pendiente de otro usuario -> CLOSED', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      const result = await service.approve({
        cashSessionId: 'cs-1',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'reviewer-1',
      });

      expect(result.status).toBe(CashSessionStatus.CLOSED);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: 'CASH_SESSION_DISCREPANCY_APPROVED',
        }),
      );
    });

    it('MANAGEMENT aprueba la caja pendiente de otro usuario -> CLOSED', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      const result = await service.approve({
        cashSessionId: 'cs-1',
        requesterRole: RoleName.MANAGEMENT,
        actorUserId: 'reviewer-1',
      });
      expect(result.status).toBe(CashSessionStatus.CLOSED);
    });

    it('SELLER: 403, sin tocar Prisma', async () => {
      await expect(
        service.approve({
          cashSessionId: 'cs-1',
          requesterRole: RoleName.SELLER,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: 403, sin tocar Prisma', async () => {
      await expect(
        service.approve({
          cashSessionId: 'cs-1',
          requesterRole: RoleName.WAREHOUSE,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('autoaprobación (mismo usuario dueño y actor) -> 403, sin ejecutar el UPDATE', async () => {
      mockPendingSession({ userId: 'admin-1' });
      await expect(
        service.approve({
          cashSessionId: 'cs-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('caja no existe -> 404', async () => {
      prisma.tx.cashSession.findUnique.mockResolvedValue(null);
      await expect(
        service.approve({
          cashSessionId: 'missing',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('caja no está PENDING_APPROVAL -> 409', async () => {
      mockPendingSession({ status: CashSessionStatus.OPEN });
      await expect(
        service.approve({
          cashSessionId: 'cs-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(prisma.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('comment opcional: se omite sin error', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );
      await expect(
        service.approve({
          cashSessionId: 'cs-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).resolves.toBeDefined();
    });

    it('comment se normaliza (trim) y viaja en la auditoría', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      await service.approve({
        cashSessionId: 'cs-1',
        comment: '  verificado  ',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'reviewer-1',
      });

      const auditCall = auditService.record.mock.calls[0][0] as {
        metadata: { comment: string | null };
      };
      expect(auditCall.metadata.comment).toBe('verificado');
    });

    it('UPDATE condicional afecta 0 filas (carrera perdida) -> 409, audita 0 veces', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(0);

      await expect(
        service.approve({
          cashSessionId: 'cs-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('audita exactamente una vez en el camino exitoso', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );

      await service.approve({
        cashSessionId: 'cs-1',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'reviewer-1',
      });
      expect(auditService.record).toHaveBeenCalledTimes(1);
    });
  });

  // ==================================================================
  // reject()
  // ==================================================================
  describe('reject', () => {
    function mockPendingSession(
      overrides: Partial<Record<string, unknown>> = {},
    ) {
      prisma.tx.cashSession.findUnique.mockResolvedValue({
        id: 'cs-1',
        userId: 'owner-1',
        status: CashSessionStatus.PENDING_APPROVAL,
        expectedCashAmount: new Prisma.Decimal('100.00'),
        countedCashAmount: new Prisma.Decimal('90.00'),
        differenceAmount: new Prisma.Decimal('-10.00'),
        closingObservation: 'Faltante reportado',
        ...overrides,
      });
    }

    beforeEach(() => {
      prisma.tx.cashSessionPaymentMethodSummary.deleteMany.mockResolvedValue({
        count: 1,
      });
    });

    it('ADMIN rechaza la caja pendiente de otro usuario -> OPEN', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.OPEN }),
      );

      const result = await service.reject({
        cashSessionId: 'cs-1',
        reason: 'Conteo no coincide',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'reviewer-1',
      });

      expect(result.status).toBe(CashSessionStatus.OPEN);
      expect(
        prisma.tx.cashSessionPaymentMethodSummary.deleteMany,
      ).toHaveBeenCalledWith({ where: { cashSessionId: 'cs-1' } });
    });

    it('MANAGEMENT rechaza la caja pendiente de otro usuario -> OPEN', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.OPEN }),
      );

      const result = await service.reject({
        cashSessionId: 'cs-1',
        reason: 'Conteo no coincide',
        requesterRole: RoleName.MANAGEMENT,
        actorUserId: 'reviewer-1',
      });
      expect(result.status).toBe(CashSessionStatus.OPEN);
    });

    it('SELLER: 403, sin tocar Prisma', async () => {
      await expect(
        service.reject({
          cashSessionId: 'cs-1',
          reason: 'motivo',
          requesterRole: RoleName.SELLER,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: 403, sin tocar Prisma', async () => {
      await expect(
        service.reject({
          cashSessionId: 'cs-1',
          reason: 'motivo',
          requesterRole: RoleName.WAREHOUSE,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('autorrechazo (mismo usuario dueño y actor) -> 403, sin borrar resumen ni ejecutar UPDATE', async () => {
      mockPendingSession({ userId: 'admin-1' });
      await expect(
        service.reject({
          cashSessionId: 'cs-1',
          reason: 'motivo',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'admin-1',
        }),
      ).rejects.toThrow(ForbiddenException);
      expect(
        prisma.tx.cashSessionPaymentMethodSummary.deleteMany,
      ).not.toHaveBeenCalled();
      expect(prisma.tx.$executeRaw).not.toHaveBeenCalled();
    });

    it('reason ausente -> 400, sin tocar Prisma', async () => {
      await expect(
        service.reject({
          cashSessionId: 'cs-1',
          reason: '',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('reason en blanco -> 400', async () => {
      await expect(
        service.reject({
          cashSessionId: 'cs-1',
          reason: '   ',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(BadRequestException);
    });

    it('caja no existe -> 404', async () => {
      prisma.tx.cashSession.findUnique.mockResolvedValue(null);
      await expect(
        service.reject({
          cashSessionId: 'missing',
          reason: 'motivo',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(NotFoundException);
    });

    it('caja no está PENDING_APPROVAL -> 409, sin borrar resumen', async () => {
      mockPendingSession({ status: CashSessionStatus.CLOSED });
      await expect(
        service.reject({
          cashSessionId: 'cs-1',
          reason: 'motivo',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(
        prisma.tx.cashSessionPaymentMethodSummary.deleteMany,
      ).not.toHaveBeenCalled();
    });

    it('UPDATE condicional afecta 0 filas (carrera perdida) -> 409, audita 0 veces', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(0);

      await expect(
        service.reject({
          cashSessionId: 'cs-1',
          reason: 'motivo',
          requesterRole: RoleName.ADMIN,
          actorUserId: 'reviewer-1',
        }),
      ).rejects.toThrow(ConflictException);
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('AuditLog captura el snapshot PREVIO (antes de limpiarlo) + el motivo', async () => {
      mockPendingSession();
      prisma.tx.$executeRaw.mockResolvedValue(1);
      prisma.tx.cashSession.findUniqueOrThrow.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.OPEN }),
      );

      await service.reject({
        cashSessionId: 'cs-1',
        reason: 'El conteo no coincide',
        requesterRole: RoleName.ADMIN,
        actorUserId: 'reviewer-1',
      });

      const auditCall = auditService.record.mock.calls[0][0] as {
        action: string;
        metadata: {
          ownerUserId: string;
          reviewerUserId: string;
          reason: string;
          previousExpectedCashAmount: string;
          previousCountedCashAmount: string;
          previousDifferenceAmount: string;
          previousClosingObservation: string;
        };
      };
      expect(auditCall.action).toBe('CASH_SESSION_DISCREPANCY_REJECTED');
      expect(auditCall.metadata.ownerUserId).toBe('owner-1');
      expect(auditCall.metadata.reviewerUserId).toBe('reviewer-1');
      expect(auditCall.metadata.reason).toBe('El conteo no coincide');
      expect(auditCall.metadata.previousExpectedCashAmount).toBe('100.00');
      expect(auditCall.metadata.previousCountedCashAmount).toBe('90.00');
      expect(auditCall.metadata.previousDifferenceAmount).toBe('-10.00');
      expect(auditCall.metadata.previousClosingObservation).toBe(
        'Faltante reportado',
      );
    });
  });

  // ==================================================================
  // getCurrent() / getDetail() — enriquecimiento (Ticket B, Bloque B3)
  // ==================================================================
  describe('enriquecimiento de current/detail', () => {
    it('OPEN: incluye totales EN VIVO calculados desde los Payment vinculados', async () => {
      prisma.cashSession.findFirst.mockResolvedValue(makeSessionRow());
      prisma.payment.findMany.mockResolvedValue([
        {
          amount: new Prisma.Decimal('200.00'),
          status: 'ACTIVE',
          paymentMethodId: 'pm-cash',
          paymentMethodCode: 'CASH',
          paymentMethodName: 'Efectivo',
          paymentMethodAffectsCashDrawer: true,
        },
      ]);

      const result = await service.getCurrent(makeActor());
      expect(result.liveCollectionsTotal).toBe('200.00');
      expect(result.liveCashCollectionsTotal).toBe('200.00');
      expect(result.liveExpectedCashAmount).toBe('300.00');
      expect(result.liveBreakdownByMethod).toHaveLength(1);
      expect(result.breakdownByMethod).toBeNull();
    });

    it('PENDING_APPROVAL: breakdownByMethod trae el resumen CONGELADO, nunca recalculado; live* es null', async () => {
      prisma.cashSession.findFirst.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.PENDING_APPROVAL }),
      );
      prisma.cashSessionPaymentMethodSummary.findMany.mockResolvedValue([
        makeSummaryRow(),
      ]);

      const result = await service.getCurrent(makeActor());
      expect(result.liveExpectedCashAmount).toBeNull();
      expect(result.liveBreakdownByMethod).toBeNull();
      expect(result.breakdownByMethod).toHaveLength(1);
      expect(result.breakdownByMethod?.[0].paymentMethodCode).toBe('CASH');
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });

    it('getDetail CLOSED: usa el resumen congelado, nunca recalcula desde Payment', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.CLOSED }),
      );
      prisma.cashSessionPaymentMethodSummary.findMany.mockResolvedValue([
        makeSummaryRow({ totalAmount: new Prisma.Decimal('500.00') }),
      ]);

      const result = await service.getDetail(
        'cs-1',
        makeActor({ role: RoleName.ADMIN }),
      );
      expect(result.breakdownByMethod?.[0].totalAmount).toBe('500.00');
      expect(prisma.payment.findMany).not.toHaveBeenCalled();
    });
  });

  // ==================================================================
  // getCurrent()
  // ==================================================================
  describe('getCurrent', () => {
    it('ADMIN: caja propia OPEN -> 200', async () => {
      prisma.cashSession.findFirst.mockResolvedValue(makeSessionRow());
      const result = await service.getCurrent(
        makeActor({ role: RoleName.ADMIN }),
      );
      expect(result.id).toBe('cs-1');
    });

    it('SELLER: caja propia OPEN -> 200', async () => {
      prisma.cashSession.findFirst.mockResolvedValue(makeSessionRow());
      const result = await service.getCurrent(
        makeActor({ role: RoleName.SELLER }),
      );
      expect(result.id).toBe('cs-1');
    });

    it('PENDING_APPROVAL se considera "actual"', async () => {
      prisma.cashSession.findFirst.mockResolvedValue(
        makeSessionRow({ status: CashSessionStatus.PENDING_APPROVAL }),
      );
      const result = await service.getCurrent(makeActor());
      expect(result.status).toBe(CashSessionStatus.PENDING_APPROVAL);
    });

    it('sin sesión sin resolver -> 404', async () => {
      prisma.cashSession.findFirst.mockResolvedValue(null);
      await expect(service.getCurrent(makeActor())).rejects.toThrow(
        NotFoundException,
      );
    });

    it('MANAGEMENT: 403, sin tocar Prisma', async () => {
      await expect(
        service.getCurrent(makeActor({ role: RoleName.MANAGEMENT })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cashSession.findFirst).not.toHaveBeenCalled();
    });

    it('WAREHOUSE: 403, sin tocar Prisma', async () => {
      await expect(
        service.getCurrent(makeActor({ role: RoleName.WAREHOUSE })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cashSession.findFirst).not.toHaveBeenCalled();
    });
  });

  // ==================================================================
  // list()
  // ==================================================================
  describe('list', () => {
    beforeEach(() => {
      prisma.cashSession.findMany.mockResolvedValue([makeSessionRow()]);
      prisma.cashSession.count.mockResolvedValue(1);
    });

    it('ADMIN: sin userId en la query -> sin filtro de propiedad', async () => {
      await service.list({}, makeActor({ role: RoleName.ADMIN }));
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({});
    });

    it('ADMIN: con userId en la query -> filtro real aplicado', async () => {
      await service.list(
        { userId: 'other-user' },
        makeActor({ role: RoleName.ADMIN }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ AND: [{ userId: 'other-user' }] });
    });

    it('MANAGEMENT: sin restricción de propiedad', async () => {
      await service.list({}, makeActor({ role: RoleName.MANAGEMENT }));
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({});
    });

    it('SELLER: forzado a actor.id aunque no envíe userId', async () => {
      await service.list(
        {},
        makeActor({ id: 'seller-1', role: RoleName.SELLER }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ AND: [{ userId: 'seller-1' }] });
    });

    it('SELLER: userId ajeno en la query NUNCA escapa el ámbito propio', async () => {
      await service.list(
        { userId: 'another-user-id' },
        makeActor({ id: 'seller-1', role: RoleName.SELLER }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({ AND: [{ userId: 'seller-1' }] });
      expect(JSON.stringify(args.where)).not.toContain('another-user-id');
    });

    it('paginación: page/limit determinan skip/take', async () => {
      await service.list(
        { page: 3, limit: 10 },
        makeActor({ role: RoleName.ADMIN }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.skip).toBe(20);
      expect(args.take).toBe(10);
    });

    it('limit se recorta al máximo de 100', async () => {
      await service.list({ limit: 500 }, makeActor({ role: RoleName.ADMIN }));
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.take).toBe(100);
    });

    it('filtro por status', async () => {
      await service.list(
        { status: CashSessionStatus.CLOSED },
        makeActor({ role: RoleName.ADMIN }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        AND: [{ status: CashSessionStatus.CLOSED }],
      });
    });

    it('filtros de fecha openedFrom/openedTo usan los límites de negocio America/Lima', async () => {
      await service.list(
        { openedFrom: '2026-03-01', openedTo: '2026-03-31' },
        makeActor({ role: RoleName.ADMIN }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        AND: [
          { openedAt: { gte: startOfBusinessDayUtc('2026-03-01') } },
          { openedAt: { lt: endOfBusinessDayExclusiveUtc('2026-03-31') } },
        ],
      });
    });

    it('filtros de fecha closedFrom/closedTo usan los límites de negocio America/Lima', async () => {
      await service.list(
        { closedFrom: '2026-03-01', closedTo: '2026-03-31' },
        makeActor({ role: RoleName.ADMIN }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        AND: [
          { closedAt: { gte: startOfBusinessDayUtc('2026-03-01') } },
          { closedAt: { lt: endOfBusinessDayExclusiveUtc('2026-03-31') } },
        ],
      });
    });

    it('fecha inválida -> 400', async () => {
      await expect(
        service.list(
          { openedFrom: '2026-99-99' },
          makeActor({ role: RoleName.ADMIN }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('openedFrom posterior a openedTo -> 400', async () => {
      await expect(
        service.list(
          { openedFrom: '2026-03-31', openedTo: '2026-03-01' },
          makeActor({ role: RoleName.ADMIN }),
        ),
      ).rejects.toThrow(BadRequestException);
    });

    it('hasDifference=true filtra differenceAmount <> 0', async () => {
      await service.list(
        { hasDifference: true },
        makeActor({ role: RoleName.ADMIN }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        AND: [{ differenceAmount: { not: new Prisma.Decimal(0) } }],
      });
    });

    it('hasDifference=false filtra differenceAmount = 0', async () => {
      await service.list(
        { hasDifference: false },
        makeActor({ role: RoleName.ADMIN }),
      );
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.where).toEqual({
        AND: [{ differenceAmount: new Prisma.Decimal(0) }],
      });
    });

    it('orden determinista: openedAt DESC, id DESC', async () => {
      await service.list({}, makeActor({ role: RoleName.ADMIN }));
      const args = prisma.cashSession.findMany.mock.calls[0][0];
      expect(args.orderBy).toEqual([{ openedAt: 'desc' }, { id: 'desc' }]);
    });

    it('WAREHOUSE: 403, sin tocar Prisma', async () => {
      await expect(
        service.list({}, makeActor({ role: RoleName.WAREHOUSE })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cashSession.findMany).not.toHaveBeenCalled();
    });
  });

  // ==================================================================
  // getDetail()
  // ==================================================================
  describe('getDetail', () => {
    it('ADMIN: lee cualquier sesión', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(
        makeSessionRow({ userId: 'other-user' }),
      );
      const result = await service.getDetail(
        'cs-1',
        makeActor({ id: 'admin-1', role: RoleName.ADMIN }),
      );
      expect(result.id).toBe('cs-1');
    });

    it('MANAGEMENT: lee cualquier sesión', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(
        makeSessionRow({ userId: 'other-user' }),
      );
      const result = await service.getDetail(
        'cs-1',
        makeActor({ id: 'mgmt-1', role: RoleName.MANAGEMENT }),
      );
      expect(result.id).toBe('cs-1');
    });

    it('SELLER: lee su propia sesión', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(
        makeSessionRow({ userId: 'seller-1' }),
      );
      const result = await service.getDetail(
        'cs-1',
        makeActor({ id: 'seller-1', role: RoleName.SELLER }),
      );
      expect(result.id).toBe('cs-1');
    });

    it('SELLER: sesión ajena -> 404 (nunca 403, no revela existencia cruzada)', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(
        makeSessionRow({ userId: 'other-user' }),
      );
      await expect(
        service.getDetail(
          'cs-1',
          makeActor({ id: 'seller-1', role: RoleName.SELLER }),
        ),
      ).rejects.toThrow(NotFoundException);
    });

    it('WAREHOUSE: 403, sin tocar Prisma', async () => {
      await expect(
        service.getDetail('cs-1', makeActor({ role: RoleName.WAREHOUSE })),
      ).rejects.toThrow(ForbiddenException);
      expect(prisma.cashSession.findUnique).not.toHaveBeenCalled();
    });

    it('no existe -> 404 para cualquier rol', async () => {
      prisma.cashSession.findUnique.mockResolvedValue(null);
      await expect(
        service.getDetail('missing', makeActor({ role: RoleName.ADMIN })),
      ).rejects.toThrow(NotFoundException);
    });
  });
});
