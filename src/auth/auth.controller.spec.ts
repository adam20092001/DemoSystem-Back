import { RoleName, UserStatus } from '@prisma/client';
import { Request, Response } from 'express';
import { AuthenticatedUser } from '../common/types/authenticated-user';
import { AuthController } from './auth.controller';
import { AuthService } from './auth.service';
import { TokenService } from './token.service';

const HTTP_CODE_METADATA = '__httpCode__';
const NOW = new Date('2026-01-01T00:00:00.000Z');

/** Evita que TS trate la referencia como un método enlazable (unbound-method). */
const controllerPrototype = AuthController.prototype as unknown as Record<
  string,
  object
>;

function createAuthServiceMock() {
  return {
    login: jest.fn<
      Promise<{ user: AuthenticatedUser; token: string }>,
      [{ identifier: string; password: string; ipAddress?: string | null }]
    >(),
    changePassword: jest.fn<
      Promise<void>,
      [
        {
          userId: string;
          currentPassword: string;
          newPassword: string;
          ipAddress?: string | null;
        },
      ]
    >(),
  };
}

function createTokenServiceMock() {
  return {
    setAuthCookie: jest.fn<void, [Response, string]>(),
    clearAuthCookie: jest.fn<void, [Response]>(),
  };
}

function makeSafeUser(): AuthenticatedUser {
  return {
    id: 'user-1',
    firstName: 'Juan',
    lastName: 'Pérez',
    username: 'jperez',
    email: 'jperez@demosystem.local',
    role: RoleName.SELLER,
    status: UserStatus.ACTIVE,
    mustChangePassword: false,
    lastLoginAt: null,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

describe('AuthController', () => {
  let authService: ReturnType<typeof createAuthServiceMock>;
  let tokenService: ReturnType<typeof createTokenServiceMock>;
  let controller: AuthController;

  beforeEach(() => {
    authService = createAuthServiceMock();
    tokenService = createTokenServiceMock();
    controller = new AuthController(
      authService as unknown as AuthService,
      tokenService as unknown as TokenService,
    );
  });

  describe('login', () => {
    it('establece la cookie de sesión y devuelve el usuario sin el token', async () => {
      const safeUser = makeSafeUser();
      authService.login.mockResolvedValue({
        user: safeUser,
        token: 'jwt-firmado',
      });
      const response = {} as Response;
      const request = { ip: '127.0.0.1' } as unknown as Request;

      const result = await controller.login(
        { identifier: 'jperez', password: 'Temporal1234' },
        request,
        response,
      );

      expect(tokenService.setAuthCookie).toHaveBeenCalledWith(
        response,
        'jwt-firmado',
      );
      expect(result).toBe(safeUser);
      expect(JSON.stringify(result)).not.toContain('jwt-firmado');
    });

    it('responde con HTTP 200 (no 201, al no ser una creación)', () => {
      const code = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        controllerPrototype.login,
      ) as number;
      expect(code).toBe(200);
    });
  });

  describe('logout', () => {
    it('elimina la cookie de sesión', () => {
      const response = {} as Response;

      controller.logout(response);

      expect(tokenService.clearAuthCookie).toHaveBeenCalledWith(response);
    });

    it('responde con HTTP 204', () => {
      const code = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        controllerPrototype.logout,
      ) as number;
      expect(code).toBe(204);
    });
  });

  describe('me', () => {
    it('devuelve exactamente el usuario adjuntado por el guard', () => {
      const safeUser = makeSafeUser();

      expect(controller.me(safeUser)).toBe(safeUser);
    });
  });

  describe('changePassword', () => {
    it('delega en AuthService y responde con HTTP 204', async () => {
      authService.changePassword.mockResolvedValue(undefined);
      const request = { ip: '127.0.0.1' } as unknown as Request;

      await controller.changePassword(
        makeSafeUser(),
        {
          currentPassword: 'Temporal1234',
          newPassword: 'NuevaClaveSegura2026',
        },
        request,
      );

      expect(authService.changePassword).toHaveBeenCalledWith({
        userId: 'user-1',
        currentPassword: 'Temporal1234',
        newPassword: 'NuevaClaveSegura2026',
        ipAddress: '127.0.0.1',
      });

      const code = Reflect.getMetadata(
        HTTP_CODE_METADATA,
        controllerPrototype.changePassword,
      ) as number;
      expect(code).toBe(204);
    });
  });
});
