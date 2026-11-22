import { resolve } from 'node:path';
import {
  DEFAULT_BASE_ENV_FILE,
  DEFAULT_LOCAL_ENV_FILE,
  applyEnvToProcess,
  assertTestDatabaseReady,
  issueVerifiedFingerprint,
} from '../scripts/lib/test-db-guard';

/**
 * Gate COMPLETO de seguridad de base de datos para Jest E2E (jest "globalSetup").
 *
 * Se ejecuta UNA vez, en el proceso principal de Jest, antes de cargar
 * cualquier suite, de iniciar NestJS o de ejecutar fixtures. Si lanza, Jest
 * aborta toda la ejecución: ningún archivo de prueba llega a cargarse.
 *
 *   1. Resuelve el entorno SOLO desde .env.test (+ .env.test.local); una
 *      variable heredada del shell que lo contradiga es un error.
 *   2. Aplica la política estructural (host/puerto/base exacta/usuario/params).
 *   3. Verifica la identidad real (current_database(), usuario y, si es
 *      descartable, el marcador) con una consulta de solo lectura.
 *   4. Fija DATABASE_URL validada y emite la huella del destino verificado.
 *
 * Nunca registra credenciales: solo host:puerto/base.
 */
export default async function globalSetup(): Promise<void> {
  // Se descarta cualquier huella heredada: solo vale la emitida aquí.
  delete process.env.E2E_VERIFIED_FINGERPRINT;

  const root = resolve(__dirname, '..');
  const ready = await assertTestDatabaseReady({
    baseFile: resolve(root, DEFAULT_BASE_ENV_FILE),
    localFile: resolve(root, DEFAULT_LOCAL_ENV_FILE),
    inheritedEnv: process.env,
  });

  process.env.NODE_ENV = 'test';
  applyEnvToProcess(ready.values, ready.evaluated);
  process.env.E2E_VERIFIED_FINGERPRINT = issueVerifiedFingerprint(
    ready.evaluated,
  );

  console.log(
    `\n[e2e-db-guard] destino verificado: ${ready.evaluated.kind} ` +
      `${ready.evaluated.label} (base y usuario confirmados)`,
  );
}
