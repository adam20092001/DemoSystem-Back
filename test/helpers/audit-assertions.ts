import { FORBIDDEN_AUDIT_SUBSTRINGS } from './constants';

interface AuditLogLike {
  description: string;
  metadata: unknown;
}

/**
 * Verifica que description + metadata no contengan claves/valores sensibles.
 * Deliberadamente EXCLUYE `action` (p. ej. "PASSWORD_RESET") y `entityType`,
 * que legítimamente incluyen la palabra "password" como parte del nombre de
 * la acción, no como un secreto filtrado.
 */
export function assertAuditRowHasNoSecrets(row: AuditLogLike): void {
  const serialized = JSON.stringify({
    description: row.description,
    metadata: row.metadata,
  }).toLowerCase();

  for (const forbidden of FORBIDDEN_AUDIT_SUBSTRINGS) {
    expect(serialized).not.toContain(forbidden);
  }
}
