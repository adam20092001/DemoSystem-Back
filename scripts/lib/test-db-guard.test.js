'use strict';
/**
 * Pruebas unitarias de la guardia compartida (node:test, SIN base de datos real).
 * Ejecutar: npm run test:scripts
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const guard = require('./test-db-guard');

const { CODES } = guard;
/** Una URL con credenciales o host (el literal 'postgresql://' de un mensaje es inocuo). */
const LEAKY_URL = /:\/\/[^\s.]*[:@/]/;
const PW = 'S3cr3tPw';
const TOKEN = 'a1'.repeat(16); // 32 hex
const OTHER_TOKEN = 'b2'.repeat(16);
const BASE = '/virtual/.env.test';
const LOCAL = '/virtual/.env.test.local';
const GOOD_URL = `postgresql://pos_test_user:${PW}@localhost:5433/pos_db_test?schema=public`;
const SCRATCH_URL = `postgresql://scratch_user:${PW}@localhost:55432/pos_db_test_scratch?schema=public`;

function envFiles({ base, local }) {
  const toText = (o) =>
    Object.entries(o)
      .map(([k, v]) => `${k}=${v}`)
      .join('\n');
  return (file) => {
    if (file === BASE) return base === null ? null : toText(base ?? {});
    if (file === LOCAL) return local === undefined ? null : toText(local);
    return null;
  };
}

function resolve({ base = { DATABASE_URL: GOOD_URL }, local, inherited = {} } = {}) {
  return guard.resolveTarget({
    baseFile: BASE,
    localFile: LOCAL,
    inheritedEnv: inherited,
    readFile: envFiles({ base, local }),
  });
}

function codeOf(fn) {
  try {
    fn();
  } catch (error) {
    assert.ok(error instanceof guard.TestDatabaseGuardError, `error inesperado: ${error}`);
    return error.code;
  }
  return 'NO_ERROR';
}

async function codeOfAsync(fn) {
  try {
    await fn();
  } catch (error) {
    assert.ok(error instanceof guard.TestDatabaseGuardError, `error inesperado: ${error}`);
    return error.code;
  }
  return 'NO_ERROR';
}

const canonicalPolicy = () => guard.resolvePolicy({});
const evalUrl = (url, policy = canonicalPolicy()) => guard.evaluateTarget(url, policy);

const scratchLocal = {
  DATABASE_URL: SCRATCH_URL,
  E2E_DISPOSABLE_TARGET: 'localhost:55432/pos_db_test_scratch',
  E2E_DISPOSABLE_TOKEN: TOKEN,
};

// ---------------------------------------------------------------------------
// Parser y destino canónico
// ---------------------------------------------------------------------------

test('URL canónica válida: se acepta, con huella y sin filtrar la contraseña', () => {
  const evaluated = evalUrl(GOOD_URL);
  assert.equal(evaluated.kind, 'CANONICAL');
  assert.equal(evaluated.label, 'localhost:5433/pos_db_test');
  assert.match(evaluated.fingerprint, /^[0-9a-f]{64}$/);
  assert.ok(!JSON.stringify(evaluated).includes(PW));
  assert.ok(!require('node:util').inspect(evaluated).includes(PW));
  assert.ok(evaluated.connectionString.includes(PW)); // disponible, pero no enumerable
});

test('URL ausente o vacía -> URL_MISSING', () => {
  assert.equal(codeOf(() => evalUrl(undefined)), CODES.URL_MISSING);
  assert.equal(codeOf(() => evalUrl('')), CODES.URL_MISSING);
});

test('URL inválida, con espacios o con caracteres de control -> URL_INVALID', () => {
  for (const bad of [
    'no es una url',
    ' postgresql://u:p@localhost:5433/pos_db_test',
    'postgresql://u:p@localhost:5433/pos_db_test\n',
    'postgresql://u:p@loc\talhost:5433/pos_db_test',
    'postgresql://u:p@localhost:99999/pos_db_test',
    'postgresql://u:p@localhost:5433/pos_db_test#frag',
  ]) {
    assert.equal(codeOf(() => evalUrl(bad)), CODES.URL_INVALID, bad);
  }
});

test('protocolo distinto de postgresql -> PROTOCOL', () => {
  for (const bad of [
    'mysql://pos_test_user:p@localhost:5433/pos_db_test',
    'http://pos_test_user:p@localhost:5433/pos_db_test',
    'file:///pos_db_test',
  ]) {
    assert.equal(codeOf(() => evalUrl(bad)), CODES.PROTOCOL, bad);
  }
});

test('protocolo postgres:// también es válido', () => {
  const e = evalUrl('postgres://pos_test_user:p@127.0.0.1:5433/pos_db_test');
  assert.equal(e.host, '127.0.0.1');
});

test('nombre exacto: los nombres parecidos se rechazan', () => {
  for (const name of [
    'pos_db_test2',
    'pos_db_test_prod_copy',
    'pos_db_test_backup',
    'POS_DB_TEST',
    'pos_db_tes',
    'xpos_db_test',
    'pos_db_test%2Fx',
    'pos_db_test%20',
  ]) {
    const code = codeOf(() =>
      evalUrl(`postgresql://pos_test_user:p@localhost:5433/${name}`),
    );
    assert.ok(
      [CODES.DB_NAME_NOT_ALLOWED, CODES.URL_INVALID].includes(code),
      `${name} -> ${code}`,
    );
    assert.notEqual(code, 'NO_ERROR');
  }
});

