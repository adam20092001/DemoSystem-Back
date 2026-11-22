#!/usr/bin/env node
/**
 * Ejecuta un comando Prisma TEST (migrate deploy / db seed) SOLO después de
 * validar el destino con la guardia compartida (INC-E2E-database-guard).
 *
 * Uso: node scripts/run-with-test-db.js [--env-file f] [--local-env-file f] <comando> [args...]
 *
 * Flujo (todo antes de lanzar el hijo):
 *   1. Resuelve el entorno SOLO desde .env.test (+ .env.test.local). Una
 *      DATABASE_URL o autorización heredada del shell que contradiga a los
 *      archivos aborta (a diferencia de run-with-env.js, que se conserva
 *      intacto para db:seed:demo y no valida nada).
 *   2. Política estructural + identidad real (current_database(), usuario y,
 *      si es descartable, marcador).
 *   3. Construye EXPLÍCITAMENTE el entorno del hijo: DATABASE_URL validada, sin
 *      claves de autorización ni huellas heredadas.
 *   4. Lanza el comando. Si cualquier paso falla, no se lanza nada.
 *
 * Ventana residual (documentada): el hijo abre su propia conexión después de
 * esta verificación; no hay forma de compartir la conexión con la CLI de Prisma.
 */
const { spawnSync } = require('node:child_process');
const guard = require('./lib/test-db-guard');

/** Entorno del proceso hijo: heredado, sin claves de autorización, con DATABASE_URL validada. */
function buildChildEnv({ inherited, values, evaluated }) {
  const env = { ...inherited };
  for (const key of guard.NEVER_EXPORT_KEYS) delete env[key];
  guard.applyEnvToProcess(values, evaluated, env);
  return env;
}

function quoteArg(arg) {
  return /\s/.test(arg) ? `"${arg.replace(/"/g, '\\"')}"` : arg;
}

async function main(argv, deps = {}) {
  const {
    spawn = spawnSync,
    log = console.log,
    errorLog = console.error,
    runStatements,
  } = deps;
  // Copia tomada ANTES de cualquier cliente Prisma (que carga el .env de
  // desarrollo en process.env): es la única base del entorno del hijo.
  const inheritedEnv = { ...(deps.inheritedEnv ?? process.env) };
  try {
    const { baseFile, localFile, rest } = guard.parseGuardCliArgs(argv);
    const [command, ...args] = rest;
    if (!command) {
      throw new guard.TestDatabaseGuardError(
        guard.CODES.CLI_USAGE,
        'Uso: node scripts/run-with-test-db.js [--env-file f] <comando> [args...]',
      );
    }
    const ready = await guard.assertTestDatabaseReady({
      baseFile,
      localFile,
      inheritedEnv,
      runStatements,
    });
    log(
      `[test-db-guard] destino verificado: ${ready.evaluated.kind} ` +
        `${ready.evaluated.label} (base y usuario confirmados)`,
    );
    const env = buildChildEnv({
      inherited: inheritedEnv,
      values: ready.values,
      evaluated: ready.evaluated,
    });
    // Línea única (no args + shell) para evitar la advertencia DEP0190 de Node.
    const child = spawn([command, ...args].map(quoteArg).join(' '), {
      stdio: 'inherit',
      shell: true,
      env,
    });
    return child.status ?? 1;
  } catch (error) {
    errorLog(
      error instanceof guard.TestDatabaseGuardError
        ? `[test-db-guard] ABORTADO: ${error.message}`
        : `[test-db-guard] ABORTADO: error inesperado (${guard.redact(error && error.message)})`,
    );
    return 1;
  }
}

module.exports = { main, buildChildEnv };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
