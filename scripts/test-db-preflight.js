#!/usr/bin/env node
/**
 * Preflight de `db:test:reset` (INC-E2E-database-guard). Se ejecuta ANTES de
 * la limpieza destructiva del volumen y es de SOLO LECTURA.
 *
 * Verifica, sin modificar nada:
 *   1. Destino TEST canónico (política compartida) y que NO haya autorización
 *      de base descartable (el reset solo aplica al servicio `db_test`).
 *   1b. Que el demonio Docker sea LOCAL (M2): sin DOCKER_HOST y con un
 *      contexto cuyo endpoint real sea un pipe/socket local.
 *   2. Que el servicio `db_test` de Docker Compose (config efectiva) sea
 *      coherente con el destino: container_name, base, usuario, volumen de
 *      datos y PUERTO PUBLICADO igual al de la política (Compose no lee
 *      .env.test: un TEST_POSTGRES_PORT solo en ese archivo no cambia el
 *      contenedor).
 *   3. El recurso Docker concreto que se destruiría: reutiliza las funciones
 *      de db-test-clean-volume.js (volumen por etiquetas de Compose, montaje
 *      del contenedor, decideCleanupPlan) y además exige que el contenedor,
 *      si existe, sea el servicio db_test del mismo proyecto con el puerto
 *      esperado.
 *   4. Si el contenedor está en ejecución, la identidad real de la base
 *      (current_database() y usuario). Si está detenido o no existe, NO se
 *      afirma nada sobre la base: solo se valida el recurso Docker.
 *
 * Límite documentado: la limpieza (db-test-clean-volume.js, sin cambios)
 * vuelve a resolver el recurso con las mismas funciones unos instantes
 * después; no hay forma de pasarle el recurso ya resuelto sin modificarlo.
 * Su verificación cruzada propia (etiquetas + montaje, fail-safe) sigue
 * siendo la última defensa.
 */
const { spawnSync } = require('node:child_process');
const guard = require('./lib/test-db-guard');
const clean = require('./db-test-clean-volume');

const DB_SERVICE = 'db_test';
const POSTGRES_INTERNAL_PORT = 5432;

function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

function mismatch(message) {
  return new guard.TestDatabaseGuardError(guard.CODES.COMPOSE_MISMATCH, message);
}

function unverified(message) {
  return new guard.TestDatabaseGuardError(guard.CODES.RESOURCE_UNVERIFIED, message);
}

function notLocal(message) {
  return new guard.TestDatabaseGuardError(guard.CODES.DOCKER_NOT_LOCAL, message);
}

/** Endpoints de demonio considerados locales (M2). TCP/SSH/HTTP nunca lo son. */
const LOCAL_DOCKER_ENDPOINTS = [
  /^npipe:\/\/\/\/\.\/pipe\/[A-Za-z0-9_.-]+$/, // Windows: pipe de la propia máquina
  /^unix:\/\/\/[A-Za-z0-9_./-]+$/, // socket Unix local, sin host
];
const CONTEXT_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.+-]{0,199}$/;

/**
 * M2: el reset solo puede operar sobre un demonio Docker LOCAL. Se inspecciona
 * la configuración efectiva (DOCKER_HOST, DOCKER_CONTEXT, contexto activo) y
 * el ENDPOINT REAL del contexto, no su nombre (un contexto llamado `default`
 * o `desktop-linux` podría apuntar a un servidor remoto). Todo lo que no pueda
 * comprobarse con certeza provoca rechazo. Solo lectura.
 *
 * Límite: los comandos posteriores del reset (limpieza, `compose up`, deploy)
 * son procesos distintos que releen el contexto; si alguien ejecuta
 * `docker context use` entre ellos, esta comprobación no lo detecta.
 */
function assertLocalDockerDaemon(run, inheritedEnv) {
  if (isDefinedText(inheritedEnv.DOCKER_HOST)) {
    throw notLocal(
      'DOCKER_HOST está definido en el entorno: el reset se rechaza porque ' +
        'puede redirigir Docker a otro servidor. Elimina la variable y usa el ' +
        'contexto local (Docker Desktop).',
    );
  }
  const shown = run('docker', ['context', 'show']);
  if (shown.status !== 0) {
    throw notLocal('No se pudo determinar el contexto activo de Docker.');
  }
  const name = String(shown.stdout || '').trim();
  if (!CONTEXT_NAME_RE.test(name)) {
    throw notLocal('El nombre del contexto activo de Docker no es válido o está vacío.');
  }
  if (isDefinedText(inheritedEnv.DOCKER_CONTEXT) && inheritedEnv.DOCKER_CONTEXT !== name) {
    throw notLocal('DOCKER_CONTEXT contradice el contexto activo reportado por Docker.');
  }
  const inspected = run('docker', ['context', 'inspect', name]);
  if (inspected.status !== 0) {
    throw notLocal('No se pudo inspeccionar el contexto de Docker.');
  }
  let parsed;
  try {
    parsed = JSON.parse(inspected.stdout);
  } catch {
    throw notLocal('La respuesta de "docker context inspect" no es JSON válido.');
  }
  const entry = Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  if (!entry || entry.Name !== name) {
    throw notLocal('La inspección del contexto de Docker no corresponde al contexto activo.');
  }
  const host = entry.Endpoints && entry.Endpoints.docker && entry.Endpoints.docker.Host;
  if (typeof host !== 'string' || !LOCAL_DOCKER_ENDPOINTS.some((re) => re.test(host))) {
    throw notLocal(
      `El contexto de Docker "${name}" no apunta a un demonio local verificable ` +
        '(solo se aceptan pipes npipe locales o sockets unix; se rechazan ssh, tcp y otros).',
    );
  }
  return { contextName: name };
}