test('nombres de base reservados (pos_db, postgres, plantillas) -> DB_RESERVED_NAME', () => {
  for (const name of ['pos_db', 'postgres', 'template0', 'template1']) {
    assert.equal(
      codeOf(() => evalUrl(`postgresql://pos_test_user:p@localhost:5433/${name}`)),
      CODES.DB_RESERVED_NAME,
      name,
    );
  }
});

test('parámetros manipulados -> PARAM_NOT_ALLOWED (incluye application_name=pos_db_test)', () => {
  for (const query of [
    'application_name=pos_db_test',
    'options=-csearch_path%3Dpublic',
    'host=/var/run/postgresql',
    'hostaddr=10.0.0.5',
    'dbname=pos_db',
    'schema=otro',
    'sslmode=verify-full',
    'schema=public&schema=public',
    'connect_timeout=abc',
  ]) {
    assert.equal(
      codeOf(() =>
        evalUrl(`postgresql://pos_test_user:p@localhost:5433/pos_db_test?${query}`),
      ),
      CODES.PARAM_NOT_ALLOWED,
      query,
    );
  }
});

test('parámetros permitidos: schema=public, timeouts numéricos y sslmode válido', () => {
  const e = evalUrl(
    'postgresql://pos_test_user:p@localhost:5433/pos_db_test?schema=public&connect_timeout=5&connection_limit=3&sslmode=disable',
  );
  assert.equal(e.database, 'pos_db_test');
});

test('el caso de la incidencia: pos_db con pos_db_test en un parámetro se rechaza', () => {
  assert.notEqual(
    codeOf(() =>
      evalUrl('postgresql://u:p@localhost:5433/pos_db?application_name=pos_db_test'),
    ),
    'NO_ERROR',
  );
});

test('usuario manipulado: pos_db_test como usuario sobre otra base, usuario de desarrollo y usuario ajeno', () => {
  assert.notEqual(
    codeOf(() => evalUrl('postgresql://pos_db_test:p@localhost:5433/pos_db')),
    'NO_ERROR',
  );
  assert.equal(
    codeOf(() => evalUrl('postgresql://pos_db_test:p@localhost:5433/pos_db_test')),
    CODES.USER_NOT_ALLOWED,
  );
  assert.equal(
    codeOf(() => evalUrl('postgresql://pos_user:p@localhost:5433/pos_db_test')),
    CODES.USER_NOT_ALLOWED,
  );
  assert.equal(
    codeOf(() => evalUrl('postgresql://alguien:p@localhost:5433/pos_db_test')),
    CODES.USER_NOT_ALLOWED,
  );
  assert.equal(
    codeOf(() => evalUrl('postgresql://:p@localhost:5433/pos_db_test')),
    CODES.USER_NOT_ALLOWED,
  );
});

test('TEST_POSTGRES_USER personaliza el usuario esperado, nunca pos_user/postgres', () => {
  const policy = guard.resolvePolicy({ TEST_POSTGRES_USER: 'dev2_test' });
  assert.equal(evalUrl('postgresql://dev2_test:p@localhost:5433/pos_db_test', policy).user, 'dev2_test');
  assert.equal(
    codeOf(() => guard.resolvePolicy({ TEST_POSTGRES_USER: 'pos_user' })),
    CODES.USER_NOT_ALLOWED,
  );
  assert.equal(
    codeOf(() => guard.resolvePolicy({ TEST_POSTGRES_USER: 'postgres' })),
    CODES.USER_NOT_ALLOWED,
  );
});

test('host: solo local por defecto; remotos y nombres de servicio se rechazan', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]', 'LOCALHOST']) {
    assert.doesNotThrow(() =>
      evalUrl(`postgresql://pos_test_user:p@${host}:5433/pos_db_test`),
    );
  }
  for (const host of [
    'prod-host',
    'db.example.com',
    'pos_db_test',
    'host.docker.internal',
    'db_test',
    '10.0.0.5',
    '0.0.0.0',
  ]) {
    assert.equal(
      codeOf(() => evalUrl(`postgresql://pos_test_user:p@${host}:5433/pos_db_test`)),
      CODES.HOST_NOT_ALLOWED,
      host,
    );
  }
});

test('host vacío o múltiple se rechaza', () => {
  assert.notEqual(codeOf(() => evalUrl('postgresql:///pos_db_test')), 'NO_ERROR');
  assert.notEqual(
    codeOf(() => evalUrl('postgresql://pos_test_user:p@localhost,otro:5433/pos_db_test')),
    'NO_ERROR',
  );
});

