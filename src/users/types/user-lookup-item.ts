import { UserStatus } from '@prisma/client';

/**
 * Identidad mínima de un usuario para selectores de filtro (R3-B1: historial
 * de Ventas/Cobros por usuario). Deliberadamente DISTINTA de SafeUser: nunca
 * email, roles asignados, lastLoginAt, mustChangePassword ni ningún campo
 * de seguridad/administración — solo lo necesario para identificar al
 * vendedor/cobrador en pantalla. `status` se expone únicamente para que el
 * cliente pueda distinguir usuarios históricos (INACTIVE/BLOCKED), que
 * siguen apareciendo porque pueden tener Ventas/Cobros registrados.
 */
export interface UserLookupItem {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
  status: UserStatus;
}
