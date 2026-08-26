import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserStatus } from '@prisma/client';
import { JwtPayload, TokenService } from '../../auth/token.service';
import { PrismaService } from '../../database/prisma.service';
import {
  hasAssignedRole,
  toAuthenticatedUser,
  USER_WITH_ROLES_SELECT,
} from '../../users/mappers/user.mapper';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Verifica la cookie de sesión y recarga el usuario desde PostgreSQL en cada
 * petición. Nunca confía en un rol o estado guardado dentro del JWT más
 * allá de su forma: el payload trae { sub, activeRole }, pero activeRole
 * SOLO se acepta si sigue estando entre los roles actualmente asignados al
 * usuario (KAN-18, Bloque A) — status y la vigencia del rol siempre se
 * verifican en vivo, nunca solo porque el JWT esté firmado. Una única
 * consulta (select anidado, sin N+1) trae el usuario con su colección
 * completa de roles asignados; request.user solo expone el rol ACTIVO ya
 * validado (nunca la colección completa) para no alterar el contrato que
 * el resto del sistema espera de request.user.role.
 */
@Injectable()
export class JwtAuthGuard implements CanActivate {
  constructor(
    private readonly reflector: Reflector,
    private readonly tokenService: TokenService,
    private readonly prisma: PrismaService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);
    if (isPublic === true) {
      return true;
    }

    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const token = this.tokenService.extractFromRequest(request);
    if (token === undefined) {
      throw new UnauthorizedException('No autenticado');
    }

    let payload: JwtPayload;
    try {
      payload = await this.tokenService.verify(token);
    } catch {
      // Cubre firma inválida/expirada Y un token legado pre-KAN-18 sin
      // activeRole estructuralmente válido (ver TokenService.verify()):
      // ambos se tratan igual, forzando un login nuevo.
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: USER_WITH_ROLES_SELECT,
    });
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    // El rol activo del JWT debe seguir asignado AHORA MISMO: si un
    // administrador lo quitó después de emitir el token, la sesión deja de
    // ser válida de inmediato (siguiente petición -> 401), sin esperar a la
    // expiración del JWT ni requerir listas de revocación.
    if (!hasAssignedRole(user, payload.activeRole)) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    request.user = toAuthenticatedUser(user, payload.activeRole);
    return true;
  }
}