test('puerto: distinto del TEST esperado se rechaza (5432, ausente, otro)', () => {
  for (const port of ['5432', '5434', '1']) {
    assert.equal(
      codeOf(() => evalUrl(`postgresql://pos_test_user:p@localhost:${port}/pos_db_test`)),
      CODES.PORT_NOT_ALLOWED,
      port,
    );
  }
  assert.equal(
    codeOf(() => evalUrl('postgresql://pos_test_user:p@localhost/pos_db_test')),
    CODES.PORT_NOT_ALLOWED,
  );
});

test('TEST_POSTGRES_PORT configura el puerto esperado; 5432 y valores inválidos se rechazan', () => {
  const policy = guard.resolvePolicy({ TEST_POSTGRES_PORT: '5434' });
  assert.doesNotThrow(() =>
    evalUrl('postgresql://pos_test_user:p@localhost:5434/pos_db_test', policy),
  );
  assert.equal(
    codeOf(() => guard.resolvePolicy({ TEST_POSTGRES_PORT: '5432' })),
    CODES.PORT_NOT_ALLOWED,
  );
  assert.equal(
    codeOf(() => guard.resolvePolicy({ TEST_POSTGRES_PORT: 'abc' })),
    CODES.CONFIG_INVALID,
  );
  assert.equal(
    codeOf(() => guard.resolvePolicy({ TEST_POSTGRES_PORT: '80' })),
    CODES.PORT_NOT_ALLOWED,
  );
  assert.equal(
    codeOf(() => guard.resolvePolicy({ TEST_POSTGRES_DB: 'pos_db' })),
    CODES.CONFIG_INVALID,
  );
});

// ---------------------------------------------------------------------------
// Bases descartables
// ---------------------------------------------------------------------------

test('descartable autorizada exactamente: se acepta como DISPOSABLE', () => {
  const r = resolve({ base: { DATABASE_URL: SCRATCH_URL }, local: scratchLocal });
  assert.equal(r.evaluated.kind, 'DISPOSABLE');
  assert.equal(r.evaluated.label, 'localhost:55432/pos_db_test_scratch');
});

test('descartable no autorizada (sin E2E_DISPOSABLE_*) -> se rechaza por host/puerto/nombre', () => {
  assert.notEqual(
    codeOf(() => resolve({ base: { DATABASE_URL: SCRATCH_URL } })),
    'NO_ERROR',
  );
});

test('descartable: la URL debe coincidir EXACTAMENTE con el destino autorizado', () => {
  for (const url of [
    `postgresql://scratch_user:${PW}@localhost:55433/pos_db_test_scratch`, // puerto
    `postgresql://scratch_user:${PW}@localhost:55432/pos_db_test_scratch2`, // base
    `postgresql://scratch_user:${PW}@127.0.0.1:55432/pos_db_test_scratch`, // host
    GOOD_URL, // canónica con descartable configurada: contradictorio
  ]) {
    assert.equal(
      codeOf(() => resolve({ base: { DATABASE_URL: url }, local: { ...scratchLocal, DATABASE_URL: url } })),
      CODES.DISPOSABLE_CONTRADICTORY,
      url.replace(PW, '***'),
    );
  }
});

test('descartable: target y token deben definirse juntos', () => {
  assert.equal(
    codeOf(() => guard.resolvePolicy({ E2E_DISPOSABLE_TARGET: 'localhost:55432/pos_db_test_scratch' })),
    CODES.DISPOSABLE_INCOMPLETE,
  );
  assert.equal(
    codeOf(() => guard.resolvePolicy({ E2E_DISPOSABLE_TOKEN: TOKEN })),
    CODES.DISPOSABLE_INCOMPLETE,
  );
});

test('descartable: formato, comodines, nombres reservados y token inválido', () => {
  const policyWith = (target, token = TOKEN) =>
    guard.resolvePolicy({ E2E_DISPOSABLE_TARGET: target, E2E_DISPOSABLE_TOKEN: token });
  for (const target of [
    'localhost:55432/pos_db_test_*',
    'localhost:55432/pos_db_test_%',
    'localhost:55432/pos_db_test',
    'localhost:55432/pos_db',
    'localhost:55432/postgres',
    'localhost:55432/template0',
    'localhost:55432/otra_base',
    'localhost:55432/POS_DB_TEST_X',
    'localhost/pos_db_test_x',
    'localhost:55432',
    '*:55432/pos_db_test_x',
    'localhost:5432/pos_db_test_x', // 5432 local reservado
    'localhost:0/pos_db_test_x',
    'localhost:55432/pos_db_test_x,pos_db_test_y',
  ]) {
    assert.equal(codeOf(() => policyWith(target)), CODES.DISPOSABLE_INVALID, target);
  }
  for (const token of ['', 'abc', 'A1'.repeat(16), 'g1'.repeat(16), 'a1'.repeat(65)]) {
    assert.notEqual(
      codeOf(() => policyWith('localhost:55432/pos_db_test_x', token)),
      'NO_ERROR',
      token,
    );
  }
});