function isDefinedText(value) {
  return typeof value === 'string' && value.length > 0;
}

/** Config efectiva de Compose (JSON). Falla cerrado si no se puede leer. */
function readComposeConfig(run) {
  const result = run('docker', ['compose', 'config', '--format', 'json']);
  if (result.status !== 0) {
    throw unverified('No se pudo leer la configuración de Docker Compose.');
  }
  try {
    return JSON.parse(result.stdout);
  } catch {
    throw unverified('La configuración de Docker Compose no es JSON válido.');
  }
}

/** Coherencia entre la política TEST y el servicio db_test de Compose. */
function assertComposeMatchesPolicy(config, policy) {
  const svc = config && config.services && config.services[DB_SERVICE];
  if (!svc) throw mismatch(`Compose no define el servicio ${DB_SERVICE}.`);
  if (svc.container_name !== clean.TEST_CONTAINER_NAME) {
    throw mismatch(
      `El contenedor de ${DB_SERVICE} no se llama ${clean.TEST_CONTAINER_NAME}.`,
    );
  }
  const env = svc.environment || {};
  if (env.POSTGRES_DB !== policy.canonical.database) {
    throw mismatch(
      `POSTGRES_DB de ${DB_SERVICE} no es ${policy.canonical.database}.`,
    );
  }
  if (env.POSTGRES_USER !== policy.canonical.user) {
    throw mismatch(
      `POSTGRES_USER de ${DB_SERVICE} no coincide con el usuario TEST esperado.`,
    );
  }
  const publication = (svc.ports || []).find(
    (p) => Number(p.target) === POSTGRES_INTERNAL_PORT,
  );
  if (!publication) {
    throw mismatch(`${DB_SERVICE} no publica el puerto ${POSTGRES_INTERNAL_PORT}.`);
  }
  if (Number(publication.published) !== policy.canonical.port) {
    throw mismatch(
      `Compose publica ${DB_SERVICE} en el puerto ${publication.published} pero la ` +
        `política TEST espera ${policy.canonical.port}. Compose no lee .env.test: ` +
        'alinea TEST_POSTGRES_PORT en el shell/.env de Compose y en .env.test.',
    );
  }
  const dataVolume = (svc.volumes || []).find(
    (v) => v.target === clean.TEST_DATA_MOUNT_DESTINATION,
  );
  if (!dataVolume || dataVolume.source !== clean.TEST_VOLUME_LOGICAL_NAME) {
    throw mismatch(
      `${DB_SERVICE} no monta ${clean.TEST_VOLUME_LOGICAL_NAME} en ` +
        `${clean.TEST_DATA_MOUNT_DESTINATION}.`,
    );
  }
  const dev = config.services.db;
  const devPublished =
    dev && (dev.ports || []).find((p) => Number(p.target) === POSTGRES_INTERNAL_PORT);
  if (devPublished && Number(devPublished.published) === policy.canonical.port) {
    throw mismatch('El puerto TEST coincide con el puerto publicado de la base de desarrollo.');
  }
}

/** Inspección del contenedor concreto (null si no existe). */
function inspectTestContainer(run) {
  const result = run('docker', ['inspect', clean.TEST_CONTAINER_NAME]);
  if (result.status !== 0) return null;
  try {
    const parsed = JSON.parse(result.stdout);
    return Array.isArray(parsed) && parsed.length === 1 ? parsed[0] : null;
  } catch {
    throw unverified('La inspección del contenedor TEST no es JSON válido.');
  }
}

