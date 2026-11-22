'use strict';
/**
 * Pruebas de INTEGRACIÓN de la guardia (node:test) contra PostgreSQL REAL
 * pero 100% descartable y propio. Ejecutar: npm run test:scripts:integration
 *
 * Garantías de aislamiento (verificadas por el propio test antes de operar):
 *   - Crea sus propios contenedores `demosystem_guard_it_*` (postgres:16-alpine)
 *     con etiqueta `demosystem.guard-it=<runId>`, puerto publicado ALEATORIO en
 *     127.0.0.1 (nunca 5432 ni 5433), datos en tmpfs (sin volúmenes) y
 *     contraseñas aleatorias.
 *   - Nunca usa el proyecto Docker Compose, `pos_db`, `pos_db_test`, ni sus
 *     volúmenes. No ejecuta db:test:reset ni compose down.
 *   - Elimina únicamente los contenedores que creó, tras re-verificar por ID
 *     su nombre y su etiqueta.
 *   - Compara (solo lectura) el estado de los contenedores existentes del
 *     proyecto antes y después.
 * Requiere Docker y la imagen postgres:16-alpine ya disponible (no la descarga
 * con fines distintos de `docker run`).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const guard = require('./lib/test-db-guard');
const wrapper = require('./run-with-test-db');
const markScript = require('./test-db-mark-disposable');

const { CODES } = guard;
const REPO_ROOT = path.resolve(__dirname, '..');
const RUN_ID = crypto.randomBytes(4).toString('hex');
const IMAGE = 'postgres:16-alpine';
const SUPERUSER = 'pos_test_user';
const PASSWORD = crypto.randomBytes(8).toString('hex');
const LIMITED_PASSWORD = crypto.randomBytes(8).toString('hex');
const TOKEN = crypto.randomBytes(16).toString('hex');
const OTHER_TOKEN = crypto.randomBytes(16).toString('hex');
const EXISTING_CONTAINERS = ['pos_db', 'pos_db_test'];

const created = []; // { id, name }
const ctx = {};

function docker(args, options = {}) {
  return spawnSync('docker', args, {
    encoding: 'utf8',
    env: { ...process.env, MSYS_NO_PATHCONV: '1' },
    ...options,
  });
}

function dockerOk(args) {
  const r = docker(args);
  assert.equal(r.status, 0, `docker ${args.join(' ')} falló: ${r.stderr}`);
  return r.stdout.trim();
}

function snapshotExisting() {
  return EXISTING_CONTAINERS.map((name) => {
    const r = docker(['inspect', name, '--format', '{{.Id}} {{.State.StartedAt}} {{.State.Status}}']);
    return `${name}:${r.status === 0 ? r.stdout.trim() : 'ausente'}`;
  });
}

function inspectById(id) {
  const r = docker(['inspect', id]);
  assert.equal(r.status, 0, `no se pudo inspeccionar ${id}`);
  return JSON.parse(r.stdout)[0];
}

/** Verifica que el contenedor es PROPIO (nombre, etiqueta, puerto y sin volúmenes). */
function assertOwned(id) {
  const c = inspectById(id);
  assert.ok(c.Name.startsWith('/demosystem_guard_it_'), `nombre ajeno: ${c.Name}`);
  assert.equal(c.Config.Labels['demosystem.guard-it'], RUN_ID, 'etiqueta de ejecución ajena');
  assert.ok(!EXISTING_CONTAINERS.includes(c.Name.slice(1)));
  assert.equal(
    (c.Mounts || []).filter((m) => m.Type === 'volume' || m.Type === 'bind').length,
    0,
    'el contenedor monta volúmenes/binds',
  );
  const binding = (c.NetworkSettings.Ports['5432/tcp'] || [])[0];
  assert.ok(binding, 'puerto no publicado');
  assert.equal(binding.HostIp, '127.0.0.1');
  assert.ok(!['5432', '5433'].includes(binding.HostPort), 'puerto reservado');
  return { port: Number(binding.HostPort), name: c.Name.slice(1) };
}

function startContainer(label) {
  const name = `demosystem_guard_it_${label}_${RUN_ID}`;
  const id = dockerOk([
    'run', '-d',
    '--name', name,
    '--label', `demosystem.guard-it=${RUN_ID}`,
    '-e', `POSTGRES_USER=${SUPERUSER}`,
    '-e', `POSTGRES_PASSWORD=${PASSWORD}`,
    '-e', 'POSTGRES_DB=pos_db_test_it_main',
    '-p', '127.0.0.1::5432',
    '--tmpfs', '/var/lib/postgresql/data',
    IMAGE,
  ]);
  created.push({ id, name });
  const info = assertOwned(id);
  return { id, ...info };
}