// M1: una base descartable solo puede estar en la propia máquina.
test('M1: hosts locales permitidos (localhost, 127.0.0.1, ::1) y puerto alto autorizado', () => {
  for (const [target, url] of [
    ['localhost:55432/pos_db_test_ci', 'postgresql://ci_user:p@localhost:55432/pos_db_test_ci'],
    ['LOCALHOST:55432/pos_db_test_ci', 'postgresql://ci_user:p@localhost:55432/pos_db_test_ci'],
    ['127.0.0.1:6000/pos_db_test_ci', 'postgresql://ci_user:p@127.0.0.1:6000/pos_db_test_ci'],
    ['[::1]:6000/pos_db_test_ci', 'postgresql://ci_user:p@[::1]:6000/pos_db_test_ci'],
    // Forma expandida: se normaliza igual que lo haría new URL() en DATABASE_URL.
    ['[0:0:0:0:0:0:0:1]:6000/pos_db_test_ci', 'postgresql://ci_user:p@[::1]:6000/pos_db_test_ci'],
  ]) {
    const policy = guard.resolvePolicy({ E2E_DISPOSABLE_TARGET: target, E2E_DISPOSABLE_TOKEN: TOKEN });
    assert.equal(evalUrl(url, policy).kind, 'DISPOSABLE', target);
  }
});

test('M1: hosts LAN, remotos, públicos y alias arbitrarios se rechazan', () => {
  for (const host of [
    'db.example.com',
    '192.168.1.20',
    '10.0.0.5',
    '8.8.8.8',
    'miequipo',
    'miequipo.local',
    'host.docker.internal',
    'localhost.localdomain',
    'localhost.',
    '127.0.0.2',
    '127.1',
    '0.0.0.0',
    '[::]',
    '[fe80::1]',
    '[2001:db8::1]',
    '[::ffff:127.0.0.1]',
  ]) {
    assert.equal(
      codeOf(() =>
        guard.resolvePolicy({
          E2E_DISPOSABLE_TARGET: `${host}:55432/pos_db_test_ci`,
          E2E_DISPOSABLE_TOKEN: TOKEN,
        }),
      ),
      CODES.DISPOSABLE_INVALID,
      host,
    );
  }
});

test('M1: puerto 5432 rechazado en cualquier host local; el nombre sigue siendo pos_db_test_<sufijo>', () => {
  for (const host of ['localhost', '127.0.0.1', '[::1]']) {
    assert.equal(
      codeOf(() =>
        guard.resolvePolicy({
          E2E_DISPOSABLE_TARGET: `${host}:5432/pos_db_test_ci`,
          E2E_DISPOSABLE_TOKEN: TOKEN,
        }),
      ),
      CODES.DISPOSABLE_INVALID,
      host,
    );
  }
  const policy = guard.resolvePolicy({
    E2E_DISPOSABLE_TARGET: 'localhost:6000/pos_db_test_ci',
    E2E_DISPOSABLE_TOKEN: TOKEN,
  });
  assert.equal(
    codeOf(() => evalUrl('postgresql://ci_user:p@localhost:6000/pos_db', policy)),
    CODES.DISPOSABLE_CONTRADICTORY,
  );
  assert.equal(
    codeOf(() => evalUrl('postgresql://pos_user:p@localhost:6000/pos_db_test_ci', policy)),
    CODES.USER_NOT_ALLOWED,
  );
  // Una URL remota nunca coincide con un destino local autorizado.
  assert.equal(
    codeOf(() => evalUrl('postgresql://ci_user:p@db.example.com:6000/pos_db_test_ci', policy)),
    CODES.DISPOSABLE_CONTRADICTORY,
  );
});

// ---------------------------------------------------------------------------
// Resolución del entorno (archivos vs shell)
// ---------------------------------------------------------------------------

test('falta .env.test -> ENV_FILE_MISSING', () => {
  assert.equal(codeOf(() => resolve({ base: null })), CODES.ENV_FILE_MISSING);
});

test('.env.test.local sobrescribe a .env.test', () => {
  const r = resolve({
    base: { DATABASE_URL: GOOD_URL },
    local: { DATABASE_URL: SCRATCH_URL, ...scratchLocal },
  });
  assert.equal(r.evaluated.kind, 'DISPOSABLE');
});

test('autorización descartable en .env.test (no local) -> DISPOSABLE_SOURCE_INVALID', () => {
  assert.equal(
    codeOf(() =>
      resolve({ base: { DATABASE_URL: SCRATCH_URL, ...scratchLocal } }),
    ),
    CODES.DISPOSABLE_SOURCE_INVALID,
  );
});

test('autorización descartable heredada del shell -> DISPOSABLE_SOURCE_INVALID', () => {
  assert.equal(
    codeOf(() =>
      resolve({
        inherited: {
          E2E_DISPOSABLE_TARGET: 'localhost:55432/pos_db_test_scratch',
          E2E_DISPOSABLE_TOKEN: TOKEN,
        },
      }),
    ),
    CODES.DISPOSABLE_SOURCE_INVALID,
  );
  // heredada y distinta de la local
  assert.equal(
    codeOf(() =>
      resolve({
        base: { DATABASE_URL: SCRATCH_URL },
        local: scratchLocal,
        inherited: { E2E_DISPOSABLE_TOKEN: OTHER_TOKEN },
      }),
    ),
    CODES.DISPOSABLE_SOURCE_INVALID,
  );
});

