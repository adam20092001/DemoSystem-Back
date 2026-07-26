import { ExecutionContext, ForbiddenException } from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { ALLOW_PENDING_PASSWORD_KEY } from '../decorators/allow-pending-password.decorator';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { PasswordChangeGuard } from './password-change.guard';

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

describe('PasswordChangeGuard', () => {
  const reflector = new Reflector();
  const guard = new PasswordChangeGuard(reflector);

  it('omite la verificación en rutas @Public()', () => {
    const handler = function handler() {};
    Reflect.defineMetadata(IS_PUBLIC_KEY, true, handler);
    const context = createContext(
      { user: { mustChangePassword: true } as never },
      handler,
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('permite rutas marcadas @AllowPendingPassword() aunque mustChangePassword sea true', () => {
    const handler = function handler() {};
    Reflect.defineMetadata(ALLOW_PENDING_PASSWORD_KEY, true, handler);
    const context = createContext(
      { user: { mustChangePassword: true } as never },
      handler,
    );

    expect(guard.canActivate(context)).toBe(true);
  });

  it('bloquea rutas normales cuando mustChangePassword es true', () => {
    const context = createContext({
      user: { mustChangePassword: true } as never,
    });

    expect(() => guard.canActivate(context)).toThrow(ForbiddenException);
  });

  it('permite rutas normales cuando mustChangePassword es false', () => {
    const context = createContext({
      user: { mustChangePassword: false } as never,
    });

    expect(guard.canActivate(context)).toBe(true);
  });
});
