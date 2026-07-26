import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { CookieOptions, Request, Response } from 'express';
import { EnvironmentVariables, NodeEnv } from '../config/env.validation';

export interface JwtPayload {
  sub: string;
}

const EXPIRES_IN_UNIT_MS: Record<string, number> = {
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
};

/** Traduce "30m" | "8h" | "1d" a milisegundos, para el maxAge de la cookie. */
export function parseExpiresInToMs(expiresIn: string): number {
  const match = /^(\d+)(m|h|d)$/.exec(expiresIn);
  if (match === null) {
    throw new Error(`Formato de JWT_EXPIRES_IN inválido: ${expiresIn}`);
  }
  const [, amount, unit] = match;
  return Number(amount) * EXPIRES_IN_UNIT_MS[unit];
}

/**
 * Firma y verifica el JWT de sesión, y gestiona la cookie HttpOnly donde
 * viaja. El payload contiene únicamente { sub: userId } — nunca rol, email
 * ni ningún otro dato del usuario: el guard siempre recarga desde PostgreSQL.
 */
@Injectable()
export class TokenService {
  constructor(
    private readonly jwtService: JwtService,
    private readonly configService: ConfigService<EnvironmentVariables, true>,
  ) {}

  get cookieName(): string {
    return this.configService.get('AUTH_COOKIE_NAME', { infer: true });
  }

  sign(userId: string): Promise<string> {
    const payload: JwtPayload = { sub: userId };
    return this.jwtService.signAsync(payload);
  }

  verify(token: string): Promise<JwtPayload> {
    return this.jwtService.verifyAsync<JwtPayload>(token);
  }

  /** Lee la cookie de sesión de la petición. No confía en ningún otro origen. */
  extractFromRequest(request: Request): string | undefined {
    const cookies = request.cookies as Record<string, string> | undefined;
    return cookies?.[this.cookieName];
  }

  setAuthCookie(response: Response, token: string): void {
    const expiresIn = this.configService.get('JWT_EXPIRES_IN', {
      infer: true,
    });
    response.cookie(
      this.cookieName,
      token,
      this.buildCookieOptions(parseExpiresInToMs(expiresIn)),
    );
  }

  clearAuthCookie(response: Response): void {
    response.clearCookie(this.cookieName, this.buildCookieOptions());
  }

  private buildCookieOptions(maxAge?: number): CookieOptions {
    const nodeEnv = this.configService.get('NODE_ENV', { infer: true });
    const sameSite = this.configService.get('AUTH_COOKIE_SAMESITE', {
      infer: true,
    });

    return {
      httpOnly: true,
      secure: nodeEnv === NodeEnv.Production,
      sameSite,
      path: '/',
      ...(maxAge !== undefined ? { maxAge } : {}),
    };
  }
}
