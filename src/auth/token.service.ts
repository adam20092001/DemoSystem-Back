import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { RoleName } from '@prisma/client';
import { CookieOptions, Request, Response } from 'express';
import { EnvironmentVariables, NodeEnv } from '../config/env.validation';

/**
 * KAN-18, Bloque A: `activeRole` es el único rol de ESTA sesión (nunca la
 * colección completa de roles asignados del usuario, que vive en
 * PostgreSQL vía UserRole, jamás en el JWT). Un token legado pre-KAN-18
 * (solo `{ sub }`) no tiene esta propiedad — TokenService.verify() lo
 * rechaza explícitamente, sin fallback ni asignación silenciosa de rol.
 */
export interface JwtPayload {
  sub: string;
  activeRole: RoleName;
}

const VALID_ROLE_NAMES: ReadonlySet<string> = new Set(Object.values(RoleName));

function isValidRoleName(value: unknown): value is RoleName {
  return typeof value === 'string' && VALID_ROLE_NAMES.has(value);
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
 * viaja. El payload contiene únicamente { sub: userId, activeRole } — nunca
 * la colección completa de roles asignados, email ni ningún otro dato del
 * usuario: el guard siempre recarga el usuario desde PostgreSQL en cada
 * petición y revalida ahí mismo que activeRole siga vigente (KAN-18,
 * Bloque A) — nunca confía en el rol solo porque el JWT esté firmado.
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

  sign(userId: string, activeRole: RoleName): Promise<string> {
    const payload: JwtPayload = { sub: userId, activeRole };
    return this.jwtService.signAsync(payload);
  }

  /**
   * Verifica la firma/expiración Y la forma estructural del payload: un
   * token legado pre-KAN-18 (solo `{ sub }`, sin activeRole, o con un
   * activeRole que no es un RoleName real) se rechaza aquí mismo, igual que
   * una firma inválida — nunca recibe un rol por defecto en silencio. Esto
   * fuerza un login nuevo tras el despliegue, sin infraestructura de
   * revocación adicional: el propio contrato estructural del payload basta.
   */
  async verify(token: string): Promise<JwtPayload> {
    const payload = await this.jwtService.verifyAsync<JwtPayload>(token);
    if (
      typeof payload.sub !== 'string' ||
      !isValidRoleName(payload.activeRole)
    ) {
      throw new Error(
        'Token de sesión con formato inválido (falta activeRole)',
      );
    }
    return payload;
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