test('DATABASE_URL heredada que contradice los archivos -> ENV_CONFLICT', () => {
  assert.equal(
    codeOf(() =>
      resolve({
        inherited: { DATABASE_URL: 'postgresql://pos_user:p@localhost:5432/pos_db' },
      }),
    ),
    CODES.ENV_CONFLICT,
  );
});

test('DATABASE_URL heredada igual a la de archivo (incluida forma equivalente) no es conflicto', () => {
  assert.doesNotThrow(() => resolve({ inherited: { DATABASE_URL: GOOD_URL } }));
  assert.doesNotThrow(() =>
    resolve({
      inherited: {
        DATABASE_URL: new URL(GOOD_URL).href,
      },
    }),
  );
});

test('DATABASE_URL solo en el shell (no en archivos) -> ENV_CONFLICT; vacía se ignora', () => {
  assert.equal(
    codeOf(() => resolve({ base: {}, inherited: { DATABASE_URL: GOOD_URL } })),
    CODES.ENV_CONFLICT,
  );
  assert.equal(codeOf(() => resolve({ base: {}, inherited: { DATABASE_URL: '' } })), CODES.URL_MISSING);
});

test('TEST_POSTGRES_PORT heredado distinto -> ENV_CONFLICT; heredado sin archivo se ignora', () => {
  assert.equal(
    codeOf(() =>
      resolve({
        base: { DATABASE_URL: GOOD_URL, TEST_POSTGRES_PORT: '5433' },
        inherited: { TEST_POSTGRES_PORT: '5434' },
      }),
    ),
    CODES.ENV_CONFLICT,
  );
  assert.doesNotThrow(() => resolve({ inherited: { TEST_POSTGRES_PORT: '5434' } }));
  const r = resolve({ inherited: { TEST_POSTGRES_PORT: '5434' } });
  assert.equal(r.policy.canonical.port, 5433); // la política usa archivos/valores por defecto
});

test('NODE_ENV=production (heredado o en archivo) -> NODE_ENV', () => {
  assert.equal(codeOf(() => resolve({ inherited: { NODE_ENV: 'production' } })), CODES.NODE_ENV);
  assert.equal(
    codeOf(() => resolve({ base: { DATABASE_URL: GOOD_URL, NODE_ENV: 'production' } })),
    CODES.NODE_ENV,
  );
  assert.doesNotThrow(() => resolve({ inherited: { NODE_ENV: 'development' } }));
});

// ---------------------------------------------------------------------------
// Filtración de secretos
// ---------------------------------------------------------------------------

test('ningún mensaje de error contiene contraseñas, tokens ni la URL completa', () => {
  const urls = [
    `postgresql://pos_test_user:${PW}@prod-host:5433/pos_db_test`,
    `postgresql://pos_test_user:${PW}@localhost:5433/pos_db`,
    `postgresql://pos_test_user:${PW}@localhost:5433/pos_db_test?application_name=x`,
    `postgresql://pos_user:${PW}@localhost:5433/pos_db_test`,
    `mysql://pos_test_user:${PW}@localhost:5433/pos_db_test`,
    `postgresql://pos_test_user:${PW}@localhost:5434/pos_db_test`,
    `postgresql://pos_test_user:${PW}@localhost:5433/pos_db_test\n`,
  ];
  for (const url of urls) {
    try {
      evalUrl(url);
      assert.fail(`debía fallar: ${url}`);
    } catch (error) {
      assert.ok(error instanceof guard.TestDatabaseGuardError);
      assert.ok(!error.message.includes(PW), `filtra contraseña: ${error.message}`);
      assert.ok(!LEAKY_URL.test(error.message), `filtra URL: ${error.message}`);
    }
  }
  for (const token of [TOKEN]) {
    try {
      guard.resolvePolicy({
        E2E_DISPOSABLE_TARGET: 'localhost:55432/pos_db',
        E2E_DISPOSABLE_TOKEN: token,
      });
      assert.fail('debía fallar');
    } catch (error) {
      assert.ok(!error.message.includes(token));
    }
  }
});

test('redact elimina secretos y URLs de textos ajenos', () => {
  const out = guard.redact(`falló postgresql://u:${PW}@h:1/db con ${PW}`, [PW]);
  assert.ok(!out.includes(PW));
  assert.ok(!out.includes('u:'));
});

// ---------------------------------------------------------------------------
// Identidad real (con ejecutor simulado)
// ---------------------------------------------------------------------------

function fakeRunner({
  db = 'pos_db_test',
  usr = 'pos_test_user',
  port = '5432',
  marker = '',
  sysid = '7000000000000000001',
  relations = 0,
  failIdentity = false,
  throwError = null,
  writeFails = false,
} = {}) {
  const calls = [];
  const runner = async (connectionString, statements) => {
    calls.push({ connectionString, statements });
    if (throwError) throw throwError;
    return statements.map((s) => {
      if (s.write) {
        return writeFails ? { ok: false, error: 'permission denied' } : { ok: true, rows: [] };
      }
      if (s.sql.includes('current_database')) {
        return failIdentity
          ? { ok: false, error: 'connection refused' }
          : { ok: true, rows: [{ db, usr, port, marker }] };
      }
      if (s.sql.includes('pg_control_system')) {
        return sysid === null
          ? { ok: false, error: 'permission denied for function pg_control_system' }
          : { ok: true, rows: [{ sysid }] };
      }
      if (s.sql.includes('pg_class')) {
        return { ok: true, rows: [{ n: String(relations) }] };
      }
      return { ok: false, error: 'sql desconocido' };
    });
  };
  runner.calls = calls;
  return runner;
}