function psql(container, database, sql) {
  const r = docker(['exec', container.id, 'psql', '-U', SUPERUSER, '-d', database, '-At', '-c', sql]);
  assert.equal(r.status, 0, `psql falló (${sql}): ${r.stderr}`);
  return r.stdout.trim();
}

async function waitReady(container) {
  for (let i = 0; i < 90; i += 1) {
    const r = docker(['exec', container.id, 'psql', '-h', '127.0.0.1', '-U', SUPERUSER, '-d', 'postgres', '-At', '-c', 'select 1']);
    if (r.status === 0 && r.stdout.trim() === '1') return;
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  assert.fail(`PostgreSQL de ${container.name} no quedó listo`);
}

function writeEnv(dir, { base, local }) {
  const toText = (o) => Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n');
  fs.writeFileSync(path.join(dir, '.env.test'), toText(base));
  const localFile = path.join(dir, '.env.test.local');
  if (local) fs.writeFileSync(localFile, toText(local));
  else if (fs.existsSync(localFile)) fs.unlinkSync(localFile);
  return { baseFile: path.join(dir, '.env.test'), localFile };
}

const SEED_ENV = {
  NODE_ENV: 'test',
  INITIAL_ADMIN_USERNAME: 'e2e_admin',
  INITIAL_ADMIN_EMAIL: 'e2e_admin@demosystem.test',
  INITIAL_ADMIN_PASSWORD: 'changeme-test-only-password-2026',
};

function disposableEnv(container, database, user, password, token = TOKEN) {
  const url = `postgresql://${user}:${password}@localhost:${container.port}/${database}?schema=public`;
  return {
    base: { ...SEED_ENV, DATABASE_URL: url },
    local: {
      DATABASE_URL: url,
      E2E_DISPOSABLE_TARGET: `localhost:${container.port}/${database}`,
      E2E_DISPOSABLE_TOKEN: token,
    },
  };
}

async function code(fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof guard.TestDatabaseGuardError, `error inesperado: ${error && error.stack}`);
    assert.ok(!error.message.includes(PASSWORD), 'filtra contraseña');
    assert.ok(!error.message.includes(LIMITED_PASSWORD), 'filtra contraseña');
    assert.ok(!error.message.includes(TOKEN), 'filtra token');
    return error.code;
  }
  return 'NO_ERROR';
}

test.before(async () => {
  const check = docker(['version', '--format', '{{.Server.Version}}']);
  assert.equal(check.status, 0, 'Docker no está disponible');
  ctx.existingBefore = snapshotExisting();
  ctx.dir = fs.mkdtempSync(path.join(os.tmpdir(), 'guard-it-'));
  process.chdir(REPO_ROOT);

  ctx.a = startContainer('a');
  ctx.b = startContainer('b');
  assert.notEqual(ctx.a.id, ctx.b.id);
  await Promise.all([waitReady(ctx.a), waitReady(ctx.b)]);

  psql(ctx.a, 'postgres', 'CREATE DATABASE pos_db_test');
  psql(ctx.a, 'postgres', 'CREATE DATABASE pos_db_test_it_other');
  psql(ctx.a, 'postgres', 'CREATE DATABASE pos_db_test_it_copy');
  psql(ctx.a, 'postgres', `CREATE ROLE it_limited LOGIN PASSWORD '${LIMITED_PASSWORD}'`);
  psql(ctx.a, 'postgres', 'CREATE DATABASE pos_db_test_it_limited OWNER it_limited');
});

test.after(() => {
  for (const { id, name } of created.reverse()) {
    // Re-verificación por ID antes de eliminar: solo contenedores propios.
    const c = inspectById(id);
    if (c.Name === `/${name}` && c.Config.Labels['demosystem.guard-it'] === RUN_ID) {
      docker(['rm', '-f', '-v', id]);
    }
  }
  const left = docker(['ps', '-a', '--filter', `label=demosystem.guard-it=${RUN_ID}`, '--format', '{{.ID}}']);
  assert.equal(left.stdout.trim(), '', 'quedaron contenedores propios sin eliminar');
  const vols = docker(['volume', 'ls', '--filter', `label=demosystem.guard-it=${RUN_ID}`, '-q']);
  assert.equal(vols.stdout.trim(), '', 'quedaron volúmenes propios');
  assert.deepEqual(snapshotExisting(), ctx.existingBefore, 'los contenedores existentes del proyecto cambiaron');
  fs.rmSync(ctx.dir, { recursive: true, force: true });
});

test('destino canónico (base pos_db_test en un servidor propio) con identidad real', async () => {
  const url = `postgresql://${SUPERUSER}:${PASSWORD}@localhost:${ctx.a.port}/pos_db_test?schema=public`;
  const files = writeEnv(ctx.dir, {
    base: { ...SEED_ENV, DATABASE_URL: url, TEST_POSTGRES_PORT: String(ctx.a.port) },
  });
  const ready = await guard.assertTestDatabaseReady({ ...files, inheritedEnv: {} });
  assert.equal(ready.evaluated.kind, 'CANONICAL');
  assert.equal(ready.identity.database, 'pos_db_test');
  assert.equal(ready.identity.serverPort, 5432); // puerto INTERNO, distinto del publicado
  assert.notEqual(ready.identity.serverPort, ctx.a.port);
});

