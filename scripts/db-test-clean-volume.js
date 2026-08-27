#!/usr/bin/env node
/**
 * Elimina el contenedor y el volumen de datos de `db_test` (pos_db_test) de
 * forma segura, sin depender de un nombre de volumen "adivinado" a partir del
 * nombre de la carpeta/proyecto de Docker Compose, y sin fallar en silencio
 * cuando el contenedor ya no existe pero el volumen sí (Fase 12B, corrección
 * final).
 *
 * Defecto corregido en esta ronda: la versión anterior solo resolvía el
 * volumen inspeccionando el contenedor `pos_db_test` en ejecución
 * (`docker inspect`). Si el contenedor ya había sido eliminado por cualquier
 * motivo pero el volumen de Compose seguía existiendo con datos históricos,
 * el script no encontraba nada que borrar y terminaba con éxito sin haber
 * limpiado realmente nada — `db:test:reset` reutilizaba entonces el volumen
 * viejo al levantar un contenedor nuevo, sin ser un reset real.
 *
 * Corrección: el volumen físico se resuelve ahora a partir de las ETIQUETAS
 * que el propio Docker Compose adjunta a cada volumen que crea
 * (`com.docker.compose.project`, `com.docker.compose.volume`), nunca
 * concatenando `<carpeta>_<volumen>` a mano. Estas etiquetas viven en el
 * volumen mismo y persisten exista o no el contenedor, así que este camino
 * funciona igual en ambos casos:
 *
 *   A. el contenedor `pos_db_test` existe            -> se usa como
 *      verificación cruzada adicional (su volumen montado en
 *      /var/lib/postgresql/data debe coincidir EXACTAMENTE con el volumen
 *      resuelto por etiquetas; si no coincide, no se borra nada).
 *   B. el contenedor no existe pero el volumen de Compose para `pos_pgdata_test`
 *      sí existe -> se borra igualmente ese volumen (el caso que antes se
 *      pasaba por alto).
 *   C. ni el contenedor ni el volumen existen        -> no hay nada que
 *      hacer, termina con éxito sin tocar nada.
 *   D. la resolución es ambigua (más de un volumen coincide, o el volumen
 *      montado por el contenedor no coincide con el resuelto por etiquetas)
 *      -> FAIL SAFE: no se borra nada, se informa el motivo exacto.
 *
 * El nombre del proyecto de Compose se obtiene siempre de
 * `docker compose config --format json` (campo "name"), que es la misma
 * resolución que usa Compose para CUALQUIER otro comando de este
 * repositorio (`db:up`, `db:test:up`, etc.): respeta `COMPOSE_PROJECT_NAME`,
 * el campo `name:` del propio `docker-compose.yml` y, en su defecto, el
 * nombre de la carpeta — nunca se infiere aquí con `process.cwd()` ni con el
 * nombre de la carpeta directamente.
 *
 * Nunca puede tocar `pos_db`/`pos_pgdata` (contenedor y volumen con nombre
 * propio, completamente distintos, y explícitamente rechazados si alguna
 * etiqueta los mencionara) ni un volumen de prueba de otro proyecto de
 * Compose (el filtro exige la etiqueta de proyecto exacta).
 */
const { spawnSync } = require('node:child_process');

const TEST_CONTAINER_NAME = 'pos_db_test';
const TEST_DATA_MOUNT_DESTINATION = '/var/lib/postgresql/data';
const TEST_VOLUME_LOGICAL_NAME = 'pos_pgdata_test';
const DEV_VOLUME_LOGICAL_NAME = 'pos_pgdata';

/** Ejecuta un comando real. Inyectable para poder probar la lógica sin Docker. */
function defaultRun(command, args) {
  return spawnSync(command, args, { encoding: 'utf8' });
}

/**
 * Resuelve el nombre de proyecto de Compose EXACTO para esta invocación,
 * delegando por completo en Compose (nunca en `process.cwd()`/nombre de
 * carpeta). `run` es inyectable para pruebas.
 */
function resolveComposeProjectName(run) {
  const result = run('docker', ['compose', 'config', '--format', 'json']);
  if (result.status !== 0) {
    throw new Error(
      `No se pudo leer la configuración de Docker Compose: ${result.stderr || result.stdout}`,
    );
  }
  let config;
  try {
    config = JSON.parse(result.stdout);
  } catch (error) {
    throw new Error(
      `La salida de "docker compose config --format json" no es JSON válido: ${error.message}`,
    );
  }
  if (typeof config.name !== 'string' || config.name.length === 0) {
    throw new Error(
      'Docker Compose no devolvió un nombre de proyecto resuelto. Abortando sin borrar nada.',
    );
  }
  return config.name;
}

