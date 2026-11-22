'use strict';
/**
 * Pruebas de run-with-test-db.js (node:test, SIN base de datos real: la
 * verificación de identidad y el proceso hijo están simulados).
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const guard = require('./lib/test-db-guard');
const { main, buildChildEnv } = require('./run-with-test-db');

const PW = 'S3cr3tPw';
const TOKEN = 'c3'.repeat(16);
const GOOD_URL = `postgresql://pos_test_user:${PW}@localhost:5433/pos_db_test?schema=public`;
const SCRATCH_URL = `postgresql://scratch_user:${PW}@localhost:55432/pos_db_test_scratch`;

function tempEnv({ base, local }) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-with-test-db-'));
  const write = (name, obj) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, Object.entries(obj).map(([k, v]) => `${k}=${v}`).join('\n'));
    return file;
  };
  const baseFile = write('.env.test', base);
  const localFile = path.join(dir, '.env.test.local');
  if (local) write('.env.test.local', local);
  return { dir, baseFile, localFile };
}

function runner({ db, usr, marker = '' }) {
  const calls = [];
  const fn = async (_conn, statements) => {
    calls.push(statements.length);
    return statements.map((s) =>
      s.sql.includes('current_database')
        ? { ok: true, rows: [{ db, usr, port: '5432', marker }] }
        : s.sql.includes('pg_control_system')
          ? { ok: true, rows: [{ sysid: '7000000000000000001' }] }
          : { ok: false, error: 'x' },
    );
  };
  fn.calls = calls;
  return fn;
}

function harness() {
  const out = { logs: [], errors: [], spawns: [] };
  return {
    out,
    deps: (extra = {}) => ({
      log: (m) => out.logs.push(m),
      errorLog: (m) => out.errors.push(m),
      spawn: (command, options) => {
        out.spawns.push({ command, options });
        return { status: 0 };
      },
      ...extra,
    }),
  };
}

const markerFor = (token, sysid) =>
  guard.buildMarkerValue(createHash('sha256').update(token).digest('hex'), sysid);

test('destino canónico válido: lanza el comando con entorno explícito', async () => {
  const files = tempEnv({ base: { DATABASE_URL: GOOD_URL, JWT_SECRET: 'j'.repeat(40) } });
  const h = harness();
  const code = await main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'prisma', 'migrate', 'deploy'],
    h.deps({
      inheritedEnv: { PATH: '/bin', E2E_VERIFIED_FINGERPRINT: 'v1:x:1', E2E_DISPOSABLE_TOKEN: undefined },
      runStatements: runner({ db: 'pos_db_test', usr: 'pos_test_user' }),
    }),
  );
  assert.equal(code, 0);
  assert.equal(h.out.spawns.length, 1);
  const { command, options } = h.out.spawns[0];
  assert.equal(command, 'prisma migrate deploy');
  assert.equal(options.env.DATABASE_URL, new URL(GOOD_URL).href);
  assert.equal(options.env.JWT_SECRET, 'j'.repeat(40));
  assert.equal(options.env.E2E_VERIFIED_FINGERPRINT, undefined); // huella heredada descartada
  assert.ok(h.out.logs.join('\n').includes('CANONICAL localhost:5433/pos_db_test'));
  assert.ok(!h.out.logs.join('\n').includes(PW));
});

test('identidad distinta: NO se lanza nada y el mensaje no filtra secretos', async () => {
  const files = tempEnv({ base: { DATABASE_URL: GOOD_URL } });
  const h = harness();
  const code = await main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'prisma', 'db', 'seed'],
    h.deps({ inheritedEnv: {}, runStatements: runner({ db: 'pos_db', usr: 'pos_test_user' }) }),
  );
  assert.equal(code, 1);
  assert.equal(h.out.spawns.length, 0);
  assert.match(h.out.errors.join('\n'), /ABORTADO/);
  assert.ok(!h.out.errors.join('\n').includes(PW));
});

test('estructura inválida: no se consulta ni se lanza nada', async () => {
  const files = tempEnv({
    base: { DATABASE_URL: `postgresql://pos_test_user:${PW}@localhost:5433/pos_db?application_name=pos_db_test` },
  });
  const h = harness();
  const r = runner({ db: 'pos_db_test', usr: 'pos_test_user' });
  const code = await main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'prisma', 'migrate', 'deploy'],
    h.deps({ inheritedEnv: {}, runStatements: r }),
  );
  assert.equal(code, 1);
  assert.equal(r.calls.length, 0);
  assert.equal(h.out.spawns.length, 0);
});

test('DATABASE_URL heredada del shell que contradice a los archivos: no se lanza nada', async () => {
  const files = tempEnv({ base: { DATABASE_URL: GOOD_URL } });
  const h = harness();
  const r = runner({ db: 'pos_db', usr: 'pos_user' });
  const code = await main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'prisma', 'migrate', 'deploy'],
    h.deps({
      inheritedEnv: { DATABASE_URL: 'postgresql://pos_user:p@localhost:5432/pos_db' },
      runStatements: r,
    }),
  );
  assert.equal(code, 1);
  assert.equal(r.calls.length, 0);
  assert.equal(h.out.spawns.length, 0);
  assert.match(h.out.errors.join('\n'), /ENV_CONFLICT/);
});

test('descartable: sin marcador no se lanza; con marcador válido sí, sin exportar la autorización', async () => {
  const files = tempEnv({
    base: { DATABASE_URL: SCRATCH_URL },
    local: {
      DATABASE_URL: SCRATCH_URL,
      E2E_DISPOSABLE_TARGET: 'localhost:55432/pos_db_test_scratch',
      E2E_DISPOSABLE_TOKEN: TOKEN,
    },
  });
  const argv = ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'prisma', 'migrate', 'deploy'];
  const h1 = harness();
  const noMarker = await main(
    argv,
    h1.deps({ inheritedEnv: {}, runStatements: runner({ db: 'pos_db_test_scratch', usr: 'scratch_user' }) }),
  );
  assert.equal(noMarker, 1);
  assert.equal(h1.out.spawns.length, 0);
  assert.match(h1.out.errors.join('\n'), /MARKER_MISSING/);

  const h2 = harness();
  const ok = await main(
    argv,
    h2.deps({
      inheritedEnv: {},
      runStatements: runner({
        db: 'pos_db_test_scratch',
        usr: 'scratch_user',
        marker: markerFor(TOKEN, '7000000000000000001'),
      }),
    }),
  );
  assert.equal(ok, 0);
  const env = h2.out.spawns[0].options.env;
  assert.equal(env.E2E_DISPOSABLE_TOKEN, undefined);
  assert.equal(env.E2E_DISPOSABLE_TARGET, undefined);
  assert.ok(env.DATABASE_URL.includes('pos_db_test_scratch'));
});

test('sin comando: error de uso y código distinto de cero', async () => {
  const files = tempEnv({ base: { DATABASE_URL: GOOD_URL } });
  const h = harness();
  const code = await main(['--env-file', files.baseFile], h.deps({ inheritedEnv: {} }));
  assert.equal(code, 1);
  assert.equal(h.out.spawns.length, 0);
});

test('falta .env.test: aborta con mensaje claro', async () => {
  const h = harness();
  const code = await main(
    ['--env-file', path.join(os.tmpdir(), 'no-existe-xyz', '.env.test'), 'prisma', 'migrate', 'deploy'],
    h.deps({ inheritedEnv: {} }),
  );
  assert.equal(code, 1);
  assert.match(h.out.errors.join('\n'), /ENV_FILE_MISSING/);
});

test('el código de salida del hijo se propaga', async () => {
  const files = tempEnv({ base: { DATABASE_URL: GOOD_URL } });
  const h = harness();
  const code = await main(
    ['--env-file', files.baseFile, '--local-env-file', files.localFile, 'prisma', 'migrate', 'deploy'],
    h.deps({
      inheritedEnv: {},
      runStatements: runner({ db: 'pos_db_test', usr: 'pos_test_user' }),
      spawn: () => ({ status: 3 }),
    }),
  );
  assert.equal(code, 3);
});

test('buildChildEnv: elimina autorización y huella, fija DATABASE_URL validada', () => {
  const { resolveTarget } = guard;
  const files = tempEnv({ base: { DATABASE_URL: GOOD_URL, PORT: '3100' } });
  const { evaluated, values } = resolveTarget({
    baseFile: files.baseFile,
    localFile: files.localFile,
    inheritedEnv: {},
  });
  const env = buildChildEnv({
    inherited: {
      PATH: '/bin',
      E2E_DISPOSABLE_TOKEN: 'x',
      E2E_DISPOSABLE_TARGET: 'y',
      E2E_VERIFIED_FINGERPRINT: 'z',
      DATABASE_URL: 'otra',
    },
    values,
    evaluated,
  });
  assert.equal(env.PATH, '/bin');
  assert.equal(env.PORT, '3100');
  assert.equal(env.E2E_DISPOSABLE_TOKEN, undefined);
  assert.equal(env.E2E_DISPOSABLE_TARGET, undefined);
  assert.equal(env.E2E_VERIFIED_FINGERPRINT, undefined);
  assert.equal(env.DATABASE_URL, evaluated.connectionString);
});
