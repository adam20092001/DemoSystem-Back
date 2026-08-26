import { RoleName } from '@prisma/client';
import { SafeUserBase } from '../../users/types/safe-user';

/**
 * Forma de la respuesta de sesión (KAN-18, Bloque A, §17 del kickoff
 * aprobado): dedicada a login/`GET /auth/me` de sesión completa, deliberadamente
 * distinta del DTO de administración persistente de usuarios (UserResponseDto/
 * SafeUser). `roles` son TODOS los roles asignados (para que el frontend
 * sepa qué otras opciones existen); `activeRole` es el rol con el que esta
 * sesión concreta quedó autenticada — elegido por resolveDefaultActiveRole()
 * en el login, el mismo valor que termina validado en el JWT.
 *
 * Usuario de un solo rol: `roles` tiene un elemento y `activeRole` es ese
 * mismo valor — comportamiento idéntico al existente antes de KAN-18.
 */
export interface AuthSessionUser extends SafeUserBase {
  roles: RoleName[];
  activeRole: RoleName;
}
