'use strict';
/**
 * Pruebas de test-db-preflight.js (node:test). Docker y PostgreSQL están
 * SIMULADOS: no se ejecuta ningún comando real, no se toca ningún recurso.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const guard = require('./lib/test-db-guard');
const { CODES } = guard;
const { runPreflight, main } = require('./test-db-preflight');

const PW = 'S3cr3tPw';
const GOOD_URL = `postgresql://pos_test_user:${PW}@localhost:5433/pos_db_test?schema=public`;
const PROJECT = 'proj';
const VOLUME = 'proj_pos_pgdata_test';

function envFile(obj, local) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'preflight-'));
  const write = (name, o) =>
    fs.writeFileSync(path.join(dir, name), Object.entries(o).map(([k, v]) => `${k}=${v}`).join('\n'));
  write('.env.test', obj);
  if (local) write('.env.test.local', local);
  return { baseFile: path.join(dir, '.env.test'), localFile: path.join(dir, '.env.test.local') };
}

function composeJson(overrides = {}) {
  const base = {
    name: PROJECT,
    services: {
      db: { ports: [{ target: 5432, published: '5432' }] },
      db_test: {
        container_name: 'pos_db_test',
        environment: { POSTGRES_DB: 'pos_db_test', POSTGRES_USER: 'pos_test_user' },
        ports: [{ target: 5432, published: '5433' }],
        volumes: [{ type: 'volume', source: 'pos_pgdata_test', target: '/var/lib/postgresql/data' }],
      },
    },
  };
  const merged = JSON.parse(JSON.stringify(base));
  for (const [k, v] of Object.entries(overrides)) {
    Object.assign(merged.services.db_test, { [k]: v });
  }
  return merged;
}

/** Docker simulado. `state`: { compose, composeFail, volumes, labels, container } */
function fakeDocker(state) {
  const calls = [];
  const run = (cmd, args) => {
    calls.push([cmd, ...args].join(' '));
    const key = args.join(' ');
    const ctx = state.context ?? {};
    if (key === 'context show') {
      return ctx.showFail
        ? { status: 1, stdout: '', stderr: 'boom' }
        : { status: 0, stdout: `${ctx.shown ?? 'desktop-linux'}\n`, stderr: '' };
    }
    if (key.startsWith('context inspect')) {
      if (ctx.inspectFail) return { status: 1, stdout: '', stderr: 'boom' };
      if (ctx.raw !== undefined) return { status: 0, stdout: ctx.raw, stderr: '' };
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Name: ctx.inspectedName ?? args[2],
            Endpoints: {
              docker: { Host: ctx.host ?? 'npipe:////./pipe/dockerDesktopLinuxEngine' },
            },
          },
        ]),
        stderr: '',
      };
    }
    if (key.startsWith('compose config')) {
      return state.composeFail
        ? { status: 1, stdout: '', stderr: 'boom' }
        : { status: 0, stdout: JSON.stringify(state.compose ?? composeJson()), stderr: '' };
    }
    if (key.startsWith('volume ls')) {
      return { status: 0, stdout: (state.volumes ?? [VOLUME]).join('\n'), stderr: '' };
    }
    if (key.startsWith('volume inspect')) {
      return {
        status: 0,
        stdout: JSON.stringify(
          state.labels ?? {
            'com.docker.compose.project': PROJECT,
            'com.docker.compose.volume': 'pos_pgdata_test',
          },
        ),
        stderr: '',
      };
    }
    if (args[0] === 'inspect' && args[2] === '--format') {
      const c = state.container;
      if (!c) return { status: 1, stdout: '', stderr: 'no such' };
      return {
        status: 0,
        stdout: `/var/lib/postgresql/data|${c.mountedVolume ?? VOLUME}\n`,
        stderr: '',
      };
    }
    if (args[0] === 'inspect') {
      const c = state.container;
      if (!c) return { status: 1, stdout: '', stderr: 'no such' };
      return {
        status: 0,
        stdout: JSON.stringify([
          {
            Id: 'abcdef0123456789',
            Name: c.name ?? '/pos_db_test',
            State: { Running: c.running ?? true },
            Config: {
              Labels: c.labels ?? {
                'com.docker.compose.project': PROJECT,
                'com.docker.compose.service': 'db_test',
              },
            },
            HostConfig: { PortBindings: c.portBindings ?? { '5432/tcp': [{ HostPort: '5433' }] } },
          },
        ]),
        stderr: '',
      };
    }
    return { status: 1, stdout: '', stderr: 'comando no simulado' };
  };
  run.calls = calls;
  return run;
}

