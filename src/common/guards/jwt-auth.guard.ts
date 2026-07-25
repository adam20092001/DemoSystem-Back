import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { UserStatus } from '@prisma/client';
import { TokenService } from '../../auth/token.service';
import { PrismaService } from '../../database/prisma.service';
import { toSafeUser, USER_SAFE_SELECT } from '../../users/mappers/user.mapper';
import { IS_PUBLIC_KEY } from '../decorators/public.decorator';
import { AuthenticatedRequest } from '../types/authenticated-request';

/**
 * Verifica la cookie de sesión y recarga el usuario desde PostgreSQL en cada
 * petición. Nunca confía en un rol o estado guardado dentro del JWT: el
 * payload solo trae { sub }, así que status y role siempre vienen de la BD.
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

    let payload: { sub: string };
    try {
      payload = await this.tokenService.verify(token);
    } catch {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    const user = await this.prisma.user.findUnique({
      where: { id: payload.sub },
      select: USER_SAFE_SELECT,
    });
    if (user === null || user.status !== UserStatus.ACTIVE) {
      throw new UnauthorizedException('Sesión inválida o expirada');
    }

    request.user = toSafeUser(user);
    return true;
  }
}
