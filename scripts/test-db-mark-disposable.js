#!/usr/bin/env node
/**
 * Crea el marcador de una base DESCARTABLE autorizada en .env.test.local
 * (E2E_DISPOSABLE_TARGET + E2E_DISPOSABLE_TOKEN), INC-E2E-database-guard.
 *
 * Solo escribe un COMMENT ON DATABASE y solo si, tras validar la política y la
 * identidad real, la base no tiene tablas ni otros objetos de usuario (o ya
 * tiene un marcador válido para el mismo token). Nunca marca la base canónica
 * pos_db_test ni ninguna base de desarrollo.
 *
 * El marcador es una defensa adicional, NO autenticación criptográfica.
 *
 * Uso: node scripts/test-db-mark-disposable.js [--env-file f] [--local-env-file f]
 */
const guard = require('./lib/test-db-guard');

async function main(argv, deps = {}) {
  const {
    log = console.log,
    errorLog = console.error,
    inheritedEnv = process.env,
    runStatements,
  } = deps;
  try {
    const { baseFile, localFile } = guard.parseGuardCliArgs(argv);
    const result = await guard.markDisposable({
      baseFile,
      localFile,
      inheritedEnv,
      runStatements,
    });
    log(
      result.created
        ? `[test-db-guard] marcador creado en ${result.evaluated.label}` +
            `${result.boundToCluster ? ' (atado al clúster)' : ' (sin identificador de clúster: pg_control_system no disponible)'}.`
        : `[test-db-guard] ${result.evaluated.label} ya tenía un marcador válido; sin cambios.`,
    );
    return 0;
  } catch (error) {
    errorLog(
      error instanceof guard.TestDatabaseGuardError
        ? `[test-db-guard] ABORTADO: ${error.message}`
        : `[test-db-guard] ABORTADO: error inesperado (${guard.redact(error && error.message)})`,
    );
    return 1;
  }
}

module.exports = { main };

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
