import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RoleName, UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { PrismaService } from '../database/prisma.service';
import { UsersService } from './users.service';

interface RoleFindUniqueArgs {
  where: { name: RoleName };
}
interface UserCreateArgs {
  data: Record<string, unknown>;
}
interface UserUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}
interface UserFindUniqueArgs {
  where: { id: string };
}

const ACTOR_ID = 'actor-id';
const NOW = new Date('2026-01-01T00:00:00.000Z');

function makeRole(name: RoleName, id = `role-${name}`) {
  return { id, name };
}

function makeUserRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    firstName: 'Juan',
    lastName: 'Pérez',
    username: 'jperez',
    email: 'jperez@demosystem.local',
    status: UserStatus.ACTIVE,
    mustChangePassword: true,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    role: { name: RoleName.SELLER },
    ...overrides,
  };
}

/**
 * $transaction mockeado invoca el callback con `tx`, igual que Prisma real.
 * Si el callback lanza, la promesa de $transaction rechaza — así se
 * verifica, sin base de datos, que un fallo revierte la operación lógica.
 */
function createPrismaMock() {
  const tx = {
    role: {
      findUnique: jest.fn<Promise<unknown>, [RoleFindUniqueArgs]>(),
    },
    user: {
      create: jest.fn<Promise<unknown>, [UserCreateArgs]>(),
      update: jest.fn<Promise<unknown>, [UserUpdateArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [UserFindUniqueArgs]>(),
      count: jest.fn<Promise<number>, unknown[]>(),
    },
  };

  return {
    tx,
    role: {
      findUnique: jest.fn<Promise<unknown>, [RoleFindUniqueArgs]>(),
    },
    user: {
      findUnique: jest.fn<Promise<unknown>, [UserFindUniqueArgs]>(),
      findMany: jest.fn<Promise<unknown[]>, unknown[]>(),
      count: jest.fn<Promise<number>, unknown[]>(),
    },
    $transaction: jest.fn((callback: (client: typeof tx) => unknown) =>
      callback(tx),
    ),
  };
}

function createPasswordServiceMock() {
  return {
    hash: jest.fn<Promise<string>, [string]>(),
    verify: jest.fn<Promise<boolean>, [string, string]>(),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

describe('UsersService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let passwordService: ReturnType<typeof createPasswordServiceMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let service: UsersService;

  beforeEach(() => {
    prisma = createPrismaMock();
    passwordService = createPasswordServiceMock();
    passwordService.hash.mockResolvedValue('$argon2id$hashed');
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);

    service = new UsersService(
      prisma as unknown as PrismaService,
      passwordService,
      auditService as unknown as AuditService,
    );
  });

  describe('createUser', () => {
    const validInput = {
      firstName: 'Juan',
      lastName: 'Pérez',
      username: '  JPerez  ',
      email: '  JPerez@DemoSystem.local  ',
      temporaryPassword: 'Temporal1234',
      roleName: RoleName.SELLER,
      actorUserId: ACTOR_ID,
      ipAddress: '10.0.0.5',
    };

    beforeEach(() => {
      prisma.tx.role.findUnique.mockResolvedValue(makeRole(RoleName.SELLER));
      prisma.tx.user.create.mockResolvedValue(makeUserRow());
    });

    it('crea el usuario y devuelve la forma segura', async () => {
      const result = await service.createUser(validInput);

      expect(result).toEqual({
        id: 'user-1',
        firstName: 'Juan',
        lastName: 'Pérez',
        username: 'jperez',
        email: 'jperez@demosystem.local',
        role: RoleName.SELLER,
        status: UserStatus.ACTIVE,
        mustChangePassword: true,
        lastLoginAt: null,
        createdAt: NOW,
        updatedAt: NOW,
      });
      expect(result).not.toHaveProperty('passwordHash');
      expect(result).not.toHaveProperty('failedLoginAttempts');
      expect(result).not.toHaveProperty('roleId');
    });

    it('normaliza username y email antes de guardarlos', async () => {
      await service.createUser(validInput);

      const createArgs = prisma.tx.user.create.mock.calls[0][0];
      expect(createArgs.data.username).toBe('jperez');
      expect(createArgs.data.email).toBe('jperez@demosystem.local');
    });

    it('resuelve el rol por roleName y no acepta un roleId externo', async () => {
      await service.createUser(validInput);

      expect(prisma.tx.role.findUnique).toHaveBeenCalledWith({
        where: { name: RoleName.SELLER },
      });
      const createArgs = prisma.tx.user.create.mock.calls[0][0];
      expect(createArgs.data.roleId).toBe(`role-${RoleName.SELLER}`);
    });

    it('envía la contraseña en texto plano a PasswordService.hash', async () => {
      await service.createUser(validInput);

      expect(passwordService.hash).toHaveBeenCalledWith('Temporal1234');
      const createArgs = prisma.tx.user.create.mock.calls[0][0];
      expect(createArgs.data.passwordHash).toBe('$argon2id$hashed');
    });

    it('registra USER_CREATED dentro de la misma transacción, sin secretos', async () => {
      await service.createUser(validInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.USER_CREATED,
          userId: ACTOR_ID,
          client: prisma.tx,
        }),
      );
      const [call] = auditService.record.mock.calls[0];
      const serialized = JSON.stringify(call.metadata);
      expect(serialized).not.toContain('Temporal1234');
      expect(serialized).not.toContain('argon2id');
    });

    it('rechaza una contraseña que no cumple la política', async () => {
      await expect(
        service.createUser({ ...validInput, temporaryPassword: 'corta1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza un roleName inexistente', async () => {
      prisma.tx.role.findUnique.mockResolvedValue(null);

      await expect(service.createUser(validInput)).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });

    it('revierte la operación si la auditoría falla (transacción simulada)', async () => {
      auditService.record.mockRejectedValue(new Error('fallo de auditoría'));

      await expect(service.createUser(validInput)).rejects.toThrow(
        'fallo de auditoría',
      );
      // El create se intentó, pero como $transaction propaga el rechazo,
      // en una base real la transacción completa se habría revertido.
      expect(prisma.tx.user.create).toHaveBeenCalledTimes(1);
    });
  });

  describe('listUsers', () => {
    it('devuelve una respuesta paginada con los defaults', async () => {
      prisma.user.findMany.mockResolvedValue([makeUserRow()]);
      prisma.user.count.mockResolvedValue(1);

      const result = await service.listUsers({});

      expect(result).toEqual({
        data: [expect.objectContaining({ id: 'user-1' })],
        page: 1,
        limit: 20,
        total: 1,
        totalPages: 1,
      });
      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ skip: 0, take: 20 }),
      );
    });

    it('limita el tamaño de página a 100', async () => {
      prisma.user.findMany.mockResolvedValue([]);
      prisma.user.count.mockResolvedValue(0);

      await service.listUsers({ limit: 500 });

      expect(prisma.user.findMany).toHaveBeenCalledWith(
        expect.objectContaining({ take: 100 }),
      );
    });
  });

  describe('findUserById', () => {
    it('devuelve la forma segura cuando el usuario existe', async () => {
      prisma.user.findUnique.mockResolvedValue(makeUserRow());

      const result = await service.findUserById('user-1');

      expect(result.id).toBe('user-1');
      expect(result).not.toHaveProperty('passwordHash');
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.user.findUnique.mockResolvedValue(null);

      await expect(service.findUserById('missing')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });

  describe('updateUser', () => {
    it('permite editar firstName, lastName, email y roleName', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        role: { name: RoleName.SELLER },
      });
      prisma.tx.role.findUnique.mockResolvedValue(
        makeRole(RoleName.MANAGEMENT),
      );
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ role: { name: RoleName.MANAGEMENT } }),
      );

      const result = await service.updateUser({
        userId: 'user-1',
        firstName: 'Juan Carlos',
        email: '  Nuevo@DemoSystem.local ',
        roleName: RoleName.MANAGEMENT,
        actorUserId: ACTOR_ID,
      });

      expect(result.role).toBe(RoleName.MANAGEMENT);
      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.email).toBe('nuevo@demosystem.local');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_UPDATED }),
      );
    });

    it('rechaza un update sin ningún campo con BadRequestException', async () => {
      await expect(
        service.updateUser({ userId: 'user-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('no abre la transacción cuando el update está vacío', async () => {
      await expect(
        service.updateUser({ userId: 'user-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('no llama a AuditService cuando el update está vacío', async () => {
      await expect(
        service.updateUser({ userId: 'user-1', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(auditService.record).not.toHaveBeenCalled();
    });

    it('permite un update con un único campo definido', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ firstName: 'Solo Nombre' }),
      );

      const result = await service.updateUser({
        userId: 'user-1',
        firstName: 'Solo Nombre',
        actorUserId: ACTOR_ID,
      });

      expect(result.firstName).toBe('Solo Nombre');
      expect(prisma.tx.role.findUnique).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_UPDATED }),
      );
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.updateUser({
          userId: 'missing',
          firstName: 'Cualquiera',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    describe('protección del último ADMIN activo al cambiar roleName', () => {
      it('rechaza con 409 cuando el único ADMIN activo intenta cambiar su propio rol', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          role: { name: RoleName.ADMIN },
        });
        prisma.tx.role.findUnique.mockResolvedValue(makeRole(RoleName.SELLER));
        prisma.tx.user.count.mockResolvedValue(1);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleName: RoleName.SELLER,
            actorUserId: 'admin-1',
          }),
        ).rejects.toBeInstanceOf(ConflictException);
      });

      it('no llama a update cuando se rechaza', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          role: { name: RoleName.ADMIN },
        });
        prisma.tx.role.findUnique.mockResolvedValue(makeRole(RoleName.SELLER));
        prisma.tx.user.count.mockResolvedValue(1);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleName: RoleName.SELLER,
            actorUserId: 'admin-1',
          }),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(prisma.tx.user.update).not.toHaveBeenCalled();
      });

      it('no llama a AuditService cuando se rechaza', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          role: { name: RoleName.ADMIN },
        });
        prisma.tx.role.findUnique.mockResolvedValue(makeRole(RoleName.SELLER));
        prisma.tx.user.count.mockResolvedValue(1);

        await expect(
          service.updateUser({
            userId: 'admin-1',
            roleName: RoleName.SELLER,
            actorUserId: 'admin-1',
          }),
        ).rejects.toBeInstanceOf(ConflictException);

        expect(auditService.record).not.toHaveBeenCalled();
      });

      it('permite el cambio si existen dos ADMIN activos', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-1',
          username: 'admin',
          status: UserStatus.ACTIVE,
          role: { name: RoleName.ADMIN },
        });
        prisma.tx.role.findUnique.mockResolvedValue(makeRole(RoleName.SELLER));
        prisma.tx.user.count.mockResolvedValue(2);
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'admin-1', role: { name: RoleName.SELLER } }),
        );

        const result = await service.updateUser({
          userId: 'admin-1',
          roleName: RoleName.SELLER,
          actorUserId: 'otro-admin-id',
        });

        expect(result.role).toBe(RoleName.SELLER);
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({ action: AuditAction.USER_UPDATED }),
        );
      });

      it('permite cambiar el rol de un usuario que no es ADMIN', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'user-1',
          username: 'jperez',
          status: UserStatus.ACTIVE,
          role: { name: RoleName.SELLER },
        });
        prisma.tx.role.findUnique.mockResolvedValue(
          makeRole(RoleName.WAREHOUSE),
        );
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ role: { name: RoleName.WAREHOUSE } }),
        );

        const result = await service.updateUser({
          userId: 'user-1',
          roleName: RoleName.WAREHOUSE,
          actorUserId: ACTOR_ID,
        });

        expect(result.role).toBe(RoleName.WAREHOUSE);
        expect(prisma.tx.user.count).not.toHaveBeenCalled();
      });

      it('permite cambiar el rol de un ADMIN INACTIVE', async () => {
        prisma.tx.user.findUnique.mockResolvedValue({
          id: 'admin-2',
          username: 'admin_inactivo',
          status: UserStatus.INACTIVE,
          role: { name: RoleName.ADMIN },
        });
        prisma.tx.role.findUnique.mockResolvedValue(makeRole(RoleName.SELLER));
        prisma.tx.user.update.mockResolvedValue(
          makeUserRow({ id: 'admin-2', role: { name: RoleName.SELLER } }),
        );

        const result = await service.updateUser({
          userId: 'admin-2',
          roleName: RoleName.SELLER,
          actorUserId: ACTOR_ID,
        });

        expect(result.role).toBe(RoleName.SELLER);
        expect(prisma.tx.user.count).not.toHaveBeenCalled();
      });
    });
  });

  describe('blockUser', () => {
    it('rechaza el autobloqueo', async () => {
      await expect(
        service.blockUser({ targetUserId: ACTOR_ID, actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('protege al único ADMIN activo', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'admin',
        status: UserStatus.ACTIVE,
        role: { name: RoleName.ADMIN },
      });
      prisma.tx.user.count.mockResolvedValue(1);

      await expect(
        service.blockUser({ targetUserId: 'target-id', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(prisma.tx.user.update).not.toHaveBeenCalled();
    });

    it('permite bloquear a un ADMIN si hay más de uno activo', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'admin2',
        status: UserStatus.ACTIVE,
        role: { name: RoleName.ADMIN },
      });
      prisma.tx.user.count.mockResolvedValue(2);
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.BLOCKED }),
      );

      const result = await service.blockUser({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UserStatus.BLOCKED);
    });

    it('bloquea correctamente a un usuario no ADMIN', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
        role: { name: RoleName.SELLER },
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.BLOCKED }),
      );

      const result = await service.blockUser({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UserStatus.BLOCKED);
      expect(prisma.tx.user.count).not.toHaveBeenCalled();
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_BLOCKED }),
      );
    });

    it('lanza ConflictException si ya estaba bloqueado', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.BLOCKED,
        role: { name: RoleName.SELLER },
      });

      await expect(
        service.blockUser({ targetUserId: 'target-id', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.blockUser({ targetUserId: 'missing', actorUserId: ACTOR_ID }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('unblockUser', () => {
    it('desbloquea correctamente y reinicia los intentos fallidos', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.BLOCKED,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.ACTIVE }),
      );

      const result = await service.unblockUser({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.status).toBe(UserStatus.ACTIVE);
      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(UserStatus.ACTIVE);
      expect(updateArgs.data.blockedAt).toBeNull();
      expect(updateArgs.data.failedLoginAttempts).toBe(0);
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.USER_UNBLOCKED }),
      );
    });

    it('lanza ConflictException si no estaba bloqueado', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
      });

      await expect(
        service.unblockUser({
          targetUserId: 'target-id',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('resetPassword', () => {
    it('genera una contraseña temporal que cumple la política y marca mustChangePassword', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', mustChangePassword: true }),
      );

      const result = await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      expect(result.temporaryPassword.length).toBeGreaterThanOrEqual(16);
      expect(result.temporaryPassword).toMatch(/[a-zA-Z]/);
      expect(result.temporaryPassword).toMatch(/[0-9]/);
      expect(result.user.mustChangePassword).toBe(true);
      expect(passwordService.hash).toHaveBeenCalledWith(
        result.temporaryPassword,
      );
    });

    it('activa a un usuario BLOCKED tras el reset', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.BLOCKED,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.ACTIVE }),
      );

      await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(UserStatus.ACTIVE);
      expect(updateArgs.data.blockedAt).toBeNull();
    });

    it('mantiene INACTIVE como INACTIVE tras el reset', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.INACTIVE,
      });
      prisma.tx.user.update.mockResolvedValue(
        makeUserRow({ id: 'target-id', status: UserStatus.INACTIVE }),
      );

      await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.status).toBe(UserStatus.INACTIVE);
    });

    it('no guarda la contraseña temporal ni el hash en la auditoría', async () => {
      prisma.tx.user.findUnique.mockResolvedValue({
        id: 'target-id',
        username: 'jperez',
        status: UserStatus.ACTIVE,
      });
      prisma.tx.user.update.mockResolvedValue(makeUserRow({ id: 'target-id' }));

      const result = await service.resetPassword({
        targetUserId: 'target-id',
        actorUserId: ACTOR_ID,
      });

      const [call] = auditService.record.mock.calls[0];
      const serialized = JSON.stringify(call.metadata);
      expect(serialized).not.toContain(result.temporaryPassword);
      expect(serialized).not.toContain('argon2id');
      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({ action: AuditAction.PASSWORD_RESET }),
      );
    });

    it('lanza NotFoundException si el usuario no existe', async () => {
      prisma.tx.user.findUnique.mockResolvedValue(null);

      await expect(
        service.resetPassword({
          targetUserId: 'missing',
          actorUserId: ACTOR_ID,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });
});