function assertContainerIsComposeService(container, projectName, policy) {
  const labels = (container.Config && container.Config.Labels) || {};
  if (container.Name !== `/${clean.TEST_CONTAINER_NAME}`) {
    throw unverified('El contenedor inspeccionado no se llama como el servicio TEST.');
  }
  if (labels['com.docker.compose.project'] !== projectName) {
    throw unverified(
      `El contenedor ${clean.TEST_CONTAINER_NAME} pertenece a otro proyecto de Compose.`,
    );
  }
  if (labels['com.docker.compose.service'] !== DB_SERVICE) {
    throw unverified(
      `El contenedor ${clean.TEST_CONTAINER_NAME} no es el servicio ${DB_SERVICE}.`,
    );
  }
  const bindings =
    (container.HostConfig &&
      container.HostConfig.PortBindings &&
      container.HostConfig.PortBindings[`${POSTGRES_INTERNAL_PORT}/tcp`]) ||
    [];
  if (!bindings.some((b) => Number(b.HostPort) === policy.canonical.port)) {
    throw unverified(
      `El contenedor ${clean.TEST_CONTAINER_NAME} no publica el puerto ${policy.canonical.port}.`,
    );
  }
}

/**
 * @returns {Promise<{ plan, containerId: string|null, running: boolean, identityVerified: boolean, label: string }>}
 */
async function runPreflight(options) {
  const {
    baseFile,
    localFile,
    inheritedEnv = process.env,
    run = defaultRun,
    runStatements,
  } = options;

  const { values } = guard.loadGuardedEnv({ baseFile, localFile, inheritedEnv });
  const policy = guard.resolvePolicy(values);
  if (policy.disposable) {
    throw new guard.TestDatabaseGuardError(
      guard.CODES.RESET_NOT_ALLOWED,
      'db:test:reset solo aplica al servicio TEST canónico. Hay una base ' +
        'descartable autorizada en .env.test.local; retírala o elimina esa base ' +
        'manualmente (el reset nunca destruye recursos descartables).',
    );
  }
  const evaluated = guard.evaluateTarget(values.DATABASE_URL, policy);

  assertLocalDockerDaemon(run, inheritedEnv);
  assertComposeMatchesPolicy(readComposeConfig(run), policy);

  const projectName = clean.resolveComposeProjectName(run);
  const labelResolvedVolume = clean.resolveTestVolumeByComposeLabels(run, projectName);
  const container = inspectTestContainer(run);
  if (container) {
    assertContainerIsComposeService(container, projectName, policy);
  }
  const containerMountedVolume = clean.resolveMountedVolumeFromContainer(run);
  const plan = clean.decideCleanupPlan({ containerMountedVolume, labelResolvedVolume });
  if (plan.action === 'ABORT') {
    throw unverified(plan.reason);
  }

  const running = Boolean(container && container.State && container.State.Running);
  let identityVerified = false;
  if (running) {
    await guard.verifyServerIdentity(evaluated, policy, {
      runStatements,
      secrets: [evaluated.password],
    });
    identityVerified = true;
  }

  return {
    plan,
    containerId: container ? String(container.Id).slice(0, 12) : null,
    running,
    identityVerified,
    label: evaluated.label,
  };
}

async function main(argv, deps = {}) {
  const {
    log = console.log,
    errorLog = console.error,
    inheritedEnv = process.env,
    run = defaultRun,
    runStatements,
  } = deps;
  try {
    const { baseFile, localFile } = guard.parseGuardCliArgs(argv);
    const result = await runPreflight({
      baseFile,
      localFile,
      inheritedEnv,
      run,
      runStatements,
    });
    log(`[test-db-preflight] destino TEST canónico: ${result.label}`);
    log(
      `[test-db-preflight] recurso Docker identificado -> acción: ${result.plan.action}` +
        `${result.containerId ? `, contenedor ${clean.TEST_CONTAINER_NAME} (${result.containerId})` : ', sin contenedor'}` +
        `${result.plan.volumeName ? `, volumen ${result.plan.volumeName}` : ''}`,
    );
    log(
      result.identityVerified
        ? '[test-db-preflight] identidad de la base confirmada (current_database).'
        : '[test-db-preflight] contenedor detenido o inexistente: no se afirma identidad de la base; ' +
            'se exigirá verificación completa antes del deploy y del seed.',
    );
    return 0;
  } catch (error) {
    errorLog(
      error instanceof guard.TestDatabaseGuardError
        ? `[test-db-preflight] ABORTADO (no se borra nada): ${error.message}`
        : `[test-db-preflight] ABORTADO (no se borra nada): error inesperado (${guard.redact(error && error.message)})`,
    );
    return 1;
  }
}

module.exports = {
  assertLocalDockerDaemon,
  assertComposeMatchesPolicy,
  assertContainerIsComposeService,
  readComposeConfig,
  runPreflight,
  main,
};

if (require.main === module) {
  main(process.argv.slice(2)).then((code) => {
    process.exit(code);
  });
}