const canonicalResolved = () => resolve();
const scratchResolved = () =>
  resolve({ base: { DATABASE_URL: SCRATCH_URL }, local: scratchLocal });
const scratchMarker = (sysid) =>
  guard.buildMarkerValue(require('node:crypto').createHash('sha256').update(TOKEN).digest('hex'), sysid);

test('identidad canónica correcta: se acepta y no se exige marcador', async () => {
  const { evaluated, policy } = canonicalResolved();
  const identity = await guard.verifyServerIdentity(evaluated, policy, {
    runStatements: fakeRunner(),
  });
  assert.equal(identity.database, 'pos_db_test');
  assert.equal(identity.serverPort, 5432); // puerto interno, nunca se compara con el publicado
});

test('base real distinta de la esperada -> IDENTITY_MISMATCH', async () => {
  const { evaluated, policy } = canonicalResolved();
  assert.equal(
    await codeOfAsync(() =>
      guard.verifyServerIdentity(evaluated, policy, { runStatements: fakeRunner({ db: 'pos_db' }) }),
    ),
    CODES.IDENTITY_MISMATCH,
  );
  assert.equal(
    await codeOfAsync(() =>
      guard.verifyServerIdentity(evaluated, policy, { runStatements: fakeRunner({ usr: 'pos_user' }) }),
    ),
    CODES.IDENTITY_MISMATCH,
  );
});

test('error de conexión o consulta fallida -> IDENTITY_UNVERIFIABLE (falla cerrado, sin filtrar secretos)', async () => {
  const { evaluated, policy } = canonicalResolved();
  assert.equal(
    await codeOfAsync(() =>
      guard.verifyServerIdentity(evaluated, policy, { runStatements: fakeRunner({ failIdentity: true }) }),
    ),
    CODES.IDENTITY_UNVERIFIABLE,
  );
  try {
    await guard.verifyServerIdentity(evaluated, policy, {
      runStatements: fakeRunner({
        throwError: new Error(`no conecta a ${GOOD_URL} (${PW})`),
      }),
      secrets: [PW, GOOD_URL],
    });
    assert.fail('debía fallar');
  } catch (error) {
    assert.equal(error.code, CODES.IDENTITY_UNVERIFIABLE);
    assert.ok(!error.message.includes(PW));
    assert.ok(!LEAKY_URL.test(error.message));
  }
});

test('timeout real: un servidor TCP que no responde -> TIMEOUT', async () => {
  const sockets = [];
  const server = net.createServer((socket) => sockets.push(socket)); // acepta y calla
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address();
  try {
    const url = `postgresql://pos_test_user:${PW}@127.0.0.1:${port}/pos_db_test`;
    const policy = guard.resolvePolicy({ TEST_POSTGRES_PORT: String(port) });
    const evaluated = guard.evaluateTarget(url, policy);
    const code = await codeOfAsync(() =>
      guard.verifyServerIdentity(evaluated, policy, { timeoutMs: 400 }),
    );
    assert.ok(
      [CODES.TIMEOUT, CODES.IDENTITY_UNVERIFIABLE].includes(code),
      `código inesperado: ${code}`,
    );
    assert.notEqual(code, 'NO_ERROR');
  } finally {
    sockets.forEach((s) => s.destroy());
    await new Promise((r) => server.close(r));
  }
});

test('descartable: marcador ausente, de otro token o malformado se rechaza', async () => {
  const { evaluated, policy } = scratchResolved();
  const run = (extra) =>
    guard.verifyServerIdentity(evaluated, policy, {
      runStatements: fakeRunner({ db: 'pos_db_test_scratch', usr: 'scratch_user', ...extra }),
    });
  assert.equal(await codeOfAsync(() => run({ marker: '' })), CODES.MARKER_MISSING);
  assert.equal(
    await codeOfAsync(() =>
      run({
        marker: guard.buildMarkerValue(
          require('node:crypto').createHash('sha256').update(OTHER_TOKEN).digest('hex'),
          null,
        ),
      }),
    ),
    CODES.MARKER_MISMATCH,
  );
  assert.equal(await codeOfAsync(() => run({ marker: 'cualquier cosa' })), CODES.MARKER_MISMATCH);
  assert.equal(
    await codeOfAsync(() => run({ marker: 'demosystem-e2e-disposable:v1:zzzz' })),
    CODES.MARKER_MISMATCH,
  );
});