function identityRunner({ db = 'pos_db_test', usr = 'pos_test_user', fail = false } = {}) {
  const calls = [];
  const fn = async (_c, statements) => {
    calls.push(statements.length);
    return statements.map((s) =>
      s.sql.includes('current_database')
        ? fail
          ? { ok: false, error: 'refused' }
          : { ok: true, rows: [{ db, usr, port: '5432', marker: '' }] }
        : { ok: false, error: 'x' },
    );
  };
  fn.calls = calls;
  return fn;
}

const opts = (extra) => ({ ...envFile({ DATABASE_URL: GOOD_URL }), inheritedEnv: {}, ...extra });

async function codeOf(fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof guard.TestDatabaseGuardError, `inesperado: ${error}`);
    return error.code;
  }
  return 'NO_ERROR';
}

test('contenedor en ejecución y todo coherente: plan de limpieza + identidad confirmada', async () => {
  const idr = identityRunner();
  const result = await runPreflight(
    opts({ run: fakeDocker({ container: {} }), runStatements: idr }),
  );
  assert.equal(result.plan.action, 'REMOVE_CONTAINER_AND_VOLUME');
  assert.equal(result.plan.volumeName, VOLUME);
  assert.equal(result.containerId, 'abcdef012345');
  assert.equal(result.identityVerified, true);
});

test('contenedor detenido: no se afirma identidad (no se consulta la base)', async () => {
  const idr = identityRunner();
  const result = await runPreflight(
    opts({ run: fakeDocker({ container: { running: false } }), runStatements: idr }),
  );
  assert.equal(result.identityVerified, false);
  assert.equal(idr.calls.length, 0);
});

test('sin contenedor pero con volumen: solo volumen, sin consulta a la base', async () => {
  const idr = identityRunner();
  const result = await runPreflight(opts({ run: fakeDocker({ container: null }), runStatements: idr }));
  assert.equal(result.plan.action, 'REMOVE_VOLUME_ONLY');
  assert.equal(result.containerId, null);
  assert.equal(idr.calls.length, 0);
});

test('sin contenedor ni volumen: NOOP', async () => {
  const result = await runPreflight(
    opts({ run: fakeDocker({ container: null, volumes: [] }), runStatements: identityRunner() }),
  );
  assert.equal(result.plan.action, 'NOOP');
});

test('puerto publicado por Compose distinto del de la política -> COMPOSE_MISMATCH', async () => {
  const compose = composeJson({ ports: [{ target: 5432, published: '5434' }] });
  assert.equal(
    await codeOf(() => runPreflight(opts({ run: fakeDocker({ compose, container: null }) }))),
    CODES.COMPOSE_MISMATCH,
  );
});

test('Compose incoherente (base, usuario, nombre de contenedor, volumen) -> COMPOSE_MISMATCH', async () => {
  const cases = [
    composeJson({ environment: { POSTGRES_DB: 'pos_db', POSTGRES_USER: 'pos_test_user' } }),
    composeJson({ environment: { POSTGRES_DB: 'pos_db_test', POSTGRES_USER: 'pos_user' } }),
    composeJson({ container_name: 'otro' }),
    composeJson({ volumes: [{ source: 'pos_pgdata', target: '/var/lib/postgresql/data' }] }),
    composeJson({ ports: [] }),
  ];
  for (const compose of cases) {
    assert.equal(
      await codeOf(() => runPreflight(opts({ run: fakeDocker({ compose, container: null }) }))),
      CODES.COMPOSE_MISMATCH,
    );
  }
  const clash = composeJson();
  clash.services.db.ports = [{ target: 5432, published: '5433' }];
  assert.equal(
    await codeOf(() => runPreflight(opts({ run: fakeDocker({ compose: clash, container: null }) }))),
    CODES.COMPOSE_MISMATCH,
  );
});

