import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { RoleName } from '@prisma/client';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { ROLES_KEY } from '../decorators/roles.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { RolesGuard } from './roles.guard';

function createContext(
  request: Partial<AuthenticatedRequest>,
  handler: object = function handler() {},
): ExecutionContext {
  return {
    getHandler: () => handler,
    getClass: () => class DummyController {},
    switchToHttp: () => ({ getRequest: () => request }),
  } as unknown as ExecutionContext;
}

describe('RolesGuard', () => {
  const reflector = new Reflector();
  const guard = new RolesGuard(reflector);

  it('omite la verificación en rutas @Public()', () => {
    const handler = function handler() {};
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    const context = createContext({}, handler);

    expect(guard.canActivate(context)).toBe(true);
  });

  it('permite el acceso cuando la ruta no declara @Roles()', () => {
    const context = createContext({
      user: { role: RoleName.SELLER } as never,
    });

    expect(guard.canActivate(context)).toBe(true);
  });

  it('permite el acceso cuando el rol coincide', () => {
    const handler = function handler() {};
    Reflect.defineMetadata(ROLES_KEY, [RoleName.ADMIN], handler);
    const context = createContext(
      { user: { role: RoleName.ADMIN } as never },
      handler,
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('rechaza cuando el rol no coincide', () => {
    const handler = function handler() {};
    Reflect.defineMetadata(ROLES_KEY, [RoleName.ADMIN], handler);
    const context = createContext(
      { user: { role: RoleName.SELLER } as never },
      handler,
    );

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });
});
