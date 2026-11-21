import { RoleName } from '@prisma/client';

/** Input compartido por activate/deactivate. */
export interface SupplierActionInput {
  supplierId: string;
  /** Rol ACTIVO del solicitante (R1): activar/desactivar es exclusivo de ADMIN. */
  requesterRole: RoleName;
  actorUserId: string;
  ipAddress?: string | null;
}
