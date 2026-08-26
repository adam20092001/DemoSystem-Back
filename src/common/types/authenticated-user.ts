import { RoleName } from '@prisma/client';
import { SafeUserBase } from '../../users/types/safe-user';

/**
 * Usuario adjuntado a request.user por JwtAuthGuard (KAN-18, Bloque A).
 *
 * Deliberadamente DISTINTO de SafeUser: SafeUser representa la
 * administración persistente de un usuario (uno o más roles asignados,
 * `roles: RoleName[]`); AuthenticatedUser representa el actor de ESTA
 * sesión/request, con exactamente un `role` — el rol ACTIVO validado en
 * vivo contra PostgreSQL en cada petición (nunca confiado solo porque el
 * JWT esté firmado). `RolesGuard`/`@Roles()`/`actor.role`/`requesterRole`
 * en todo el resto del sistema siguen comparando este único valor escalar,
 * sin ningún cambio: la autorización de cada módulo de negocio nunca ve la
 * colección completa de roles asignados, solo el activo ya resuelto.
 */
export interface AuthenticatedUser extends SafeUserBase {
  role: RoleName;
}
