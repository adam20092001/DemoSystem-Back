#!/usr/bin/env node
/**
 * Auto-prueba de scripts/db-test-clean-volume.js.
 *
 * Se ejecuta manualmente con `node scripts/db-test-clean-volume.test.js`.
 * Vive en scripts/, no en src/, así que Jest (rootDir: 'src') no la recoge:
 * no altera el conteo de la suite unitaria existente (77 suites / 2491
 * tests). No ejecuta ningún comando real de Docker — inyecta una función
 * `run` simulada en cada función exportada para probar la lógica de
 * resolución/decisión de forma completamente aislada y no destructiva.
 *
 * Cubre en particular el defecto corregido en esta ronda: contenedor
 * `pos_db_test` AUSENTE + volumen de Compose `pos_pgdata_test` PRESENTE
 * debe seguir resolviendo y planeando la eliminación del volumen correcto.
 */
const assert = require('node:assert/strict');
const {
  TEST_VOLUME_LOGICAL_NAME,
  resolveComposeProjectName,
  resolveTestVolumeByComposeLabels,
  resolveMountedVolumeFromContainer,
  decideCleanupPlan,
} = require('./db-test-clean-volume');

let passed = 0;

function test(name, fn) {
  fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/** Crea una función `run(command, args)` que responde según `args`. */
function makeFakeRun(handlers) {
  return (command, args) => {
    const key = args.join(' ');
    for (const [matchSubstring, response] of handlers) {
      if (key.includes(matchSubstring)) {
        return response;
      }
    }
    throw new Error(`fakeRun: sin respuesta programada para "${command} ${key}"`);
  };
}

console.log('scripts/db-test-clean-volume.js — auto-prueba');

test('resolveComposeProjectName lee el campo "name" de `docker compose config`', () => {
  const run = makeFakeRun([
    ['compose config', { status: 0, stdout: JSON.stringify({ name: 'demosystem-back' }), stderr: '' }],
  ]);
  assert.equal(resolveComposeProjectName(run), 'demosystem-back');
});

test('resolveComposeProjectName respeta un override (p. ej. COMPOSE_PROJECT_NAME)', () => {
  const run = makeFakeRun([
    ['compose config', { status: 0, stdout: JSON.stringify({ name: 'otro-proyecto' }), stderr: '' }],
  ]);
  assert.equal(resolveComposeProjectName(run), 'otro-proyecto');
});

test('resolveComposeProjectName falla sin borrar nada si Compose no responde', () => {
  const run = makeFakeRun([
    ['compose config', { status: 1, stdout: '', stderr: 'no docker-compose.yml' }],
  ]);
  assert.throws(() => resolveComposeProjectName(run));
});

test('resolveTestVolumeByComposeLabels resuelve por etiquetas, no por string concatenado', () => {
  const run = makeFakeRun([
    ['volume ls', { status: 0, stdout: 'demosystem-back_pos_pgdata_test\n', stderr: '' }],
    [
      'volume inspect',
      {
        status: 0,
        stdout: JSON.stringify({
          'com.docker.compose.project': 'demosystem-back',
          'com.docker.compose.volume': TEST_VOLUME_LOGICAL_NAME,
        }),
        stderr: '',
      },
    ],
  ]);
  assert.equal(
    resolveTestVolumeByComposeLabels(run, 'demosystem-back'),
    'demosystem-back_pos_pgdata_test',
  );
});

test('resolveTestVolumeByComposeLabels devuelve null si no hay ningún volumen (nada que limpiar)', () => {
  const run = makeFakeRun([['volume ls', { status: 0, stdout: '', stderr: '' }]]);
  assert.equal(resolveTestVolumeByComposeLabels(run, 'demosystem-back'), null);
});

test('resolveTestVolumeByComposeLabels aborta (lanza) si hay más de un volumen coincidente', () => {
  const run = makeFakeRun([
    ['volume ls', { status: 0, stdout: 'vol-a\nvol-b\n', stderr: '' }],
  ]);
  assert.throws(() => resolveTestVolumeByComposeLabels(run, 'demosystem-back'));
});

test('resolveTestVolumeByComposeLabels aborta si las etiquetas releídas no encajan (defensa en profundidad)', () => {
  const run = makeFakeRun([
    ['volume ls', { status: 0, stdout: 'vol-x\n', stderr: '' }],
    [
      'volume inspect',
      {
        status: 0,
        stdout: JSON.stringify({
          'com.docker.compose.project': 'otro-proyecto', // no coincide
          'com.docker.compose.volume': TEST_VOLUME_LOGICAL_NAME,
        }),
        stderr: '',
      },
    ],
  ]);
  assert.throws(() => resolveTestVolumeByComposeLabels(run, 'demosystem-back'));
});

test('resolveMountedVolumeFromContainer devuelve null si el contenedor no existe', () => {
  const run = makeFakeRun([
    ['inspect pos_db_test', { status: 1, stdout: '', stderr: 'No such object: pos_db_test' }],
  ]);
  assert.equal(resolveMountedVolumeFromContainer(run), null);
});

test('resolveMountedVolumeFromContainer devuelve el volumen montado si el contenedor existe', () => {
  const run = makeFakeRun([
    [
      'inspect pos_db_test',
      {
        status: 0,
        stdout: '/var/lib/postgresql/data|demosystem-back_pos_pgdata_test\n',
        stderr: '',
      },
    ],
  ]);
  assert.equal(
    resolveMountedVolumeFromContainer(run),
    'demosystem-back_pos_pgdata_test',
  );
});

test('decideCleanupPlan: contenedor y etiquetas coinciden -> elimina ambos', () => {
  const plan = decideCleanupPlan({
    containerMountedVolume: 'v1',
    labelResolvedVolume: 'v1',
  });
  assert.deepEqual(plan, { action: 'REMOVE_CONTAINER_AND_VOLUME', volumeName: 'v1' });
});

test('decideCleanupPlan: DEFECTO CORREGIDO — contenedor ausente + volumen presente -> elimina solo el volumen', () => {
  const plan = decideCleanupPlan({
    containerMountedVolume: null,
    labelResolvedVolume: 'demosystem-back_pos_pgdata_test',
  });
  assert.deepEqual(plan, {
    action: 'REMOVE_VOLUME_ONLY',
    volumeName: 'demosystem-back_pos_pgdata_test',
  });
});

test('decideCleanupPlan: ni contenedor ni volumen -> NOOP', () => {
  const plan = decideCleanupPlan({
    containerMountedVolume: null,
    labelResolvedVolume: null,
  });
  assert.deepEqual(plan, { action: 'NOOP' });
});

test('decideCleanupPlan: contenedor existe pero etiquetas no coinciden -> ABORT (fail safe)', () => {
  const plan = decideCleanupPlan({
    containerMountedVolume: 'v1',
    labelResolvedVolume: 'v2',
  });
  assert.equal(plan.action, 'ABORT');
});

test('decideCleanupPlan: contenedor existe pero no hay volumen por etiquetas -> ABORT (fail safe)', () => {
  const plan = decideCleanupPlan({
    containerMountedVolume: 'v1',
    labelResolvedVolume: null,
  });
  assert.equal(plan.action, 'ABORT');
});

console.log(`\n${passed} aserciones pasaron. Ningún comando real de Docker fue ejecutado.`);
