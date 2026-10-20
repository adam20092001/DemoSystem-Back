import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  NotFoundException,
} from '@nestjs/common';
import { AccountStatus, AccountType, RoleName } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { ChartOfAccountsService } from './chart-of-accounts.service';

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeAccountRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'account-1',
    code: 'AR',
    name: 'Cuentas por cobrar',
    type: AccountType.ASSET,
    systemKey: null,
    parentId: null,
    level: 1,
    isPostable: true,
    status: AccountStatus.ACTIVE,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function createTxMock() {
  return {
    account: {
      findUnique: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      create: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      update: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
      count: jest.fn<Promise<number>, [Record<string, unknown>?]>(),
      findMany: jest.fn<Promise<unknown[]>, [Record<string, unknown>]>(),
    },
    accountingEntryLine: {
      findFirst: jest.fn<Promise<unknown>, [Record<string, unknown>]>(),
    },
  };
}

function createPrismaMock() {
  const tx = createTxMock();
  return {
    tx,
    account: {
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

describe('ChartOfAccountsService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: ChartOfAccountsService;

  beforeEach(() => {
    prisma = createPrismaMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    prisma.tx.accountingEntryLine.findFirst.mockResolvedValue(null);

    service = new ChartOfAccountsService(
      prisma as unknown as PrismaService,
      auditService as unknown as AuditService,
    );
  });

  describe('permisos — defensa en profundidad a nivel de servicio', () => {
    it.each([RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede leer: ForbiddenException sin tocar Prisma',
      async (role) => {
        await expect(service.listAccounts({}, role)).rejects.toBeInstanceOf(
          ForbiddenException,
        );
        expect(prisma.account.findMany).not.toHaveBeenCalled();
      },
    );

    it('MANAGEMENT puede leer', async () => {
      prisma.account.findMany.mockResolvedValue([]);
      prisma.account.count.mockResolvedValue(0);
      await expect(
        service.listAccounts({}, RoleName.MANAGEMENT),
      ).resolves.toBeDefined();
    });

    it.each([RoleName.MANAGEMENT, RoleName.SELLER, RoleName.WAREHOUSE])(
      '%s no puede mutar: ForbiddenException sin abrir transacción',
      async (role) => {
        await expect(
          service.createAccount({
            code: 'X',
            name: 'X',
            type: AccountType.ASSET,
            requesterRole: role,
            actorUserId: ACTOR_ID,
          }),
        ).rejects.toBeInstanceOf(ForbiddenException);
        expect(prisma.$transaction).not.toHaveBeenCalled();
      },
    );
  });

  describe('createAccount', () => {
    it('crea una cuenta raíz: level=1, isPostable=true por defecto, nace ACTIVE', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(null); // code libre
      prisma.tx.account.create.mockResolvedValue(
        makeAccountRow({ code: 'EQ1', name: 'Equivalentes' }),
      );

      const result = await service.createAccount({
        code: 'eq1',
        name: '  Equivalentes  ',
        type: AccountType.ASSET,
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });

      expect(result.level).toBe(1);
      const createArgs = prisma.tx.account.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.code).toBe('EQ1');
      expect(createArgs.data.name).toBe('Equivalentes');
      expect(createArgs.data.level).toBe(1);
      expect(createArgs.data.isPostable).toBe(true);
      expect(createArgs.data.status).toBe(AccountStatus.ACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.ACCOUNT_CREATED }),
      );
    });

    it('code duplicado -> 409, sin crear nada', async () => {
      prisma.tx.account.findUnique.mockResolvedValue({ id: 'other' });

      await expect(
        service.createAccount({
          code: 'AR',
          name: 'Duplicada',
          type: AccountType.ASSET,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.account.create).not.toHaveBeenCalled();
    });

    it('padre inexistente -> 404', async () => {
      prisma.tx.account.findUnique
        .mockResolvedValueOnce(null) // code libre
        .mockResolvedValueOnce(null); // padre no existe

      await expect(
        service.createAccount({
          code: 'X1',
          name: 'X',
          type: AccountType.ASSET,
          parentId: 'missing-parent',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(prisma.tx.account.create).not.toHaveBeenCalled();
    });

    it('padre INACTIVE -> 409', async () => {
      prisma.tx.account.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          status: AccountStatus.INACTIVE,
          isPostable: false,
          level: 1,
        });

      await expect(
        service.createAccount({
          code: 'X1',
          name: 'X',
          type: AccountType.ASSET,
          parentId: 'parent-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('padre marcado isPostable=true -> 409 (una cuenta de agrupación nunca puede ser postable)', async () => {
      prisma.tx.account.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          status: AccountStatus.ACTIVE,
          isPostable: true,
          level: 1,
        });

      await expect(
        service.createAccount({
          code: 'X1',
          name: 'X',
          type: AccountType.ASSET,
          parentId: 'parent-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('padre válido (ACTIVE, isPostable=false) -> level = parent.level + 1', async () => {
      prisma.tx.account.findUnique
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          status: AccountStatus.ACTIVE,
          isPostable: false,
          level: 2,
        });
      prisma.tx.account.create.mockResolvedValue(
        makeAccountRow({ parentId: 'parent-1', level: 3 }),
      );

      const result = await service.createAccount({
        code: 'X1',
        name: 'X',
        type: AccountType.ASSET,
        parentId: 'parent-1',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });

      expect(result.level).toBe(3);
      const createArgs = prisma.tx.account.create.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(createArgs.data.level).toBe(3);
    });
  });

  describe('updateAccount', () => {
    it('payload vacío -> 400, sin abrir transacción', async () => {
      await expect(
        service.updateAccount({
          accountId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('no existe -> 404', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(null);
      await expect(
        service.updateAccount({
          accountId: 'missing',
          name: 'X',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('no-op real: mismo name ya vigente -> sin UPDATE ni auditoría', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ name: 'Cuentas por cobrar' }),
      );

      const result = await service.updateAccount({
        accountId: 'account-1',
        name: '  Cuentas por cobrar  ',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });

      expect(result.name).toBe('Cuentas por cobrar');
      expect(prisma.tx.account.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('auto-padre -> 400', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(makeAccountRow());
      await expect(
        service.updateAccount({
          accountId: 'account-1',
          parentId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('ciclo indirecto (padre candidato es descendiente del objetivo) -> 400', async () => {
      prisma.tx.account.findUnique
        .mockResolvedValueOnce(makeAccountRow({ id: 'A', parentId: null })) // existing
        .mockResolvedValueOnce({
          status: AccountStatus.ACTIVE,
          isPostable: false,
          level: 2,
        }); // assertParentUsableForNewChild('B')
      // assertNoCycle: B -> A (B es hijo de A, así que poner A bajo B es un ciclo)
      prisma.tx.account.findUnique.mockResolvedValueOnce({ parentId: 'A' }); // B.parentId

      await expect(
        service.updateAccount({
          accountId: 'A',
          parentId: 'B',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('cambiar type con asientos históricos -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(makeAccountRow());
      prisma.tx.accountingEntryLine.findFirst.mockResolvedValue({
        id: 'line-1',
      });

      await expect(
        service.updateAccount({
          accountId: 'account-1',
          type: AccountType.LIABILITY,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.account.update).not.toHaveBeenCalled();
    });

    it('cambiar type sin asientos históricos: permitido', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(makeAccountRow());
      prisma.tx.account.update.mockResolvedValue(
        makeAccountRow({ type: AccountType.LIABILITY }),
      );

      const result = await service.updateAccount({
        accountId: 'account-1',
        type: AccountType.LIABILITY,
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });

      expect(result.type).toBe(AccountType.LIABILITY);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.ACCOUNT_UPDATED }),
      );
    });

    it('marcar isPostable=true con subcuentas existentes -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ isPostable: false }),
      );
      prisma.tx.account.count.mockResolvedValue(1);

      await expect(
        service.updateAccount({
          accountId: 'account-1',
          isPostable: true,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('marcar isPostable=false en una cuenta SIN systemKey: siempre permitido (sin chequeo de subcuentas)', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ isPostable: true, systemKey: null }),
      );
      prisma.tx.account.update.mockResolvedValue(
        makeAccountRow({ isPostable: false }),
      );

      await expect(
        service.updateAccount({
          accountId: 'account-1',
          isPostable: false,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).resolves.toBeDefined();
      expect(prisma.tx.account.count).not.toHaveBeenCalled();
    });

    it('A1-review: marcar isPostable=false en una cuenta DE SISTEMA (systemKey no nulo) -> 409, sin UPDATE', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ isPostable: true, systemKey: 'CASH' }),
      );

      await expect(
        service.updateAccount({
          accountId: 'account-1',
          isPostable: false,
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.account.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('parentId=null convierte en raíz: level vuelve a 1', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ parentId: 'parent-1', level: 2 }),
      );
      prisma.tx.account.update.mockResolvedValue(
        makeAccountRow({ parentId: null, level: 1 }),
      );

      const result = await service.updateAccount({
        accountId: 'account-1',
        parentId: null,
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });

      expect(result.parentId).toBeNull();
      const updateArgs = prisma.tx.account.update.mock.calls[0][0] as {
        data: Record<string, unknown>;
      };
      expect(updateArgs.data.level).toBe(1);
    });
  });

  describe('activateAccount / deactivateAccount', () => {
    it('activar una cuenta ya ACTIVE -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(makeAccountRow());
      await expect(
        service.activateAccount({
          accountId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('desactivar una cuenta de sistema (systemKey no nulo) -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ systemKey: 'CASH' }),
      );
      await expect(
        service.deactivateAccount({
          accountId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.account.update).not.toHaveBeenCalled();
    });

    it('desactivar una cuenta PCGE (sin systemKey) sin subcuentas activas: permitido', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ systemKey: null }),
      );
      prisma.tx.account.count.mockResolvedValue(0);
      prisma.tx.account.update.mockResolvedValue(
        makeAccountRow({ status: AccountStatus.INACTIVE }),
      );

      const result = await service.deactivateAccount({
        accountId: 'account-1',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });
      expect(result.status).toBe(AccountStatus.INACTIVE);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.ACCOUNT_DEACTIVATED }),
      );
    });

    it('desactivar con subcuentas ACTIVE -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ systemKey: null }),
      );
      prisma.tx.account.count.mockResolvedValue(2);

      await expect(
        service.deactivateAccount({
          accountId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('reassignSystemKey — capacidad técnica de A1.3', () => {
    it('cuenta destino inexistente -> 404', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(null);
      await expect(
        service.reassignSystemKey({
          systemKey: 'CASH',
          targetAccountId: 'missing',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('cuenta destino INACTIVE -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ status: AccountStatus.INACTIVE }),
      );
      await expect(
        service.reassignSystemKey({
          systemKey: 'CASH',
          targetAccountId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cuenta destino no postable -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ isPostable: false }),
      );
      await expect(
        service.reassignSystemKey({
          systemKey: 'CASH',
          targetAccountId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('cuenta destino ya sostiene OTRO systemKey -> 409', async () => {
      prisma.tx.account.findUnique.mockResolvedValue(
        makeAccountRow({ systemKey: 'BANK' }),
      );
      await expect(
        service.reassignSystemKey({
          systemKey: 'CASH',
          targetAccountId: 'account-1',
          requesterRole: RoleName.ADMIN,
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('mueve el systemKey del sostenedor actual hacia el destino, en la misma transacción, sin tocar AccountingEntryLine', async () => {
      prisma.tx.account.findUnique
        .mockResolvedValueOnce(
          makeAccountRow({ id: 'target', systemKey: null }),
        ) // target lookup
        .mockResolvedValueOnce({ id: 'old-holder', code: 'CASH' }); // current holder lookup
      prisma.tx.account.update.mockResolvedValueOnce(undefined); // clear old holder
      prisma.tx.account.update.mockResolvedValueOnce(
        makeAccountRow({ id: 'target', systemKey: 'CASH' }),
      ); // set new holder

      const result = await service.reassignSystemKey({
        systemKey: 'CASH',
        targetAccountId: 'target',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });

      expect(result.systemKey).toBe('CASH');
      expect(prisma.tx.account.update).toHaveBeenCalledTimes(2);
      const firstCall = prisma.tx.account.update.mock.calls[0][0] as {
        where: { id: string };
        data: Record<string, unknown>;
      };
      expect(firstCall.where.id).toBe('old-holder');
      expect(firstCall.data.systemKey).toBeNull();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.ACCOUNT_SYSTEM_KEY_REASSIGNED,
        }),
      );
      // Ninguna llamada de este método toca accounting_entry_lines.
      expect(prisma.tx.accountingEntryLine.findFirst).not.toHaveBeenCalled();
    });

    it('reasignar al mismo sostenedor actual: no-op real, sin UPDATE ni auditoría', async () => {
      prisma.tx.account.findUnique.mockResolvedValueOnce(
        makeAccountRow({ id: 'target', systemKey: 'CASH' }),
      );

      const result = await service.reassignSystemKey({
        systemKey: 'CASH',
        targetAccountId: 'target',
        requesterRole: RoleName.ADMIN,
        actorUserId: ACTOR_ID,
      });

      expect(result.systemKey).toBe('CASH');
      expect(prisma.tx.account.update).not.toHaveBeenCalled();
      expect(auditService.record).not.toHaveBeenCalled();
    });
  });
});
