import { SafeUser } from '../../users/types/safe-user';

/**
 * Usuario adjuntado a request.user por JwtAuthGuard. Es la misma forma
 * segura que devuelve UsersService: nunca passwordHash, failedLoginAttempts
 * ni roleId. El guard la recarga desde PostgreSQL en cada petición.
 */
export type AuthenticatedUser = SafeUser;
