import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RoleName, UserStatus } from '@prisma/client';
import { AuditAction } from '../audit/audit-action.enum';
import { AuditService } from '../audit/audit.service';
import { EnvironmentVariables } from '../config/env.validation';
import { PrismaService } from '../database/prisma.service';
import { AuthService } from './auth.service';
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
    role: { name: RoleName.SELLER },
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
    sign: jest.fn<Promise<string>, [string]>(),
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

      await expect(service.login(credentials)).rejects.toThrow();

      const updateArgs = prisma.tx.user.update.mock.calls[0][0];
      expect(updateArgs.data.failedLoginAttempts).toBe(5);
      expect(updateArgs.data.status).toBe(UserStatus.BLOCKED);
      expect(updateArgs.data.blockedAt).toBeInstanceOf(Date);
    });

    it('usuario INACTIVE responde con 401 genérico sin incrementar intentos', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.INACTIVE,
        failedLoginAttempts: 0,
      });

      await expect(service.login(credentials)).rejects.toThrow(
        'Credenciales inválidas',
      );
      expect(passwordService.verify).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('usuario BLOCKED responde con 401 genérico sin incrementar intentos', async () => {
      prisma.user.findFirst.mockResolvedValue({
        id: 'user-1',
        passwordHash: '$argon2id$hash',
        status: UserStatus.BLOCKED,
        failedLoginAttempts: 5,
      });

      await expect(service.login(credentials)).rejects.toThrow(
        'Credenciales inválidas',
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
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