/**
 * Resuelve el volumen físico que Docker Compose etiquetó como
 * `pos_pgdata_test` para el proyecto `projectName`, usando exclusivamente
 * las etiquetas que el propio Compose adjunta al crear el volumen — nunca
 * una construcción manual del nombre. Funciona exista o no el contenedor.
 * Devuelve `null` si no existe ningún volumen así. Lanza si la resolución es
 * ambigua (más de un volumen) o si el volumen encontrado no supera las
 * verificaciones de defensa en profundidad.
 */
function resolveTestVolumeByComposeLabels(run, projectName) {
  const list = run('docker', [
    'volume',
    'ls',
    '--filter',
    `label=com.docker.compose.project=${projectName}`,
    '--filter',
    `label=com.docker.compose.volume=${TEST_VOLUME_LOGICAL_NAME}`,
    '--format',
    '{{.Name}}',
  ]);
  if (list.status !== 0) {
    throw new Error(`No se pudo listar volúmenes de Docker: ${list.stderr}`);
  }

  const names = list.stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);

  if (names.length === 0) {
    return null;
  }
  if (names.length > 1) {
    throw new Error(
      `Se encontraron ${names.length} volúmenes para el proyecto "${projectName}" ` +
        `con etiqueta com.docker.compose.volume=${TEST_VOLUME_LOGICAL_NAME}: ` +
        `${names.join(', ')}. Resolución ambigua: abortando sin borrar nada.`,
    );
  }

  const volumeName = names[0];

  // Defensa en profundidad: releer las etiquetas reales del volumen resuelto
  // (no confiar únicamente en el filtro de `volume ls`, ni en que el nombre
  // "se parezca" al esperado) y confirmar explícitamente que corresponde al
  // proyecto y al volumen lógico correctos, y que NO es el volumen de
  // desarrollo.
  const inspect = run('docker', [
    'volume',
    'inspect',
    volumeName,
    '--format',
    '{{json .Labels}}',
  ]);
  if (inspect.status !== 0) {
    throw new Error(
      `No se pudo inspeccionar el volumen resuelto "${volumeName}". Abortando sin borrar nada.`,
    );
  }
  let labels;
  try {
    labels = JSON.parse(inspect.stdout);
  } catch (error) {
    throw new Error(
      `Las etiquetas del volumen "${volumeName}" no son JSON válido: ${error.message}`,
    );
  }

  if (labels['com.docker.compose.volume'] !== TEST_VOLUME_LOGICAL_NAME) {
    throw new Error(
      `El volumen resuelto "${volumeName}" no tiene la etiqueta ` +
        `com.docker.compose.volume=${TEST_VOLUME_LOGICAL_NAME} esperada ` +
        `(tiene "${labels['com.docker.compose.volume']}"). Abortando sin borrar nada.`,
    );
  }
  if (labels['com.docker.compose.volume'] === DEV_VOLUME_LOGICAL_NAME) {
    // Guarda explícita y redundante: nunca debería poder cumplirse dado el
    // filtro anterior, pero se mantiene como última línea de defensa.
    throw new Error(
      `El volumen resuelto "${volumeName}" coincide con el volumen de ` +
        'desarrollo. Abortando sin borrar nada.',
    );
  }
  if (labels['com.docker.compose.project'] !== projectName) {
    throw new Error(
      `El volumen resuelto "${volumeName}" pertenece al proyecto ` +
        `"${labels['com.docker.compose.project']}", no a "${projectName}". ` +
        'Abortando sin borrar nada.',
    );
  }
  // Verificación adicional, no exclusiva (ver comentario de cabecera): el
  // nombre físico también debe contener el fragmento esperado.
  if (!volumeName.includes(TEST_VOLUME_LOGICAL_NAME)) {
    throw new Error(
      `El volumen resuelto "${volumeName}" no contiene el fragmento esperado ` +
        `"${TEST_VOLUME_LOGICAL_NAME}". Abortando sin borrar nada.`,
    );
  }

  return volumeName;
}

/**
 * Verificación cruzada opcional: si el contenedor `pos_db_test` existe,
 * devuelve el volumen que tiene realmente montado en
 * /var/lib/postgresql/data. Devuelve `null` si el contenedor no existe
 * (nunca lo confunde con "no tiene volumen": si existe pero no tiene ese
 * montaje, lanza en vez de devolver null).
 */
