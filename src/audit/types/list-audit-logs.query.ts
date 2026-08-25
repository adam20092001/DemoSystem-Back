import { AuditAction } from '../audit-action.enum';
import { AuditModuleName } from '../audit-module.constants';

/**
 * Consulta interna del listado de auditoría (Fase 10, Bloque E). Sin
 * ipAddress ni metadata: nunca son filtros públicos (§9/§23 del kickoff
 * aprobado). Sin ordenamiento configurable: orden fijo createdAt DESC, id
 * DESC.
 */
export interface ListAuditLogsQuery {
  page?: number;
  limit?: number;
  from?: string;
  to?: string;
  userId?: string;
  module?: AuditModuleName;
  action?: AuditAction;
  entityType?: string;
  entityId?: string;
}