test('destino no autorizado (otra base en el mismo servidor) se rechaza sin conectar', async () => {
  const url = `postgresql://${SUPERUSER}:${PASSWORD}@localhost:${ctx.a.port}/pos_db_test_it_other?schema=public`;
  const files = writeEnv(ctx.dir, {
    base: { ...SEED_ENV, DATABASE_URL: url, TEST_POSTGRES_PORT: String(ctx.a.port) },
  });
  let queried = false;
  const spy = async () => {
    queried = true;
    return [];
  };
  assert.equal(
    await code(() => guard.assertTestDatabaseReady({ ...files, inheritedEnv: {}, runStatements: spy })),
    CODES.DB_NAME_NOT_ALLOWED,
  );
  assert.equal(queried, false);
  // Ningún comando se lanza: el hijo escribiría este archivo.
  const sentinel = path.join(ctx.dir, 'no-debe-existir.txt');
  const exit = await wrapper.main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'node', '-e', `require('fs').writeFileSync('${sentinel.replace(/\\/g, '/')}','x')`],
    { inheritedEnv: {}, errorLog: () => undefined },
  );
  assert.equal(exit, 1);
  assert.equal(fs.existsSync(sentinel), false);
});

test('conexión no disponible: falla cerrado', async () => {
  const free = await new Promise((resolve) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
  });
  const url = `postgresql://${SUPERUSER}:${PASSWORD}@localhost:${free}/pos_db_test_it_main`;
  const files = writeEnv(ctx.dir, {
    base: { ...SEED_ENV, DATABASE_URL: url },
    local: {
      DATABASE_URL: url,
      E2E_DISPOSABLE_TARGET: `localhost:${free}/pos_db_test_it_main`,
      E2E_DISPOSABLE_TOKEN: TOKEN,
    },
  });
  const c = await code(() => guard.assertTestDatabaseReady({ ...files, inheritedEnv: {}, timeoutMs: 3000 }));
  assert.ok([CODES.IDENTITY_UNVERIFIABLE, CODES.TIMEOUT].includes(c), `código: ${c}`);
});

test('descartable: sin marcador se rechaza; el wrapper no migra; el marcador se crea solo en base vacía', async () => {
  const files = writeEnv(ctx.dir, disposableEnv(ctx.a, 'pos_db_test_it_main', SUPERUSER, PASSWORD));
  assert.equal(
    await code(() => guard.assertTestDatabaseReady({ ...files, inheritedEnv: {} })),
    CODES.MARKER_MISSING,
  );
  const exit = await wrapper.main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { inheritedEnv: {}, errorLog: () => undefined },
  );
  assert.equal(exit, 1);
  assert.equal(psql(ctx.a, 'pos_db_test_it_main', "SELECT to_regclass('public._prisma_migrations') IS NULL"), 't');

  const created1 = await guard.markDisposable({ ...files, inheritedEnv: {} });
  assert.equal(created1.created, true);
  const again = await guard.markDisposable({ ...files, inheritedEnv: {} });
  assert.equal(again.created, false);
  const ready = await guard.assertTestDatabaseReady({ ...files, inheritedEnv: {} });
  assert.equal(ready.evaluated.kind, 'DISPOSABLE');
  assert.match(ready.identity.marker, /^demosystem-e2e-disposable:v1:[0-9a-f]{64}/);
});

test('migración y seed permitidos únicamente tras el preflight (wrapper real)', async () => {
  const files = writeEnv(ctx.dir, disposableEnv(ctx.a, 'pos_db_test_it_main', SUPERUSER, PASSWORD));
  const logs = [];
  const migrate = await wrapper.main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'node', 'node_modules/prisma/build/index.js', 'migrate', 'deploy'],
    { inheritedEnv: process.env, log: (m) => logs.push(m) },
  );
  assert.equal(migrate, 0);
  assert.ok(logs.some((l) => l.includes('DISPOSABLE')));
  const migrations = Number(psql(ctx.a, 'pos_db_test_it_main', 'SELECT count(*) FROM _prisma_migrations'));
  assert.equal(migrations, fs.readdirSync(path.join(REPO_ROOT, 'prisma', 'migrations')).filter((d) => /^\d/.test(d)).length);

  const seed = await wrapper.main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'node', 'node_modules/prisma/build/index.js', 'db', 'seed'],
    { inheritedEnv: process.env, log: () => undefined },
  );
  assert.equal(seed, 0);
  assert.ok(Number(psql(ctx.a, 'pos_db_test_it_main', 'SELECT count(*) FROM roles')) > 0);
  // Las otras bases del servidor no fueron tocadas.
  assert.equal(psql(ctx.a, 'pos_db_test_it_other', "SELECT to_regclass('public._prisma_migrations') IS NULL"), 't');
  assert.equal(psql(ctx.a, 'pos_db_test', "SELECT to_regclass('public._prisma_migrations') IS NULL"), 't');
});

