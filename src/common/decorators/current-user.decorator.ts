import {
  createParamDecorator,
  ExecutionContext,
  UnauthorizedException,
} from '@nestjs/common';
import { AuthenticatedRequest } from '../types/authenticated-request';
import { AuthenticatedUser } from '../types/authenticated-user';

/** Usuario adjuntado por JwtAuthGuard. La ruta debe estar protegida. */
export const CurrentUser = createParamDecorator(
  (_data: unknown, ctx: ExecutionContext): AuthenticatedUser => {
    const request = ctx.switchToHttp().getRequest<AuthenticatedRequest>();
    if (request.user === undefined) {
      throw new UnauthorizedException('No autenticado');
    }
    return request.user;
  },
);
