import { resolve } from 'node:path';
import {
  DEFAULT_BASE_ENV_FILE,
  DEFAULT_LOCAL_ENV_FILE,
  applyEnvToProcess,
  assertVerifiedFingerprint,
  resolveTarget,
  type EvaluatedTarget,
  type ResolvedTarget,
} from '../../scripts/lib/test-db-guard';

/**
 * Punto ÚNICO (síncrono, sin conexión) por el que las suites E2E obtienen el
 * destino de base de datos. Reutiliza la guardia compartida de
 * scripts/lib/test-db-guard.js; no existe ninguna comprobación por texto.
 *
 * La verificación de identidad real (current_database(), marcador) ocurre una
 * sola vez en jest-e2e.global-setup.ts, ANTES de cargar cualquier suite; aquí
 * solo se reevalúa la política estructural y se exige que la huella del
 * destino la haya emitido ese globalSetup en esta misma ejecución.
 */
const REPO_ROOT = resolve(__dirname, '../..');

export function resolveE2eTarget(): ResolvedTarget {
  return resolveTarget({
    baseFile: resolve(REPO_ROOT, DEFAULT_BASE_ENV_FILE),
    localFile: resolve(REPO_ROOT, DEFAULT_LOCAL_ENV_FILE),
    inheritedEnv: process.env,
  });
}

/** Lanza TestDatabaseGuardError si el destino no está autorizado o verificado. */
export function assertVerifiedE2eTarget(): EvaluatedTarget {
  const { evaluated } = resolveE2eTarget();
  assertVerifiedFingerprint(evaluated, process.env.E2E_VERIFIED_FINGERPRINT);
  return evaluated;
}

/**
 * Validación por archivo de prueba (jest "setupFiles"): reevalúa la política,
 * exige la huella emitida por el globalSetup y deja en process.env las
 * variables de .env.test (sin sobrescribir las ya definidas) con
 * DATABASE_URL fijada al destino validado.
 */
export function bootstrapVerifiedE2eEnv(): EvaluatedTarget {
  const { evaluated, values } = resolveE2eTarget();
  assertVerifiedFingerprint(evaluated, process.env.E2E_VERIFIED_FINGERPRINT);
  applyEnvToProcess(values, evaluated);
  return evaluated;
}