test('contenedor de otro proyecto, otro servicio o con otro puerto -> RESOURCE_UNVERIFIED', async () => {
  const containers = [
    { labels: { 'com.docker.compose.project': 'otro', 'com.docker.compose.service': 'db_test' } },
    { labels: { 'com.docker.compose.project': PROJECT, 'com.docker.compose.service': 'db' } },
    { portBindings: { '5432/tcp': [{ HostPort: '5999' }] } },
    { name: '/otro_nombre' },
  ];
  for (const container of containers) {
    assert.equal(
      await codeOf(() =>
        runPreflight(opts({ run: fakeDocker({ container }), runStatements: identityRunner() })),
      ),
      CODES.RESOURCE_UNVERIFIED,
    );
  }
});

test('volumen montado distinto del resuelto por etiquetas -> RESOURCE_UNVERIFIED (nada se borra)', async () => {
  assert.equal(
    await codeOf(() =>
      runPreflight(
        opts({ run: fakeDocker({ container: { mountedVolume: 'proj_pos_pgdata' } }), runStatements: identityRunner() }),
      ),
    ),
    CODES.RESOURCE_UNVERIFIED,
  );
});

test('contenedor en ejecución cuya base no es pos_db_test -> IDENTITY_MISMATCH; inalcanzable -> IDENTITY_UNVERIFIABLE', async () => {
  assert.equal(
    await codeOf(() =>
      runPreflight(opts({ run: fakeDocker({ container: {} }), runStatements: identityRunner({ db: 'pos_db' }) })),
    ),
    CODES.IDENTITY_MISMATCH,
  );
  assert.equal(
    await codeOf(() =>
      runPreflight(opts({ run: fakeDocker({ container: {} }), runStatements: identityRunner({ fail: true }) })),
    ),
    CODES.IDENTITY_UNVERIFIABLE,
  );
});

test('docker compose config falla -> RESOURCE_UNVERIFIED', async () => {
  assert.equal(
    await codeOf(() => runPreflight(opts({ run: fakeDocker({ composeFail: true }) }))),
    CODES.RESOURCE_UNVERIFIED,
  );
});

test('autorización descartable presente: el reset se rechaza sin tocar Docker', async () => {
  const files = envFile(
    { DATABASE_URL: 'postgresql://scratch_user:p@localhost:55432/pos_db_test_scratch' },
    {
      DATABASE_URL: 'postgresql://scratch_user:p@localhost:55432/pos_db_test_scratch',
      E2E_DISPOSABLE_TARGET: 'localhost:55432/pos_db_test_scratch',
      E2E_DISPOSABLE_TOKEN: 'd4'.repeat(16),
    },
  );
  const docker = fakeDocker({ container: {} });
  assert.equal(
    await codeOf(() => runPreflight({ ...files, inheritedEnv: {}, run: docker })),
    CODES.RESET_NOT_ALLOWED,
  );
  assert.equal(docker.calls.length, 0);
});

test('variable heredada peligrosa o destino incorrecto: se rechaza antes de llamar a Docker', async () => {
  const docker = fakeDocker({ container: {} });
  assert.equal(
    await codeOf(() =>
      runPreflight(opts({ run: docker, inheritedEnv: { DATABASE_URL: 'postgresql://pos_user:p@localhost:5432/pos_db' } })),
    ),
    CODES.ENV_CONFLICT,
  );
  const bad = envFile({ DATABASE_URL: `postgresql://pos_test_user:${PW}@localhost:5433/pos_db` });
  assert.equal(
    await codeOf(() => runPreflight({ ...bad, inheritedEnv: {}, run: docker })),
    CODES.DB_RESERVED_NAME,
  );
  assert.equal(docker.calls.length, 0);
});