function resolveMountedVolumeFromContainer(run) {
  const inspect = run('docker', [
    'inspect',
    TEST_CONTAINER_NAME,
    '--format',
    '{{range .Mounts}}{{.Destination}}|{{.Name}}\n{{end}}',
  ]);

  if (inspect.status !== 0) {
    return null; // el contenedor no existe
  }

  const line = inspect.stdout
    .split('\n')
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0)
    .find((entry) => entry.startsWith(`${TEST_DATA_MOUNT_DESTINATION}|`));

  if (line === undefined) {
    throw new Error(
      `El contenedor ${TEST_CONTAINER_NAME} existe pero no tiene ningún volumen ` +
        `montado en ${TEST_DATA_MOUNT_DESTINATION}. Abortando sin borrar nada: ` +
        'la resolución del volumen no pudo probarse.',
    );
  }

  return line.split('|')[1];
}

/**
 * Función pura de decisión: dados los dos hechos ya resueltos (sin hacer
 * ningún I/O aquí), determina qué hacer. Completamente probable sin Docker.
 *
 *   - Contenedor presente + volúmenes coinciden  -> borrar ambos.
 *   - Contenedor presente + no coinciden          -> ABORT (fail safe).
 *   - Contenedor ausente + volumen presente       -> borrar solo el volumen
 *     (el caso que motivó esta corrección).
 *   - Contenedor ausente + volumen ausente        -> NOOP.
 */
function decideCleanupPlan({ containerMountedVolume, labelResolvedVolume }) {
  if (containerMountedVolume !== null) {
    if (
      labelResolvedVolume === null ||
      labelResolvedVolume !== containerMountedVolume
    ) {
      return {
        action: 'ABORT',
        reason:
          `El volumen montado por el contenedor ("${containerMountedVolume}") ` +
          `no coincide con el volumen resuelto por etiquetas de Compose ` +
          `("${labelResolvedVolume}"). Resolución ambigua: abortando sin ` +
          'borrar nada.',
      };
    }
    return {
      action: 'REMOVE_CONTAINER_AND_VOLUME',
      volumeName: containerMountedVolume,
    };
  }

  if (labelResolvedVolume === null) {
    return { action: 'NOOP' };
  }

  return { action: 'REMOVE_VOLUME_ONLY', volumeName: labelResolvedVolume };
}

function main() {
  let projectName;
  let labelResolvedVolume;
  let containerMountedVolume;

  try {
    projectName = resolveComposeProjectName(defaultRun);
    labelResolvedVolume = resolveTestVolumeByComposeLabels(
      defaultRun,
      projectName,
    );
    containerMountedVolume = resolveMountedVolumeFromContainer(defaultRun);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
    return;
  }

  const plan = decideCleanupPlan({
    containerMountedVolume,
    labelResolvedVolume,
  });

  if (plan.action === 'ABORT') {
    console.error(plan.reason);
    process.exitCode = 1;
    return;
  }

  if (plan.action === 'NOOP') {
    console.log(
      `No se encontró contenedor ${TEST_CONTAINER_NAME} ni volumen de prueba ` +
        `de Compose (proyecto "${projectName}"); nada que limpiar.`,
    );
    return;
  }

  // REMOVE_CONTAINER_AND_VOLUME o REMOVE_VOLUME_ONLY: en ambos casos se
  // intenta eliminar el servicio db_test primero (no-op seguro si el
  // contenedor ya no existe; `docker compose rm` solo puede afectar al
  // servicio indicado).
  const rmContainer = defaultRun('docker', ['compose', 'rm', '-sf', 'db_test']);
  process.stdout.write(rmContainer.stdout);
  process.stderr.write(rmContainer.stderr);
  if (rmContainer.status !== 0) {
    console.error('No se pudo eliminar el contenedor db_test. Abortando.');
    process.exitCode = rmContainer.status ?? 1;
    return;
  }

  console.log(`Volumen de datos de prueba resuelto: ${plan.volumeName}`);
  const rmVolume = defaultRun('docker', ['volume', 'rm', plan.volumeName]);
  process.stdout.write(rmVolume.stdout);
  process.stderr.write(rmVolume.stderr);
  if (rmVolume.status !== 0) {
    console.error(`No se pudo eliminar el volumen ${plan.volumeName}.`);
    process.exitCode = rmVolume.status ?? 1;
    return;
  }

  console.log(`Volumen ${plan.volumeName} eliminado. pos_db_test queda limpio.`);
}

module.exports = {
  TEST_CONTAINER_NAME,
  TEST_DATA_MOUNT_DESTINATION,
  TEST_VOLUME_LOGICAL_NAME,
  DEV_VOLUME_LOGICAL_NAME,
  resolveComposeProjectName,
  resolveTestVolumeByComposeLabels,
  resolveMountedVolumeFromContainer,
  decideCleanupPlan,
};

if (require.main === module) {
  main();
}
