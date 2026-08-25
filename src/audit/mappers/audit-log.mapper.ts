import { Prisma } from '@prisma/client';
import {
  SafeAuditLogDetail,
  SafeAuditLogListItem,
} from '../types/safe-audit-log';

const AUDIT_LOG_USER_SELECT = {
  id: true,
  username: true,
  firstName: true,
  lastName: true,
} satisfies Prisma.UserSelect;

/**
 * Select compacto del listado: sin metadata, sin ipAddress (§19 del kickoff
 * aprobado). `user` es la relación opcional (AuditLog.userId puede ser
 * null, o el actor pudo eliminarse vía onDelete: SetNull): Prisma devuelve
 * `null` de forma nativa en ambos casos, sin necesidad de fabricar un
 * usuario "Sistema".
 */
export const AUDIT_LOG_LIST_SELECT = {
  id: true,
  user: { select: AUDIT_LOG_USER_SELECT },
  module: true,
  action: true,
  entityType: true,
  entityId: true,
  description: true,
  createdAt: true,
} satisfies Prisma.AuditLogSelect;

export type AuditLogListRow = Prisma.AuditLogGetPayload<{
  select: typeof AUDIT_LOG_LIST_SELECT;
}>;

export function toSafeAuditLogListItem(
  row: AuditLogListRow,
): SafeAuditLogListItem {
  return {
    id: row.id,
    user: row.user,
    module: row.module,
    action: row.action,
    entityType: row.entityType,
    entityId: row.entityId,
    description: row.description,
    createdAt: row.createdAt,
  };
}

/** Select del detalle: agrega metadata/ipAddress crudos (política de rol se aplica en el servicio/mapper de detalle, nunca en el SELECT). */
export const AUDIT_LOG_DETAIL_SELECT = {
  ...AUDIT_LOG_LIST_SELECT,
  metadata: true,
  ipAddress: true,
} satisfies Prisma.AuditLogSelect;

export type AuditLogDetailRow = Prisma.AuditLogGetPayload<{
  select: typeof AUDIT_LOG_DETAIL_SELECT;
}>;

/**
 * `includeIp` lo decide el llamador (AuditQueryService, según el rol
 * solicitante — ADMIN: true; MANAGEMENT: false) — el mapper nunca conoce
 * roles, solo aplica la bandera recibida. `metadata` se devuelve tal cual
 * Prisma la entrega (ya saneada en escritura): nunca se reinterpreta ni se
 * sanea una segunda vez aquí.
 */
export function toSafeAuditLogDetail(
  row: AuditLogDetailRow,
  options: { includeIp: boolean },
): SafeAuditLogDetail {
  return {
    ...toSafeAuditLogListItem(row),
    metadata: row.metadata,
    ipAddress: options.includeIp ? row.ipAddress : null,
  };
}