test('preflight es de solo lectura: ningún comando de Docker modifica recursos', async () => {
  const docker = fakeDocker({ container: {} });
  await runPreflight(opts({ run: docker, runStatements: identityRunner() }));
  for (const call of docker.calls) {
    assert.ok(!/\b(rm|stop|kill|down|up|prune|create|start)\b/.test(call), `comando de escritura: ${call}`);
  }
});

test('main: éxito -> 0; fallo -> 1 con "no se borra nada" y sin secretos', async () => {
  const files = envFile({ DATABASE_URL: GOOD_URL });
  const logs = [];
  const errors = [];
  const okCode = await main(['--env-file', files.baseFile, '--local-env-file', files.localFile], {
    inheritedEnv: {},
    run: fakeDocker({ container: {} }),
    runStatements: identityRunner(),
    log: (m) => logs.push(m),
    errorLog: (m) => errors.push(m),
  });
  assert.equal(okCode, 0);
  assert.ok(logs.join('\n').includes('REMOVE_CONTAINER_AND_VOLUME'));
  const badCode = await main(['--env-file', files.baseFile, '--local-env-file', files.localFile], {
    inheritedEnv: {},
    run: fakeDocker({ composeFail: true }),
    log: (m) => logs.push(m),
    errorLog: (m) => errors.push(m),
  });
  assert.equal(badCode, 1);
  assert.match(errors.join('\n'), /no se borra nada/);
  assert.ok(!errors.join('\n').includes(PW));
});

// ---------------------------------------------------------------------------
// M2: el demonio Docker debe ser local y verificable (antes de cualquier otra
// consulta de Docker y, por tanto, antes de cualquier operación destructiva).
// ---------------------------------------------------------------------------

const LOCAL_HOSTS_OK = [
  'npipe:////./pipe/dockerDesktopLinuxEngine',
  'npipe:////./pipe/docker_engine',
  'unix:///var/run/docker.sock',
  'unix:///home/dev/.docker/desktop/docker.sock',
];

test('M2: Docker Desktop local y otros endpoints locales válidos pasan', async () => {
  for (const host of LOCAL_HOSTS_OK) {
    const result = await runPreflight(
      opts({ run: fakeDocker({ container: null, context: { host } }), runStatements: identityRunner() }),
    );
    assert.equal(result.plan.action, 'REMOVE_VOLUME_ONLY', host);
  }
});

test('M2: contexto con nombre "default" o "desktop-linux" pero endpoint remoto -> DOCKER_NOT_LOCAL', async () => {
  for (const shown of ['default', 'desktop-linux', 'local']) {
    assert.equal(
      await codeOf(() =>
        runPreflight(
          opts({ run: fakeDocker({ context: { shown, host: 'ssh://deploy@prod.example.com' } }) }),
        ),
      ),
      CODES.DOCKER_NOT_LOCAL,
      shown,
    );
  }
});

test('M2: endpoints SSH, TCP, HTTP, npipe con host remoto y otros se rechazan', async () => {
  const remote = [
    'ssh://user@host',
    'tcp://10.0.0.5:2375',
    'tcp://127.0.0.1:2375', // un túnel local podría llevar a un servidor remoto: ambiguo
    'tcp://localhost:2376',
    'http://localhost:2375',
    'https://docker.example.com',
    'npipe://servidor/pipe/docker_engine',
    'npipe:////./pipe/',
    'unix://host/var/run/docker.sock',
    'fd://',
    '',
  ];
  for (const host of remote) {
    assert.equal(
      await codeOf(() => runPreflight(opts({ run: fakeDocker({ context: { host } }) }))),
      CODES.DOCKER_NOT_LOCAL,
      host,
    );
  }
});

test('M2: DOCKER_HOST presente (aunque parezca local) se rechaza antes de llamar a Docker', async () => {
  for (const value of ['tcp://remote:2375', 'ssh://u@h', 'npipe:////./pipe/docker_engine']) {
    const docker = fakeDocker({ container: {} });
    assert.equal(
      await codeOf(() => runPreflight(opts({ run: docker, inheritedEnv: { DOCKER_HOST: value } }))),
      CODES.DOCKER_NOT_LOCAL,
      value,
    );
    assert.equal(docker.calls.length, 0);
  }
});

