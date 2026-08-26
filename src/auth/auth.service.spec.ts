import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleName, UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { EnvironmentVariables } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from './auth.service';
import {
  ACCOUNT_BLOCKED_CODE,
  ACCOUNT_BLOCKED_MESSAGE,
  AccountBlockedException,
} from './exceptions/account-blocked.exception';
import { TokenService } from './token.service';

interface UserFindFirstArgs {
  where: unknown;
}
interface UserFindUniqueArgs {
  where: { id: string };
}
interface UserUpdateArgs {
  where: { id: string };
  data: Record<string, unknown>;
}

const NOW = new Date('2026-01-01T00:00:00.000Z');

/**
 * KAN-18, Bloque A: `roles` (arreglo de membresías, cada una con su Role
 * anidado) reemplaza a la relación singular `role` consumida por
 * `toSafeUser()`/`resolveDefaultActiveRole()`.
 */
function makeSafeUserRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    id: 'user-1',
    firstName: 'Juan',
    lastName: 'Pérez',
    username: 'jperez',
    email: 'jperez@demosystem.local',
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
    roles: [{ role: { name: RoleName.SELLER } }],
    ...overrides,
  };
}

function createPrismaMock() {
  const tx = {
    user: {
      update: jest.fn<Promise<unknown>, [UserUpdateArgs]>(),
    },
  };

  return {
    tx,
    user: {
      findFirst: jest.fn<Promise<unknown>, [UserFindFirstArgs]>(),
      findUnique: jest.fn<Promise<unknown>, [UserFindUniqueArgs]>(),
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

function createTokenServiceMock() {
  return {
    sign: jest.fn<Promise<string>, [string, RoleName]>(),
  };
}

function createAuditServiceMock() {
  return {
    record: jest.fn<Promise<void>, [Record<string, unknown>]>(),
  };
}

function createConfigMock(maxLoginAttempts = 5) {
  return {
    get: jest.fn().mockReturnValue(maxLoginAttempts),
  };
}

describe('AuthService', () => {
  let prisma: ReturnType<typeof createPrismaMock>;
  let passwordService: ReturnType<typeof createPasswordServiceMock>;
  let tokenService: ReturnType<typeof createTokenServiceMock>;
  let auditService: ReturnType<typeof createAuditServiceMock>;
  let configService: ReturnType<typeof createConfigMock>;
  let service: AuthService;

  beforeEach(() => {
    prisma = createPrismaMock();
    passwordService = createPasswordServiceMock();
    tokenService = createTokenServiceMock();
    auditService = createAuditServiceMock();
    auditService.record.mockResolvedValue(undefined);
    configService = createConfigMock();

    service = new AuthService(
      prisma as unknown as PrismaService,
      passwordService,
      tokenService as unknown as TokenService,
      auditService as unknown as AuditService,
      configService as unknown as ConfigService<EnvironmentVariables, true>,
    );
  });

  describe('login', () => {
    const credentials = {
      identifier: '  JPerez@DemoSystem.local ',
      password: 'Temporal1234',
    };

    it('inicia sesión correctamente y no expone el token en el usuario devuelto', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
      });
      passwordService.verify.mockResolvedValue(true);
      prisma.tx.user.update.mockResolvedValue(makeSafeUserRow());
      tokenService.sign.mockResolvedValue('signed-jwt');

      const result = await service.login(credentials);

      expect(result.token).toBe('signed-jwt');
      expect(result.user).not.toHaveProperty('token');
      expect(result.user).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(result.user)).not.toContain('signed-jwt');
    });

    it('el login devuelve roles[] y el activeRole resuelto, y firma el JWT con ese mismo activeRole', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
      });
      passwordService.verify.mockResolvedValue(true);
      prisma.tx.user.update.mockResolvedValue(
        makeSafeUserRow({
          roles: [
            { role: { name: RoleName.ADMIN } },
            { role: { name: RoleName.WAREHOUSE } },
          ],
        }),
      );
      tokenService.sign.mockResolvedValue('signed-jwt');

      const result = await service.login(credentials);

      // Orden de default-active-role cerrado: SELLER > WAREHOUSE >
      // MANAGEMENT > ADMIN — con ADMIN+WAREHOUSE asignados, gana WAREHOUSE.
      expect(result.user.activeRole).toBe(RoleName.WAREHOUSE);
      expect(result.user.roles).toEqual(
        expect.arrayContaining([RoleName.ADMIN, RoleName.WAREHOUSE]),
      );
      expect(tokenService.sign).toHaveBeenCalledWith(
        'user-1',
        RoleName.WAREHOUSE,
      );
    });

    it('con un único rol asignado, ese rol se preserva como activeRole', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
      });
      passwordService.verify.mockResolvedValue(true);
      prisma.tx.user.update.mockResolvedValue(
        makeSafeUserRow({ roles: [{ role: { name: RoleName.MANAGEMENT } }] }),
      );
      tokenService.sign.mockResolvedValue('signed-jwt');

      const result = await service.login(credentials);

      expect(result.user.activeRole).toBe(RoleName.MANAGEMENT);
      expect(tokenService.sign).toHaveBeenCalledWith(
        'user-1',
        RoleName.MANAGEMENT,
      );
    });

    it('normaliza el identifier antes de buscar por username o email', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.login(credentials)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );

      const args = prisma.user.findFirst.mock.calls[0][0];
      expect(JSON.stringify(args.where)).toContain('jperez@demosystem.local');
    });

    it('usuario inexistente responde con 401 genérico y audita LOGIN_FAILED', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.login(credentials)).rejects.toThrow(
        'Credenciales inválidas',
      );

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.LOGIN_FAILED,
          userId: null,
          metadata: { reason: 'USER_NOT_FOUND' },
        }),
      );
    });

    it('no guarda el identifier ingresado en la auditoría', async () => {
      prisma.user.findFirst.mockResolvedValue(null);

      await expect(service.login(credentials)).rejects.toThrow();

      const [call] = auditService.record.mock.calls[0];
      expect(JSON.stringify(call)).not.toContain('jperez@demosystem.local');
    });

    it('contraseña incorrecta responde con 401 genérico', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
      });
      passwordService.verify.mockResolvedValue(false);
      prisma.tx.user.update.mockResolvedValue(undefined);

      await expect(service.login(credentials)).rejects.toThrow(
        'Credenciales inválidas',
      );
    });

    it('incrementa failedLoginAttempts en una contraseña incorrecta', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 2,
      });
      passwordService.verify.mockResolvedValue(false);

      await expect(service.login(credentials)).rejects.toThrow();

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.failedLoginAttempts).toBe(3);
      expect(updateArgs.data.status).toBeUndefined();
    });

    it('bloquea la cuenta al alcanzar MAX_LOGIN_ATTEMPTS', async () => {
      configService = createConfigMock(5);
      service = new AuthService(
        prisma as unknown as PrismaService,
        passwordService,
        tokenService as unknown as TokenService,
        auditService as unknown as AuditService,
        configService as unknown as ConfigService<EnvironmentVariables, true>,
      );
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 4,
      });
      passwordService.verify.mockResolvedValue(false);

      let caughtError: unknown;
      try {
        await service.login(credentials);
      } catch (error) {
        caughtError = error;
      }

      expect(caughtError).toBeInstanceOf(UnauthorizedException);
      expect(caughtError).not.toBeInstanceOf(AccountBlockedException);
      expect((caughtError as UnauthorizedException).message).toBe(
        'Credenciales inválidas',
      );

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.failedLoginAttempts).toBe(5);
      expect(updateArgs.data.status).toBe(UserStatus.BLOCKED);
      expect(updateArgs.data.blockedAt).toBeInstanceOf(Date);
    });

    describe('cuenta BLOCKED', () => {
      it('contraseña correcta responde 423 con code ACCOUNT_BLOCKED y el mensaje específico', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'user-1',
          passwordHash: '$argon2id$hash',
          status: UserStatus.BLOCKED,
          failedLoginAttempts: 5,
        });
        passwordService.verify.mockResolvedValue(true);

        let caughtError: unknown;
        try {
          await service.login(credentials);
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(AccountBlockedException);
        const exception = caughtError as AccountBlockedException;
        expect(exception.getStatus()).toBe(423);
        expect(exception.getResponse()).toEqual({
          message: ACCOUNT_BLOCKED_MESSAGE,
          code: ACCOUNT_BLOCKED_CODE,
        });
      });

      it('contraseña correcta no genera JWT, no actualiza lastLoginAt y no reinicia intentos', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'user-1',
          passwordHash: '$argon2id$hash',
          status: UserStatus.BLOCKED,
          failedLoginAttempts: 5,
        });
        passwordService.verify.mockResolvedValue(true);

        await expect(service.login(credentials)).rejects.toBeInstanceOf(
          AccountBlockedException,
        );

        expect(tokenService.sign).not.toHaveBeenCalled();
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(prisma.tx.user.update).not.toHaveBeenCalled();
      });

      it('contraseña correcta audita LOGIN_FAILED con reason USER_BLOCKED', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'user-1',
          passwordHash: '$argon2id$hash',
          status: UserStatus.BLOCKED,
          failedLoginAttempts: 5,
        });
        passwordService.verify.mockResolvedValue(true);

        await expect(service.login(credentials)).rejects.toBeInstanceOf(
          AccountBlockedException,
        );

        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.LOGIN_FAILED,
            userId: 'user-1',
            metadata: { reason: 'USER_BLOCKED' },
          }),
        );
      });

      it('contraseña incorrecta responde 401 genérico, no ACCOUNT_BLOCKED, y no incrementa intentos', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'user-1',
          passwordHash: '$argon2id$hash',
          status: UserStatus.BLOCKED,
          failedLoginAttempts: 5,
        });
        passwordService.verify.mockResolvedValue(false);

        let caughtError: unknown;
        try {
          await service.login(credentials);
        } catch (error) {
          caughtError = error;
        }

        expect(caughtError).toBeInstanceOf(UnauthorizedException);
        expect(caughtError).not.toBeInstanceOf(AccountBlockedException);
        expect((caughtError as UnauthorizedException).message).toBe(
          'Credenciales inválidas',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
      });

      it('contraseña incorrecta audita LOGIN_FAILED con reason INVALID_PASSWORD', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'user-1',
          passwordHash: '$argon2id$hash',
          status: UserStatus.BLOCKED,
          failedLoginAttempts: 5,
        });
        passwordService.verify.mockResolvedValue(false);

        await expect(service.login(credentials)).rejects.toThrow();

        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.LOGIN_FAILED,
            userId: 'user-1',
            metadata: { reason: 'INVALID_PASSWORD' },
          }),
        );
      });
    });

    describe('cuenta INACTIVE', () => {
      it('contraseña correcta permanece 401 genérico y audita USER_INACTIVE', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'user-1',
          passwordHash: '$argon2id$hash',
          status: UserStatus.INACTIVE,
          failedLoginAttempts: 0,
        });
        passwordService.verify.mockResolvedValue(true);

        await expect(service.login(credentials)).rejects.toThrow(
          'Credenciales inválidas',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.LOGIN_FAILED,
            metadata: { reason: 'USER_INACTIVE' },
          }),
        );
      });

      it('contraseña incorrecta permanece 401 genérico, audita INVALID_PASSWORD y no modifica al usuario', async () => {
        prisma.user.findFirst.mockResolvedValue({
          id: 'user-1',
          passwordHash: '$argon2id$hash',
          status: UserStatus.INACTIVE,
          failedLoginAttempts: 0,
        });
        passwordService.verify.mockResolvedValue(false);

        await expect(service.login(credentials)).rejects.toThrow(
          'Credenciales inválidas',
        );
        expect(prisma.$transaction).not.toHaveBeenCalled();
        expect(auditService.record).toHaveBeenCalledWith(
          expect.objectContaining({
            action: AuditAction.LOGIN_FAILED,
            metadata: { reason: 'INVALID_PASSWORD' },
          }),
        );
      });
    });

    it('login exitoso reinicia los intentos fallidos y limpia blockedAt', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 3,
      });
      passwordService.verify.mockResolvedValue(true);
      prisma.tx.user.update.mockResolvedValue(makeSafeUserRow());
      tokenService.sign.mockResolvedValue('signed-jwt');

      await service.login(credentials);

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.failedLoginAttempts).toBe(0);
      expect(updateArgs.data.blockedAt).toBeNull();
    });

    it('login exitoso actualiza lastLoginAt', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
      });
      passwordService.verify.mockResolvedValue(true);
      prisma.tx.user.update.mockResolvedValue(makeSafeUserRow());
      tokenService.sign.mockResolvedValue('signed-jwt');

      await service.login(credentials);

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.lastLoginAt).toBeInstanceOf(Date);
    });

    it('registra LOGIN_SUCCESS dentro de la transacción', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
      });
      passwordService.verify.mockResolvedValue(true);
      prisma.tx.user.update.mockResolvedValue(makeSafeUserRow());
      tokenService.sign.mockResolvedValue('signed-jwt');

      await service.login(credentials);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.LOGIN_SUCCESS,
          userId: 'user-1',
          client: prisma.tx,
        }),
      );
    });

    it('LOGIN_FAILED no incluye contraseña, hash ni identifier', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$secreto-hash',
        status: UserStatus.ACTIVE,
        failedLoginAttempts: 0,
      });
      passwordService.verify.mockResolvedValue(false);

      await expect(service.login(credentials)).rejects.toThrow();

      const serialized = JSON.stringify(auditService.record.mock.calls[0]);
      expect(serialized).not.toContain('Temporal1234');
      expect(serialized).not.toContain('secreto-hash');
      expect(serialized).not.toContain('jperez@demosystem.local');
    });
  });

  describe('changePassword', () => {
    const baseInput = {
      userId: 'user-1',
      currentPassword: 'Temporal1234',
      newPassword: 'NuevaClaveSegura2026',
    };

    beforeEach(() => {
      prisma.user.findUnique.mockResolvedValue({
        id: 'user-1',
        username: 'jperez',
        passwordHash: '$argon2id$hash',
      });
    });

    it('cambia la contraseña correctamente', async () => {
      passwordService.verify
        .mockResolvedValueOnce(true) // currentPassword correcta
        .mockResolvedValueOnce(false); // newPassword distinta de la actual
      passwordService.hash.mockResolvedValue('$argon2id$nuevo-hash');

      await service.changePassword(baseInput);

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.passwordHash).toBe('$argon2id$nuevo-hash');
      expect(updateArgs.data.mustChangePassword).toBe(false);
      expect(updateArgs.data.failedLoginAttempts).toBe(0);
    });

    it('contraseña actual incorrecta responde con 401', async () => {
      passwordService.verify.mockResolvedValueOnce(false);

      await expect(service.changePassword(baseInput)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('rechaza si la nueva contraseña es igual a la actual', async () => {
      passwordService.verify
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true);

      await expect(service.changePassword(baseInput)).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('aplica la política de contraseñas compartida', async () => {
      passwordService.verify.mockResolvedValueOnce(true);

      await expect(
        service.changePassword({ ...baseInput, newPassword: 'corta1' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('registra PASSWORD_CHANGED dentro de la transacción, sin contraseñas', async () => {
      passwordService.verify
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false);
      passwordService.hash.mockResolvedValue('$argon2id$nuevo-hash');

      await service.changePassword(baseInput);

      expect(auditService.record).toHaveBeenCalledWith(
        expect.objectContaining({
          action: AuditAction.PASSWORD_CHANGED,
          userId: 'user-1',
          client: prisma.tx,
        }),
      );
      const serialized = JSON.stringify(auditService.record.mock.calls[0]);
      expect(serialized).not.toContain('Temporal1234');
      expect(serialized).not.toContain('NuevaClaveSegura2026');
      expect(serialized).not.toContain('nuevo-hash');
    });
  });
});
