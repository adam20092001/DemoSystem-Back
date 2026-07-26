import { ExecutionContext, UnauthorizedException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName, UserStatus } from '@prisma/client';
import { PrismaService } from '../../database/prisma.service';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { JwtAuthGuard } from './jwt-auth.guard';

const NOW = new Date('2026-01-01T00:00:00.000Z');

function createContext(
  request: Partial<AuthenticatedRequest>,
  handler: object = function handler() {},
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class DummyController {},
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function makeUserRow(overrides: Partial<Record<string, unknown>> = {}) {
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

describe('JwtAuthGuard', () => {
  const reflector = new Reflector();
  let tokenService: { extractFromRequest: jest.Mock; verify: jest.Mock };
  let prisma: { user: { findUnique: jest.Mock } };
  let guard: JwtAuthGuard;

  beforeEach(() => {
    tokenService = { extractFromRequest: jest.fn(), verify: jest.fn() };
    prisma = { user: { findUnique: jest.fn() } };
    guard = new JwtAuthGuard(
      reflector,
      tokenService as never,
      prisma as unknown as PrismaService,
    );
  });

  it('omite la verificación en rutas @Public()', async () => {
    const handler = function handler() {};
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    const context = createContext({}, handler);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(tokenService.extractFromRequest).not.toHaveBeenCalled();
  });

  it('rechaza cuando no hay cookie de sesión', async () => {
    tokenService.extractFromRequest.mockReturnValue(undefined);
    const context = createContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza un JWT inválido o expirado', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockRejectedValue(new Error('invalid signature'));
    const context = createContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('rechaza si el usuario del token ya no existe', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({ sub: 'missing-id' });
    prisma.user.findUnique.mockResolvedValue(null);
    const context = createContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it.each([UserStatus.INACTIVE, UserStatus.BLOCKED])(
    'rechaza un usuario con estado %s',
    async (status) => {
      tokenService.extractFromRequest.mockReturnValue('a-token');
      tokenService.verify.mockResolvedValue({ sub: 'user-1' });
      prisma.user.findUnique.mockResolvedValue(makeUserRow({ status }));
      const context = createContext({});

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('adjunta el usuario seguro a request.user cuando el token y el estado son válidos', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({ sub: 'user-1' });
    prisma.user.findUnique.mockResolvedValue(makeUserRow());
    const request: Partial<AuthenticatedRequest> = {};
    const context = createContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(
      expect.objectContaining({ id: 'user-1', role: RoleName.SELLER }),
    );
    expect(request.user).not.toHaveProperty('passwordHash');
  });

  it('no confía en un rol del token: siempre consulta el rol en PostgreSQL', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({ sub: 'user-1' });
    prisma.user.findUnique.mockResolvedValue(
      makeUserRow({ role: { name: RoleName.ADMIN } }),
    );
    const request: Partial<AuthenticatedRequest> = {};
    const context = createContext(request);

    await guard.canActivate(context);

    expect(prisma.user.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'user-1' } }),
    );
    expect(request.user?.role).toBe(RoleName.ADMIN);
  });
});