test('M2: DOCKER_CONTEXT remoto o contradictorio con el contexto activo -> DOCKER_NOT_LOCAL', async () => {
  // DOCKER_CONTEXT apunta a un contexto remoto: Docker lo reporta como activo.
  assert.equal(
    await codeOf(() =>
      runPreflight(
        opts({
          run: fakeDocker({ context: { shown: 'prod', host: 'ssh://u@prod' } }),
          inheritedEnv: { DOCKER_CONTEXT: 'prod' },
        }),
      ),
    ),
    CODES.DOCKER_NOT_LOCAL,
  );
  // DOCKER_CONTEXT dice una cosa y Docker reporta otra.
  assert.equal(
    await codeOf(() =>
      runPreflight(
        opts({
          run: fakeDocker({ context: { shown: 'desktop-linux' } }),
          inheritedEnv: { DOCKER_CONTEXT: 'otro' },
        }),
      ),
    ),
    CODES.DOCKER_NOT_LOCAL,
  );
  // Coherente y local: pasa.
  const result = await runPreflight(
    opts({
      run: fakeDocker({ container: null, context: { shown: 'desktop-linux' } }),
      inheritedEnv: { DOCKER_CONTEXT: 'desktop-linux' },
    }),
  );
  assert.equal(result.plan.action, 'REMOVE_VOLUME_ONLY');
});

test('M2: errores y respuestas inválidas al consultar el contexto -> DOCKER_NOT_LOCAL', async () => {
  const cases = [
    { showFail: true },
    { shown: '' },
    { shown: 'nombre con espacios' },
    { shown: '../raro' },
    { inspectFail: true },
    { raw: 'no es json' },
    { raw: '[]' },
    { raw: '{}' },
    { raw: JSON.stringify([{ Name: 'desktop-linux' }]) }, // sin endpoint
    { raw: JSON.stringify([{ Name: 'desktop-linux', Endpoints: { docker: { Host: 5 } } }]) },
    { inspectedName: 'otro-contexto' }, // la inspección no es del contexto activo
    {
      raw: JSON.stringify([
        { Name: 'desktop-linux', Endpoints: { docker: { Host: 'npipe:////./pipe/docker_engine' } } },
        { Name: 'x', Endpoints: { docker: { Host: 'npipe:////./pipe/docker_engine' } } },
      ]),
    }, // más de una entrada
  ];
  for (const context of cases) {
    assert.equal(
      await codeOf(() => runPreflight(opts({ run: fakeDocker({ context }) }))),
      CODES.DOCKER_NOT_LOCAL,
      JSON.stringify(context),
    );
  }
});

test('M2: Docker no verificable rechaza antes de Compose, volúmenes o identidad', async () => {
  const docker = fakeDocker({ container: {}, context: { host: 'tcp://10.0.0.5:2375' } });
  const idr = identityRunner();
  assert.equal(
    await codeOf(() => runPreflight(opts({ run: docker, runStatements: idr }))),
    CODES.DOCKER_NOT_LOCAL,
  );
  assert.equal(idr.calls.length, 0);
  for (const call of docker.calls) {
    assert.ok(call.startsWith('docker context '), `consulta posterior al rechazo: ${call}`);
  }
});

test('M2: main con demonio remoto -> código 1, "no se borra nada" y sin secretos', async () => {
  const files = envFile({ DATABASE_URL: GOOD_URL });
  const errors = [];
  const code = await main(['--env-file', files.baseFile, '--local-env-file', files.localFile], {
    inheritedEnv: {},
    run: fakeDocker({ context: { host: 'ssh://u@h' } }),
    log: () => undefined,
    errorLog: (m) => errors.push(m),
  });
  assert.equal(code, 1);
  assert.match(errors.join('\n'), /no se borra nada/);
  assert.match(errors.join('\n'), /DOCKER_NOT_LOCAL/);
  assert.ok(!errors.join('\n').includes(PW));
});
