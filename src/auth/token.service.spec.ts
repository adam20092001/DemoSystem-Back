import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RoleName } from '@prisma/client';
import { CookieOptions, Request, Response } from 'express';
import { CookieSameSite, EnvironmentVariables } from '../config/env.validation';
import { JwtPayload, parseExpiresInToMs, TokenService } from './token.service';

function createJwtServiceMock() {
  return {
    signAsync: jest.fn<Promise<string>, [JwtPayload]>(),
    verifyAsync: jest.fn<Promise<JwtPayload>, [string]>(),
  };
}

function createResponseMock() {
  return {
    cookie: jest.fn<void, [string, string, CookieOptions?]>(),
    clearCookie: jest.fn<void, [string, CookieOptions?]>(),
  };
}

function createConfigMock(overrides: Partial<EnvironmentVariables>) {
  const values: Partial<EnvironmentVariables> = {
    NODE_ENV: 'development' as EnvironmentVariables['NODE_ENV'],
    AUTH_COOKIE_NAME: 'demosystem_session',
    AUTH_COOKIE_SAMESITE: CookieSameSite.Lax,
    JWT_EXPIRES_IN: '8h',
    ...overrides,
  };

  return {
    get: jest.fn((key: keyof EnvironmentVariables) => values[key]),
  };
}

describe('parseExpiresInToMs', () => {
  it.each([
    ['30m', 30 * 60_000],
    ['8h', 8 * 3_600_000],
    ['1d', 1 * 86_400_000],
  ])('convierte "%s" a %i ms', (value, expected) => {
    expect(parseExpiresInToMs(value)).toBe(expected);
  });

  it('lanza con un formato inválido', () => {
    expect(() => parseExpiresInToMs('30x')).toThrow(/JWT_EXPIRES_IN/);
  });
});

describe('TokenService', () => {
  let jwtService: ReturnType<typeof createJwtServiceMock>;
  let configService: ReturnType<typeof createConfigMock>;
  let service: TokenService;

  beforeEach(() => {
    jwtService = createJwtServiceMock();
    configService = createConfigMock({});
    service = new TokenService(
      jwtService as unknown as JwtService,
      configService as unknown as ConfigService<EnvironmentVariables, true>,
    );
  });

  describe('sign', () => {
    it('firma un payload que contiene exactamente sub y activeRole', async () => {
      jwtService.signAsync.mockResolvedValue('signed-token');

      await service.sign('user-1', RoleName.SELLER);

      expect(jwtService.signAsync).toHaveBeenCalledWith({
        sub: 'user-1',
        activeRole: RoleName.SELLER,
      });
      const [payload] = jwtService.signAsync.mock.calls[0];
      expect(Object.keys(payload).sort()).toEqual(['activeRole', 'sub']);
    });
  });

  describe('verify', () => {
    it('delega la verificación en JwtService y devuelve el payload cuando activeRole es válido', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        activeRole: RoleName.SELLER,
      });

      const result = await service.verify('a-token');

      expect(jwtService.verifyAsync).toHaveBeenCalledWith('a-token');
      expect(result).toEqual({ sub: 'user-1', activeRole: RoleName.SELLER });
    });

    it('rechaza un token legado sin activeRole (pre-KAN-18)', async () => {
      jwtService.verifyAsync.mockResolvedValue({ sub: 'user-1' });

      await expect(service.verify('legacy-token')).rejects.toThrow();
    });

    it('rechaza un activeRole que no es un RoleName real', async () => {
      jwtService.verifyAsync.mockResolvedValue({
        sub: 'user-1',
        activeRole: 'NOT_A_REAL_ROLE',
      });

      await expect(service.verify('a-token')).rejects.toThrow();
    });
  });

  describe('extractFromRequest', () => {
    it('lee el token desde la cookie configurada', () => {
      const request = {
        cookies: { demosystem_session: 'cookie-token' },
      } as unknown as Request;

      expect(service.extractFromRequest(request)).toBe('cookie-token');
    });

    it('devuelve undefined si la cookie no está presente', () => {
      const request = { cookies: {} } as unknown as Request;

      expect(service.extractFromRequest(request)).toBeUndefined();
    });
  });

  describe('setAuthCookie', () => {
    it('establece la cookie con httpOnly, path y maxAge coherente con JWT_EXPIRES_IN', () => {
      configService = createConfigMock({ JWT_EXPIRES_IN: '1d' });
      service = new TokenService(
        jwtService as unknown as JwtService,
        configService as unknown as ConfigService<EnvironmentVariables, true>,
      );
      const response = createResponseMock();

      service.setAuthCookie(response as unknown as Response, 'a-token');

      expect(response.cookie).toHaveBeenCalledWith(
        'demosystem_session',
        'a-token',
        expect.objectContaining({
          httpOnly: true,
          path: '/',
          maxAge: 86_400_000,
        }),
      );
    });

    it('usa Secure=true cuando NODE_ENV=production', () => {
      configService = createConfigMock({
        NODE_ENV: 'production' as EnvironmentVariables['NODE_ENV'],
      });
      service = new TokenService(
        jwtService as unknown as JwtService,
        configService as unknown as ConfigService<EnvironmentVariables, true>,
      );
      const response = createResponseMock();

      service.setAuthCookie(response as unknown as Response, 'a-token');

      const options = response.cookie.mock.calls[0][2];
      expect(options?.secure).toBe(true);
    });

    it('usa Secure=false fuera de producción', () => {
      const response = createResponseMock();

      service.setAuthCookie(response as unknown as Response, 'a-token');

      const options = response.cookie.mock.calls[0][2];
      expect(options?.secure).toBe(false);
    });

    it('aplica el SameSite configurado', () => {
      configService = createConfigMock({
        AUTH_COOKIE_SAMESITE: CookieSameSite.Strict,
      });
      service = new TokenService(
        jwtService as unknown as JwtService,
        configService as unknown as ConfigService<EnvironmentVariables, true>,
      );
      const response = createResponseMock();

      service.setAuthCookie(response as unknown as Response, 'a-token');

      const options = response.cookie.mock.calls[0][2];
      expect(options?.sameSite).toBe(CookieSameSite.Strict);
    });
  });

  describe('clearAuthCookie', () => {
    it('elimina la cookie con el mismo nombre, path y atributos', () => {
      const response = createResponseMock();

      service.clearAuthCookie(response as unknown as Response);

      expect(response.clearCookie).toHaveBeenCalledWith(
        'demosystem_session',
        expect.objectContaining({
          httpOnly: true,
          path: '/',
          sameSite: CookieSameSite.Lax,
        }),
      );
    });

    it('no incluye maxAge al limpiar la cookie', () => {
      const response = createResponseMock();

      service.clearAuthCookie(response as unknown as Response);

      const options = response.clearCookie.mock.calls[0][1];
      expect(options?.maxAge).toBeUndefined();
    });
  });
});