test('base con datos: no se marca con otro token y el token distinto no pasa la verificación', async () => {
  const files = writeEnv(
    ctx.dir,
    disposableEnv(ctx.a, 'pos_db_test_it_main', SUPERUSER, PASSWORD, OTHER_TOKEN),
  );
  assert.equal(
    await code(() => guard.assertTestDatabaseReady({ ...files, inheritedEnv: {} })),
    CODES.MARKER_MISMATCH,
  );
  assert.equal(
    await code(() => guard.markDisposable({ ...files, inheritedEnv: {} })),
    CODES.MARKER_NOT_EMPTY,
  );
});

test('marcador copiado desde otro servidor (otro clúster) se rechaza', async () => {
  // Marca una base en el servidor B y copia el mismo comentario a una base del servidor A.
  const filesB = writeEnv(ctx.dir, disposableEnv(ctx.b, 'pos_db_test_it_main', SUPERUSER, PASSWORD));
  const markedB = await guard.markDisposable({ ...filesB, inheritedEnv: {} });
  assert.equal(markedB.boundToCluster, true);
  const comment = psql(ctx.b, 'postgres', "SELECT shobj_description(oid,'pg_database') FROM pg_database WHERE datname='pos_db_test_it_main'");
  assert.match(comment, /^demosystem-e2e-disposable:v1:/);
  psql(ctx.a, 'postgres', `COMMENT ON DATABASE pos_db_test_it_copy IS '${comment}'`);

  const filesA = writeEnv(ctx.dir, disposableEnv(ctx.a, 'pos_db_test_it_copy', SUPERUSER, PASSWORD));
  assert.equal(
    await code(() => guard.assertTestDatabaseReady({ ...filesA, inheritedEnv: {} })),
    CODES.MARKER_MISMATCH,
  );
});

test('rol sin privilegios de superusuario: el marcador funciona (con o sin pg_control_system)', async () => {
  const files = writeEnv(ctx.dir, disposableEnv(ctx.a, 'pos_db_test_it_limited', 'it_limited', LIMITED_PASSWORD));
  const marked = await guard.markDisposable({ ...files, inheritedEnv: {} });
  assert.equal(marked.created, true);
  assert.equal(typeof marked.boundToCluster, 'boolean');
  const ready = await guard.assertTestDatabaseReady({ ...files, inheritedEnv: {} });
  assert.equal(ready.identity.database, 'pos_db_test_it_limited');
  console.log(`[integración] rol limitado -> marcador atado al clúster: ${marked.boundToCluster}`);
});

test('comando db:test:mark-disposable (script) sobre base ya marcada es idempotente', async () => {
  const files = writeEnv(ctx.dir, disposableEnv(ctx.a, 'pos_db_test_it_limited', 'it_limited', LIMITED_PASSWORD));
  const logs = [];
  const exit = await markScript.main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile],
    { inheritedEnv: {}, log: (m) => logs.push(m) },
  );
  assert.equal(exit, 0);
  assert.ok(logs.join('\n').includes('ya tenía un marcador'));
});

test('DATABASE_URL heredada del shell hacia otra base se rechaza antes de lanzar Prisma', async () => {
  const files = writeEnv(ctx.dir, disposableEnv(ctx.a, 'pos_db_test_it_main', SUPERUSER, PASSWORD));
  const sentinel = path.join(ctx.dir, 'no-debe-existir-2.txt');
  const exit = await wrapper.main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'node', '-e', `require('fs').writeFileSync('${sentinel.replace(/\\/g, '/')}','x')`],
    {
      inheritedEnv: {
        ...process.env,
        DATABASE_URL: `postgresql://${SUPERUSER}:${PASSWORD}@localhost:${ctx.a.port}/pos_db_test_it_other`,
      },
      errorLog: () => undefined,
    },
  );
  assert.equal(exit, 1);
  assert.equal(fs.existsSync(sentinel), false);
});

test('la verificación no contamina process.env con el .env de desarrollo (cliente Prisma)', async () => {
  const files = writeEnv(ctx.dir, disposableEnv(ctx.a, 'pos_db_test_it_limited', 'it_limited', LIMITED_PASSWORD));
  const before = JSON.stringify(Object.keys(process.env).sort());
  await guard.assertTestDatabaseReady({ ...files, inheritedEnv: {} });
  assert.equal(JSON.stringify(Object.keys(process.env).sort()), before);
});
