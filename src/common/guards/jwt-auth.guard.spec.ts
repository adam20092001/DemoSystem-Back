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

/**
 * KAN-18, Bloque A: `roles` reemplaza a la relación singular `role` — un
 * usuario puede tener uno o más UserRole, cada uno con su Role anidado.
 */
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
    roles: [{ role: { name: RoleName.SELLER } }],
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

  it('rechaza un token legado sin activeRole (TokenService.verify ya lo rechaza)', async () => {
    tokenService.extractFromRequest.mockReturnValue('legacy-token');
    tokenService.verify.mockRejectedValue(
      new Error('Token de sesión con formato inválido (falta activeRole)'),
    );
    const context = createContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rechaza si el usuario del token ya no existe', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({
      sub: 'missing-id',
      activeRole: RoleName.SELLER,
    });
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
      tokenService.verify.mockResolvedValue({
        sub: 'user-1',
        activeRole: RoleName.SELLER,
      });
      prisma.user.findUnique.mockResolvedValue(makeUserRow({ status }));
      const context = createContext({});

      await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
        UnauthorizedException,
      );
    },
  );

  it('adjunta el usuario seguro a request.user cuando el activeRole está asignado', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({
      sub: 'user-1',
      activeRole: RoleName.SELLER,
    });
    prisma.user.findUnique.mockResolvedValue(makeUserRow());
    const request: Partial<AuthenticatedRequest> = {};
    const context = createContext(request);

    await expect(guard.canActivate(context)).resolves.toBe(true);
    expect(request.user).toEqual(
      expect.objectContaining({ id: 'user-1', role: RoleName.SELLER }),
    );
    expect(request.user).not.toHaveProperty('passwordHash');
    expect(request.user).not.toHaveProperty('roles');
  });

  it('acepta un activeRole distinto entre varios roles asignados (ADMIN + SELLER, activo SELLER)', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({
      sub: 'user-1',
      activeRole: RoleName.SELLER,
    });
    prisma.user.findUnique.mockResolvedValue(
      makeUserRow({
        roles: [
          { role: { name: RoleName.ADMIN } },
          { role: { name: RoleName.SELLER } },
        ],
      }),
    );
    const request: Partial<AuthenticatedRequest> = {};
    const context = createContext(request);

    await guard.canActivate(context);

    expect(request.user?.role).toBe(RoleName.SELLER);
  });

  it('rechaza un activeRole que ya no está entre los roles asignados (revocado tras emitir el token)', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({
      sub: 'user-1',
      activeRole: RoleName.ADMIN,
    });
    // El usuario ahora solo tiene SELLER: ADMIN le fue quitado después de
    // que este token se emitió.
    prisma.user.findUnique.mockResolvedValue(
      makeUserRow({ roles: [{ role: { name: RoleName.SELLER } }] }),
    );
    const context = createContext({});

    await expect(guard.canActivate(context)).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('no confía en el activeRole del token solo porque esté firmado: siempre lo revalida en vivo contra PostgreSQL', async () => {
    tokenService.extractFromRequest.mockReturnValue('a-token');
    tokenService.verify.mockResolvedValue({
      sub: 'user-1',
      activeRole: RoleName.ADMIN,
    });
    prisma.user.findUnique.mockResolvedValue(
      makeUserRow({ roles: [{ role: { name: RoleName.ADMIN } }] }),
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