test('descartable: marcador válido (con y sin identificador de clúster)', async () => {
  const { evaluated, policy } = scratchResolved();
  const base = { db: 'pos_db_test_scratch', usr: 'scratch_user' };
  const okBound = await guard.verifyServerIdentity(evaluated, policy, {
    runStatements: fakeRunner({ ...base, marker: scratchMarker('7000000000000000001') }),
  });
  assert.equal(okBound.systemIdentifier, '7000000000000000001');
  await guard.verifyServerIdentity(evaluated, policy, {
    runStatements: fakeRunner({ ...base, marker: scratchMarker(null) }),
  });
});

test('descartable: marcador atado a otro clúster o clúster ilegible', async () => {
  const { evaluated, policy } = scratchResolved();
  const base = { db: 'pos_db_test_scratch', usr: 'scratch_user' };
  assert.equal(
    await codeOfAsync(() =>
      guard.verifyServerIdentity(evaluated, policy, {
        runStatements: fakeRunner({ ...base, marker: scratchMarker('7000000000000000001'), sysid: '9999' }),
      }),
    ),
    CODES.MARKER_MISMATCH,
  );
  assert.equal(
    await codeOfAsync(() =>
      guard.verifyServerIdentity(evaluated, policy, {
        runStatements: fakeRunner({ ...base, marker: scratchMarker('7000000000000000001'), sysid: null }),
      }),
    ),
    CODES.IDENTITY_UNVERIFIABLE,
  );
});

test('descartable con nombre real distinto del esperado -> IDENTITY_MISMATCH', async () => {
  const { evaluated, policy } = scratchResolved();
  assert.equal(
    await codeOfAsync(() =>
      guard.verifyServerIdentity(evaluated, policy, {
        runStatements: fakeRunner({ db: 'pos_db', usr: 'scratch_user', marker: scratchMarker(null) }),
      }),
    ),
    CODES.IDENTITY_MISMATCH,
  );
});

test('assertTestDatabaseReady no consulta si la política estructural falla', async () => {
  const runner = fakeRunner();
  const code = await codeOfAsync(() =>
    guard.assertTestDatabaseReady({
      baseFile: BASE,
      localFile: LOCAL,
      inheritedEnv: {},
      readFile: envFiles({ base: { DATABASE_URL: 'postgresql://u:p@prod:5432/pos_db' } }),
      runStatements: runner,
    }),
  );
  assert.notEqual(code, 'NO_ERROR');
  assert.equal(runner.calls.length, 0);
});

// ---------------------------------------------------------------------------
// Marcador: creación
// ---------------------------------------------------------------------------

const markOptions = (runStatements, resolved = true) => ({
  baseFile: BASE,
  localFile: LOCAL,
  inheritedEnv: {},
  readFile: envFiles({ base: { DATABASE_URL: SCRATCH_URL }, local: resolved ? scratchLocal : undefined }),
  runStatements,
});

test('marcar: base vacía -> escribe un único COMMENT con literal seguro', async () => {
  const runner = fakeRunner({ db: 'pos_db_test_scratch', usr: 'scratch_user', relations: 0 });
  const result = await guard.markDisposable(markOptions(runner));
  assert.equal(result.created, true);
  assert.equal(result.boundToCluster, true);
  const writes = runner.calls.flatMap((c) => c.statements).filter((s) => s.write);
  assert.equal(writes.length, 1);
  assert.match(
    writes[0].sql,
    /^COMMENT ON DATABASE "pos_db_test_scratch" IS 'demosystem-e2e-disposable:v1:[0-9a-f]{64}(:\d+)?'$/,
  );
});

test('marcar: base con tablas y sin marcador válido -> MARKER_NOT_EMPTY y ninguna escritura', async () => {
  const runner = fakeRunner({ db: 'pos_db_test_scratch', usr: 'scratch_user', relations: 12 });
  assert.equal(await codeOfAsync(() => guard.markDisposable(markOptions(runner))), CODES.MARKER_NOT_EMPTY);
  assert.equal(runner.calls.flatMap((c) => c.statements).filter((s) => s.write).length, 0);
});

test('marcar: marcador de OTRO token con tablas -> MARKER_NOT_EMPTY; del mismo token -> idempotente', async () => {
  const otherMarker = guard.buildMarkerValue(
    require('node:crypto').createHash('sha256').update(OTHER_TOKEN).digest('hex'),
    null,
  );
  const r1 = fakeRunner({ db: 'pos_db_test_scratch', usr: 'scratch_user', relations: 5, marker: otherMarker });
  assert.equal(await codeOfAsync(() => guard.markDisposable(markOptions(r1))), CODES.MARKER_NOT_EMPTY);
  const r2 = fakeRunner({
    db: 'pos_db_test_scratch',
    usr: 'scratch_user',
    relations: 5,
    marker: scratchMarker('7000000000000000001'),
  });
  const again = await guard.markDisposable(markOptions(r2));
  assert.equal(again.created, false);
  assert.equal(r2.calls.flatMap((c) => c.statements).filter((s) => s.write).length, 0);
});

