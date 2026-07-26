import { SetMetadata } from '@nestjs/common';

export const ALLOW_PENDING_PASSWORD_KEY = 'allowPendingPassword';

/** Permite acceder aunque mustChangePassword sea true (PasswordChangeGuard). */
export const AllowPendingPassword = (): MethodDecorator & ClassDecorator =>
  SetMetadata(ALLOW_PENDING_PASSWORD_KEY, true);
