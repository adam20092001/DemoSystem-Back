import { Prisma } from '@prisma/client';

/** Identidad mínima segura del actor, igual criterio que InventoryMovement/AccountingEntry. */
export interface SafeAuditLogUser {
  id: string;
  username: string;
  firstName: string;
  lastName: string;
}

/**
 * Fila compacta del listado (Fase 10, Bloque E). Nunca metadata ni
 * ipAddress: no son parte de esta forma, no se omiten condicionalmente por
 * rol — simplemente no existen en el listado.
 */
export interface SafeAuditLogListItem {
  id: string;
  user: SafeAuditLogUser | null;
  module: string;
  action: string;
  entityType: string;
  entityId: string | null;
  description: string;
  createdAt: Date;
}

/**
 * Detalle completo. `metadata` se devuelve exactamente como Prisma la
 * almacenó (ya saneada en escritura por AuditService/sanitizeAuditMetadata):
 * nunca se reinterpreta ni se sanea una segunda vez en lectura. `ipAddress`
 * siempre está presente como clave; su valor depende del rol solicitante
 * (ADMIN: real/null; MANAGEMENT: siempre null) — lo decide el servicio, el
 * mapper solo aplica la bandera que recibe.
 */
export interface SafeAuditLogDetail extends SafeAuditLogListItem {
  metadata: Prisma.JsonValue | null;
  ipAddress: string | null;
}