test('marcar: sin autorización descartable, o con identidad distinta, no escribe', async () => {
  const noAuth = fakeRunner();
  assert.notEqual(
    await codeOfAsync(() =>
      guard.markDisposable({
        baseFile: BASE,
        localFile: LOCAL,
        inheritedEnv: {},
        readFile: envFiles({ base: { DATABASE_URL: GOOD_URL } }),
        runStatements: noAuth,
      }),
    ),
    'NO_ERROR',
  );
  assert.equal(noAuth.calls.length, 0);
  const wrongDb = fakeRunner({ db: 'pos_db', usr: 'scratch_user' });
  assert.equal(await codeOfAsync(() => guard.markDisposable(markOptions(wrongDb))), CODES.IDENTITY_MISMATCH);
  assert.equal(wrongDb.calls.flatMap((c) => c.statements).filter((s) => s.write).length, 0);
});

test('marcar: sin identificador de clúster disponible, el marcador no queda atado', async () => {
  const runner = fakeRunner({ db: 'pos_db_test_scratch', usr: 'scratch_user', sysid: null });
  const result = await guard.markDisposable(markOptions(runner));
  assert.equal(result.boundToCluster, false);
});

test('marcar: fallo al escribir -> error sin filtrar', async () => {
  const runner = fakeRunner({ db: 'pos_db_test_scratch', usr: 'scratch_user', writeFails: true });
  assert.equal(
    await codeOfAsync(() => guard.markDisposable(markOptions(runner))),
    CODES.IDENTITY_UNVERIFIABLE,
  );
});

// ---------------------------------------------------------------------------
// Huella y entorno
// ---------------------------------------------------------------------------

test('huella: válida para el mismo destino y PID; inválida si falta, difiere o es heredada', () => {
  const { evaluated } = canonicalResolved();
  const { evaluated: other } = scratchResolved();
  const fp = guard.issueVerifiedFingerprint(evaluated, 4242);
  assert.doesNotThrow(() => guard.assertVerifiedFingerprint(evaluated, fp, { pid: 4242, ppid: 1 }));
  assert.doesNotThrow(() => guard.assertVerifiedFingerprint(evaluated, fp, { pid: 7, ppid: 4242 })); // worker hijo
  assert.equal(codeOf(() => guard.assertVerifiedFingerprint(evaluated, fp, { pid: 7, ppid: 8 })), CODES.FINGERPRINT_INVALID);
  assert.equal(codeOf(() => guard.assertVerifiedFingerprint(evaluated, undefined)), CODES.FINGERPRINT_INVALID);
  assert.equal(codeOf(() => guard.assertVerifiedFingerprint(evaluated, 'v1:deadbeef:1')), CODES.FINGERPRINT_INVALID);
  assert.equal(codeOf(() => guard.assertVerifiedFingerprint(other, fp, { pid: 4242 })), CODES.FINGERPRINT_INVALID);
});

test('applyEnvToProcess: no exporta claves de autorización ni sobrescribe variables existentes', () => {
  const { evaluated, values } = resolve({
    base: { DATABASE_URL: SCRATCH_URL, JWT_SECRET: 'x'.repeat(40), PORT: '3100' },
    local: scratchLocal,
  });
  const target = { PORT: '9999', DATABASE_URL: 'otra' };
  guard.applyEnvToProcess(values, evaluated, target);
  assert.equal(target.PORT, '9999'); // no sobrescribe
  assert.equal(target.JWT_SECRET, 'x'.repeat(40));
  assert.equal(target.DATABASE_URL, evaluated.connectionString); // siempre el destino validado
  assert.equal(target.E2E_DISPOSABLE_TOKEN, undefined);
  assert.equal(target.E2E_DISPOSABLE_TARGET, undefined);
});

test('parseGuardCliArgs: rutas explícitas, resto del comando y opciones inválidas', () => {
  const r = guard.parseGuardCliArgs(['--env-file', 'a.env', '--local-env-file', 'b.env', 'prisma', 'migrate'], '/cwd');
  assert.equal(path.basename(r.baseFile), 'a.env');
  assert.equal(path.basename(r.localFile), 'b.env');
  assert.deepEqual(r.rest, ['prisma', 'migrate']);
  assert.equal(codeOf(() => guard.parseGuardCliArgs(['--env-file'])), CODES.CLI_USAGE);
  assert.equal(codeOf(() => guard.parseGuardCliArgs(['--otra', 'x'])), CODES.CLI_USAGE);
});

// ---------------------------------------------------------------------------
// Garantía estática: la guardia no usa coincidencia de texto
// ---------------------------------------------------------------------------

test('ningún archivo de seguridad usa includes("pos_db_test") como control', () => {
  const root = path.resolve(__dirname, '..', '..');
  const files = [
    'scripts/lib/test-db-guard.js',
    'scripts/run-with-test-db.js',
    'scripts/test-db-preflight.js',
    'scripts/test-db-mark-disposable.js',
    'test/jest-e2e.setup.ts',
    'test/jest-e2e.global-setup.ts',
    'test/helpers/prisma-test-client.ts',
    'test/helpers/e2e-database-target.ts',
    'test/helpers/e2e-app.ts',
    'test/helpers/sire-demo-app.ts',
  ];
  for (const file of files) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    assert.ok(
      !/includes\(\s*['"`]pos_db_test/.test(text),
      `${file} usa includes('pos_db_test')`,
    );
  }
});
