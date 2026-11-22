'use strict';
/**
 * Guardia compartida de seguridad para pruebas E2E y herramientas TEST
 * (INC-E2E-database-guard).
 *
 * Responsabilidades (en orden de ejecución):
 *   1. Resolución del entorno: .env.test (base) + .env.test.local (override
 *      explícito). Las variables heredadas del shell NUNCA sustituyen a los
 *      archivos: si contradicen, se falla con ENV_CONFLICT.
 *   2. Política estructural (sin conexión): parser `new URL()`, protocolo,
 *      host, puerto, base EXACTA, usuario y lista blanca de parámetros.
 *   3. Identidad real tras conectar (solo lectura): `current_database()`,
 *      usuario de sesión y, para bases descartables, el marcador de instancia.
 *   4. Huella del destino validado (para que las suites comprueben que el
 *      destino no cambió durante la corrida).
 *
 * Qué NO es: `current_database()` y el marcador son defensas ADICIONALES
 * contra errores de configuración; no autentican criptográficamente al
 * servidor. El control definitivo sigue siendo operativo (credenciales
 * distintas por entorno).
 *
 * Nunca se usa coincidencia de texto sobre la URL completa como control.
 * Ningún mensaje de error contiene contraseñas, tokens ni URLs completas.
 *
 * Módulo CommonJS sin dependencias de Nest/Prisma de negocio: lo consumen
 * scripts Node planos y las pruebas E2E (TypeScript, vía test-db-guard.d.ts).
 */
const { createHash } = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { parse: parseDotenv } = require('dotenv');

// ---------------------------------------------------------------------------
// Constantes de política
// ---------------------------------------------------------------------------

const CANONICAL_DATABASE = 'pos_db_test';
const DEFAULT_TEST_PORT = 5433;
const DEV_RESERVED_PORT = 5432;
const DEFAULT_TEST_USER = 'pos_test_user';
const RESERVED_USERS = new Set(['pos_user', 'postgres']);
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);
const RESERVED_DATABASES = new Set([
  'pos_db',
  'postgres',
  'template0',
  'template1',
]);
/** Piso de nombre para descartables: NO autoriza, solo impide autorizar bases sensibles. */
const DISPOSABLE_NAME_RE = /^pos_db_test_[a-z0-9_]{1,40}$/;
const TOKEN_RE = /^[0-9a-f]{32,128}$/;
const DISPOSABLE_TARGET_RE =
  /^(\[[0-9A-Fa-f:]+\]|[A-Za-z0-9.-]+):(\d{1,5})\/([a-z0-9_]+)$/;
const MARKER_PREFIX = 'demosystem-e2e-disposable:v1:';
const IDENTITY_TIMEOUT_MS = 5000;

const DEFAULT_BASE_ENV_FILE = '.env.test';
const DEFAULT_LOCAL_ENV_FILE = '.env.test.local';

/** Variables que solo pueden venir de .env.test.local. */
const DISPOSABLE_KEYS = ['E2E_DISPOSABLE_TARGET', 'E2E_DISPOSABLE_TOKEN'];
/** Variables guardadas: una versión heredada que contradiga el archivo es un error. */
const CONFLICT_KEYS = [
  'DATABASE_URL',
  'TEST_POSTGRES_PORT',
  'TEST_POSTGRES_USER',
  'TEST_POSTGRES_DB',
];
/** Claves que nunca se exportan al proceso hijo ni a las suites. */
const NEVER_EXPORT_KEYS = [...DISPOSABLE_KEYS, 'E2E_VERIFIED_FINGERPRINT'];

const ALLOWED_PARAMS = {
  schema: (v) => v === 'public',
  connection_limit: (v) => /^\d{1,4}$/.test(v),
  pool_timeout: (v) => /^\d{1,5}$/.test(v),
  connect_timeout: (v) => /^\d{1,5}$/.test(v),
  sslmode: (v) => ['disable', 'prefer', 'require'].includes(v),
};

const CODES = Object.freeze({
  ENV_FILE_MISSING: 'ENV_FILE_MISSING',
  ENV_CONFLICT: 'ENV_CONFLICT',
  NODE_ENV: 'NODE_ENV',
  CONFIG_INVALID: 'CONFIG_INVALID',
  URL_MISSING: 'URL_MISSING',
  URL_INVALID: 'URL_INVALID',
  PROTOCOL: 'PROTOCOL',
  HOST_NOT_ALLOWED: 'HOST_NOT_ALLOWED',
  PORT_NOT_ALLOWED: 'PORT_NOT_ALLOWED',
  DB_NAME_NOT_ALLOWED: 'DB_NAME_NOT_ALLOWED',
  DB_RESERVED_NAME: 'DB_RESERVED_NAME',
  USER_NOT_ALLOWED: 'USER_NOT_ALLOWED',
  PARAM_NOT_ALLOWED: 'PARAM_NOT_ALLOWED',
  DISPOSABLE_SOURCE_INVALID: 'DISPOSABLE_SOURCE_INVALID',
  DISPOSABLE_INCOMPLETE: 'DISPOSABLE_INCOMPLETE',
  DISPOSABLE_INVALID: 'DISPOSABLE_INVALID',
  DISPOSABLE_CONTRADICTORY: 'DISPOSABLE_CONTRADICTORY',
  PRISMA_CLIENT_UNAVAILABLE: 'PRISMA_CLIENT_UNAVAILABLE',
  IDENTITY_UNVERIFIABLE: 'IDENTITY_UNVERIFIABLE',
  IDENTITY_MISMATCH: 'IDENTITY_MISMATCH',
  MARKER_MISSING: 'MARKER_MISSING',
  MARKER_MISMATCH: 'MARKER_MISMATCH',
  MARKER_NOT_EMPTY: 'MARKER_NOT_EMPTY',
  TIMEOUT: 'TIMEOUT',
  FINGERPRINT_INVALID: 'FINGERPRINT_INVALID',
  RESET_NOT_ALLOWED: 'RESET_NOT_ALLOWED',
  COMPOSE_MISMATCH: 'COMPOSE_MISMATCH',
  DOCKER_NOT_LOCAL: 'DOCKER_NOT_LOCAL',
  RESOURCE_UNVERIFIED: 'RESOURCE_UNVERIFIED',
  CLI_USAGE: 'CLI_USAGE',
});

class TestDatabaseGuardError extends Error {
  /**
   * @param {string} code  uno de CODES
   * @param {string} message  mensaje en español, SIN secretos
   */
  constructor(code, message) {
    super(`[${code}] ${message}`);
    this.name = 'TestDatabaseGuardError';
    this.code = code;
  }
}

function fail(code, message) {
  throw new TestDatabaseGuardError(code, message);
}

// ---------------------------------------------------------------------------
// Utilidades
// ---------------------------------------------------------------------------

/** Reemplaza cualquier secreto conocido y recorta el texto (mensajes de errores ajenos). */
function redact(text, secrets = []) {
  let out = String(text ?? '');
  for (const secret of secrets) {
    if (typeof secret === 'string' && secret.length >= 3) {
      out = out.split(secret).join('***');
    }
  }
  out = out.replace(/(postgres(?:ql)?:\/\/)[^\s'"`]+/gi, '$1***');
  return out.length > 240 ? `${out.slice(0, 240)}…` : out;
}

function sha256(text) {
  return createHash('sha256').update(text).digest('hex');
}

function isDefined(value) {
  return typeof value === 'string' && value.length > 0;
}

// ---------------------------------------------------------------------------
// 1. Resolución del entorno
// ---------------------------------------------------------------------------

function defaultReadFile(file) {
  try {
    return fs.readFileSync(file, 'utf8');
  } catch (error) {
    if (error && error.code === 'ENOENT') return null;
    throw error;
  }
}

/** Forma canónica de una URL de conexión para comparar sin falsos conflictos. */
function canonicalizeUrl(raw) {
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/**
 * Resuelve el entorno TEST leyendo SOLO archivos como fuente de verdad.
 *
 * @param {object} options
 * @param {string} options.baseFile   ruta de .env.test (obligatorio)
 * @param {string} [options.localFile] ruta de .env.test.local (opcional)
 * @param {Record<string,string|undefined>} [options.inheritedEnv]
 * @param {(file:string)=>string|null} [options.readFile]
 * @returns {{ values: Record<string,string>, local: Record<string,string> }}
 */
function loadGuardedEnv(options) {
  const {
    baseFile,
    localFile,
    inheritedEnv = process.env,
    readFile = defaultReadFile,
  } = options;

  const baseText = readFile(baseFile);
  if (baseText === null) {
    fail(
      CODES.ENV_FILE_MISSING,
      `No se encontró ${path.basename(baseFile)}. Copia .env.test.example a ` +
        '.env.test antes de ejecutar pruebas E2E o comandos Prisma TEST.',
    );
  }
  const base = parseDotenv(baseText);
  const localText = localFile ? readFile(localFile) : null;
  const local = localText === null ? {} : parseDotenv(localText);
  const values = { ...base, ...local };

  // Autorización de descartables: únicamente desde .env.test.local.
  for (const key of DISPOSABLE_KEYS) {
    if (isDefined(base[key])) {
      fail(
        CODES.DISPOSABLE_SOURCE_INVALID,
        `${key} solo puede definirse en .env.test.local, nunca en .env.test.`,
      );
    }
    if (isDefined(inheritedEnv[key]) && inheritedEnv[key] !== local[key]) {
      fail(
        CODES.DISPOSABLE_SOURCE_INVALID,
        `${key} está definido en el entorno del shell. La autorización de ` +
          'bases descartables solo se acepta desde .env.test.local.',
      );
    }
  }

  // Variables heredadas que contradicen a los archivos.
  for (const key of CONFLICT_KEYS) {
    const inherited = inheritedEnv[key];
    if (!isDefined(inherited)) continue;
    const fromFile = values[key];
    if (!isDefined(fromFile)) {
      if (key === 'DATABASE_URL') {
        fail(
          CODES.ENV_CONFLICT,
          'DATABASE_URL está definido en el shell pero no en los archivos ' +
            '.env.test/.env.test.local. Defínelo en el archivo; el valor ' +
            'heredado no se acepta.',
        );
      }
      continue; // TEST_POSTGRES_*: la política usa solo archivos y valores por defecto.
    }
    const equal =
      key === 'DATABASE_URL'
        ? canonicalizeUrl(inherited) === canonicalizeUrl(fromFile)
        : inherited === fromFile;
    if (!equal) {
      fail(
        CODES.ENV_CONFLICT,
        `${key} heredado del shell contradice el valor de .env.test/` +
          '.env.test.local. Elimina la variable del shell (o alinea los archivos).',
      );
    }
  }

  // Entorno de producción: nunca.
  if (inheritedEnv.NODE_ENV === 'production' || values.NODE_ENV === 'production') {
    fail(CODES.NODE_ENV, 'NODE_ENV=production no es válido para herramientas TEST.');
  }

  return { values, local };
}

// ---------------------------------------------------------------------------
// 2. Política estructural
// ---------------------------------------------------------------------------

/**
 * Parsea una URL de conexión PostgreSQL con `new URL()` (nunca por texto).
 * No devuelve la contraseña; `connectionString` queda como propiedad NO
 * enumerable para que no aparezca en logs/JSON por accidente.
 */
function parseDatabaseUrl(raw) {
  if (!isDefined(raw)) {
    fail(CODES.URL_MISSING, 'DATABASE_URL no está definido.');
  }
  if (/[\u0000- \u007f]/.test(raw)) {
    fail(CODES.URL_INVALID, 'DATABASE_URL contiene espacios o caracteres de control.');
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    fail(CODES.URL_INVALID, 'DATABASE_URL no es una URL válida.');
  }
  if (url.protocol !== 'postgresql:' && url.protocol !== 'postgres:') {
    fail(CODES.PROTOCOL, 'DATABASE_URL debe usar el protocolo postgresql://.');
  }
  if (url.hash) {
    fail(CODES.URL_INVALID, 'DATABASE_URL no admite fragmento (#).');
  }
  const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (!host || host.includes(',')) {
    fail(CODES.HOST_NOT_ALLOWED, 'DATABASE_URL debe indicar exactamente un host.');
  }
  const port = url.port === '' ? 5432 : Number(url.port);

  if (!url.pathname.startsWith('/')) {
    fail(CODES.URL_INVALID, 'DATABASE_URL no indica nombre de base.');
  }
  let database;
  try {
    database = decodeURIComponent(url.pathname.slice(1));
  } catch {
    fail(CODES.URL_INVALID, 'El nombre de base de DATABASE_URL está mal codificado.');
  }
  if (!database || database.includes('/')) {
    fail(CODES.DB_NAME_NOT_ALLOWED, 'El nombre de base de DATABASE_URL no es válido.');
  }

  let user;
  try {
    user = decodeURIComponent(url.username);
  } catch {
    fail(CODES.URL_INVALID, 'El usuario de DATABASE_URL está mal codificado.');
  }

  const params = {};
  for (const [key, value] of url.searchParams.entries()) {
    if (Object.prototype.hasOwnProperty.call(params, key)) {
      fail(CODES.PARAM_NOT_ALLOWED, `Parámetro repetido en DATABASE_URL: ${key}.`);
    }
    params[key] = value;
  }

  const parsed = { protocol: url.protocol, host, port, database, user, params };
  Object.defineProperty(parsed, 'connectionString', {
    value: url.href,
    enumerable: false,
  });
  Object.defineProperty(parsed, 'password', {
    value: decodeURIComponentSafe(url.password),
    enumerable: false,
  });
  return parsed;
}

function decodeURIComponentSafe(text) {
  try {
    return decodeURIComponent(text);
  } catch {
    return text;
  }
}

function assertParamsAllowed(params) {
  for (const [key, value] of Object.entries(params)) {
    const validator = ALLOWED_PARAMS[key];
    if (!validator || !validator(value)) {
      fail(
        CODES.PARAM_NOT_ALLOWED,
        `Parámetro de conexión no permitido en DATABASE_URL: ${key}.`,
      );
    }
  }
}

/**
 * Normaliza el host de E2E_DISPOSABLE_TARGET con el mismo parser (`new URL()`)
 * que se aplica a DATABASE_URL, para comparar ambos de forma coherente
 * (p. ej. `[0:0:0:0:0:0:0:1]` -> `::1`). Si no se puede normalizar, se
 * devuelve el texto en minúsculas, que no estará en LOCAL_HOSTS (fail-closed).
 */
function normalizeDisposableHost(rawHost) {
  try {
    return new URL(`postgresql://${rawHost}:5433`).hostname
      .replace(/^\[|\]$/g, '')
      .toLowerCase();
  } catch {
    return String(rawHost).toLowerCase();
  }
}

/**
 * Construye la política a partir de los valores de archivo.
 * @returns {{ canonical: {hosts:Set<string>, port:number, database:string, user:string},
 *             disposable: null | {host:string, port:number, database:string, tokenHash:string} }}
 */
function resolvePolicy(values) {
  const portText = values.TEST_POSTGRES_PORT ?? String(DEFAULT_TEST_PORT);
  if (!/^\d{1,5}$/.test(portText)) {
    fail(CODES.CONFIG_INVALID, 'TEST_POSTGRES_PORT no es un puerto numérico válido.');
  }
  const port = Number(portText);
  if (port < 1024 || port > 65535 || port === DEV_RESERVED_PORT) {
    fail(
      CODES.PORT_NOT_ALLOWED,
      `TEST_POSTGRES_PORT=${port} no es válido: el puerto ${DEV_RESERVED_PORT} ` +
        'está reservado a desarrollo y se exige un puerto entre 1024 y 65535.',
    );
  }
  if (isDefined(values.TEST_POSTGRES_DB) && values.TEST_POSTGRES_DB !== CANONICAL_DATABASE) {
    fail(
      CODES.CONFIG_INVALID,
      `TEST_POSTGRES_DB debe ser exactamente ${CANONICAL_DATABASE}.`,
    );
  }
  const user = values.TEST_POSTGRES_USER ?? DEFAULT_TEST_USER;
  if (!/^[A-Za-z0-9_]{1,63}$/.test(user) || RESERVED_USERS.has(user)) {
    fail(CODES.USER_NOT_ALLOWED, 'TEST_POSTGRES_USER no es un usuario TEST válido.');
  }

  const targetText = values.E2E_DISPOSABLE_TARGET;
  const tokenText = values.E2E_DISPOSABLE_TOKEN;
  let disposable = null;
  if (isDefined(targetText) !== isDefined(tokenText)) {
    fail(
      CODES.DISPOSABLE_INCOMPLETE,
      'E2E_DISPOSABLE_TARGET y E2E_DISPOSABLE_TOKEN deben definirse juntos.',
    );
  }
  if (isDefined(targetText)) {
    const match = DISPOSABLE_TARGET_RE.exec(targetText);
    if (!match) {
      fail(
        CODES.DISPOSABLE_INVALID,
        'E2E_DISPOSABLE_TARGET debe tener la forma exacta host:puerto/base.',
      );
    }
    const dHost = normalizeDisposableHost(match[1]);
    const dPort = Number(match[2]);
    const dDatabase = match[3];
    if (dPort < 1 || dPort > 65535) {
      fail(CODES.DISPOSABLE_INVALID, 'Puerto inválido en E2E_DISPOSABLE_TARGET.');
    }
    if (RESERVED_DATABASES.has(dDatabase) || !DISPOSABLE_NAME_RE.test(dDatabase)) {
      fail(
        CODES.DISPOSABLE_INVALID,
        'La base descartable debe llamarse pos_db_test_<sufijo> ' +
          '(minúsculas, dígitos o _) y no puede ser una base reservada.',
      );
    }
    // M1: una base descartable solo puede vivir en la propia máquina. Comparación
    // exacta sobre el host normalizado; LAN, dominios, IP públicas y alias
    // arbitrarios (aunque resuelvan a esta máquina) se rechazan.
    if (!LOCAL_HOSTS.has(dHost)) {
      fail(
        CODES.DISPOSABLE_INVALID,
        'El host de E2E_DISPOSABLE_TARGET debe ser exactamente localhost, ' +
          '127.0.0.1 o [::1]. Las bases descartables no pueden ser remotas.',
      );
    }
    if (dPort === DEV_RESERVED_PORT) {
      fail(
        CODES.DISPOSABLE_INVALID,
        `El puerto ${DEV_RESERVED_PORT} está reservado a desarrollo y no puede usarse en una base descartable.`,
      );
    }
    if (!TOKEN_RE.test(tokenText)) {
      fail(
        CODES.DISPOSABLE_INVALID,
        'E2E_DISPOSABLE_TOKEN debe ser hexadecimal en minúsculas (32 a 128 caracteres).',
      );
    }
    disposable = {
      host: dHost,
      port: dPort,
      database: dDatabase,
      tokenHash: sha256(tokenText),
    };
  }

  return {
    canonical: {
      hosts: LOCAL_HOSTS,
      port,
      database: CANONICAL_DATABASE,
      user,
    },
    disposable,
  };
}

/**
 * Evalúa estructuralmente una URL contra la política. Sin conexión.
 * @returns {{ kind:'CANONICAL'|'DISPOSABLE', host:string, port:number,
 *             database:string, user:string, fingerprint:string, label:string }}
 *          (con `connectionString`/`password` no enumerables)
 */
function evaluateTarget(rawUrl, policy) {
  const parsed = parseDatabaseUrl(rawUrl);
  assertParamsAllowed(parsed.params);

  if (RESERVED_USERS.has(parsed.user) || !parsed.user) {
    fail(CODES.USER_NOT_ALLOWED, 'El usuario de DATABASE_URL no está permitido para pruebas.');
  }

  let kind;
  if (policy.disposable) {
    const d = policy.disposable;
    if (
      parsed.host !== d.host ||
      parsed.port !== d.port ||
      parsed.database !== d.database
    ) {
      fail(
        CODES.DISPOSABLE_CONTRADICTORY,
        'DATABASE_URL no coincide exactamente con E2E_DISPOSABLE_TARGET ' +
          '(host, puerto y base). Revisa .env.test.local.',
      );
    }
    kind = 'DISPOSABLE';
  } else {
    const c = policy.canonical;
    if (!c.hosts.has(parsed.host)) {
      fail(
        CODES.HOST_NOT_ALLOWED,
        `Host no permitido para pruebas: ${parsed.host}. Solo localhost, ` +
          '127.0.0.1 o ::1 (otros destinos requieren una base descartable autorizada).',
      );
    }
    if (parsed.port !== c.port) {
      fail(
        CODES.PORT_NOT_ALLOWED,
        `Puerto no autorizado: ${parsed.port} (esperado ${c.port}).`,
      );
    }
    if (parsed.database !== c.database) {
      if (RESERVED_DATABASES.has(parsed.database)) {
        fail(CODES.DB_RESERVED_NAME, `Base reservada, no apta para pruebas: ${parsed.database}.`);
      }
      fail(
        CODES.DB_NAME_NOT_ALLOWED,
        `Base no autorizada: ${parsed.database} (se exige exactamente ${c.database}).`,
      );
    }
    if (parsed.user !== c.user) {
      fail(
        CODES.USER_NOT_ALLOWED,
        `Usuario no autorizado para el destino TEST (se exige ${c.user}).`,
      );
    }
    kind = 'CANONICAL';
  }

  const evaluated = {
    kind,
    host: parsed.host,
    port: parsed.port,
    database: parsed.database,
    user: parsed.user,
    fingerprint: sha256(
      [kind, parsed.host, parsed.port, parsed.database, parsed.user].join('|'),
    ),
    label: `${parsed.host}:${parsed.port}/${parsed.database}`,
  };
  Object.defineProperty(evaluated, 'connectionString', {
    value: parsed.connectionString,
    enumerable: false,
  });
  Object.defineProperty(evaluated, 'password', {
    value: parsed.password,
    enumerable: false,
  });
  return evaluated;
}

function collectSecrets(values, evaluated) {
  const secrets = [];
  if (evaluated && evaluated.password) secrets.push(evaluated.password);
  if (isDefined(values.E2E_DISPOSABLE_TOKEN)) secrets.push(values.E2E_DISPOSABLE_TOKEN);
  if (isDefined(values.DATABASE_URL)) secrets.push(values.DATABASE_URL);
  return secrets;
}

/**
 * Resolución completa SIN conexión: archivos -> política -> destino evaluado.
 * @returns {{ evaluated, policy, values, secrets }}
 */
function resolveTarget(options) {
  const { values } = loadGuardedEnv(options);
  const policy = resolvePolicy(values);
  const evaluated = evaluateTarget(values.DATABASE_URL, policy);
  return { evaluated, policy, values, secrets: collectSecrets(values, evaluated) };
}

// ---------------------------------------------------------------------------
// 3. Identidad real (solo lectura)
// ---------------------------------------------------------------------------

const IDENTITY_SQL =
  'SELECT current_database()::text AS db, current_user::text AS usr, ' +
  "COALESCE(inet_server_port()::text, '') AS port, " +
  "COALESCE((SELECT shobj_description(d.oid, 'pg_database') FROM pg_database d " +
  "WHERE d.datname = current_database()), '') AS marker";
const SYSID_SQL = 'SELECT system_identifier::text AS sysid FROM pg_control_system()';
const USER_RELATIONS_SQL =
  'SELECT count(*)::text AS n FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace ' +
  "WHERE c.relkind IN ('r','p','v','m','f','S') " +
  "AND n.nspname NOT IN ('pg_catalog','information_schema') AND n.nspname NOT LIKE 'pg_toast%'";

/**
 * Ejecutor por defecto: abre un PrismaClient atado a `connectionString`,
 * ejecuta cada sentencia de forma independiente y se desconecta.
 * `statements`: [{ sql, write?: boolean }] -> [{ ok, rows?, error? }]
 */
function createPrismaRunner() {
  return async function runStatements(connectionString, statements, opts = {}) {
    const timeoutMs = opts.timeoutMs ?? IDENTITY_TIMEOUT_MS;
    let PrismaClient;
    let client;
    // Prisma carga el .env de DESARROLLO (cwd) en process.env al construir el
    // cliente. Se restaura el entorno para que esos valores (DATABASE_URL de
    // pos_db, secretos, etc.) nunca contaminen ni la guardia ni el proceso hijo.
    const envBefore = new Set(Object.keys(process.env));
    const restoreEnv = () => {
      for (const key of Object.keys(process.env)) {
        if (!envBefore.has(key)) delete process.env[key];
      }
    };
    try {
      ({ PrismaClient } = require('@prisma/client'));
      client = new PrismaClient({ datasourceUrl: connectionString, log: [] });
      restoreEnv();
    } catch {
      restoreEnv();
      fail(
        CODES.PRISMA_CLIENT_UNAVAILABLE,
        'El cliente Prisma no está disponible o no está generado, por lo que ' +
          'no se puede verificar la identidad de la base. Ejecuta ' +
          '"npm run prisma:generate" (no accede a ninguna base) y reintenta.',
      );
    }

    let timer;
    const work = (async () => {
      const results = [];
      for (const statement of statements) {
        try {
          if (statement.write) {
            await client.$executeRawUnsafe(statement.sql);
            results.push({ ok: true, rows: [] });
          } else {
            const rows = await client.$queryRawUnsafe(statement.sql);
            results.push({ ok: true, rows });
          }
        } catch (error) {
          results.push({
            ok: false,
            error: redact(error && error.message ? error.message.split('\n').pop() : error),
          });
          if (statement.required) break;
        }
      }
      return results;
    })();
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new TestDatabaseGuardError(CODES.TIMEOUT, `La verificación de identidad superó ${timeoutMs} ms.`)),
        timeoutMs,
      );
    });
    try {
      return await Promise.race([work, timeout]);
    } finally {
      clearTimeout(timer);
      await Promise.race([
        client.$disconnect().catch(() => undefined),
        new Promise((resolve) => setTimeout(resolve, 2000).unref()),
      ]);
      restoreEnv();
    }
  };
}

function buildMarkerValue(tokenHash, systemIdentifier) {
  return `${MARKER_PREFIX}${tokenHash}${systemIdentifier ? `:${systemIdentifier}` : ''}`;
}

function parseMarker(text) {
  if (typeof text !== 'string' || !text.startsWith(MARKER_PREFIX)) return null;
  const [tokenHash, systemIdentifier] = text.slice(MARKER_PREFIX.length).split(':');
  if (!/^[0-9a-f]{64}$/.test(tokenHash ?? '')) return null;
  if (systemIdentifier !== undefined && !/^\d{1,30}$/.test(systemIdentifier)) return null;
  return { tokenHash, systemIdentifier: systemIdentifier ?? null };
}

async function readIdentity(evaluated, secrets, runStatements, timeoutMs) {
  let results;
  try {
    results = await runStatements(
      evaluated.connectionString,
      [{ sql: IDENTITY_SQL, required: true }, { sql: SYSID_SQL }],
      { timeoutMs },
    );
  } catch (error) {
    if (error instanceof TestDatabaseGuardError) throw error;
    fail(
      CODES.IDENTITY_UNVERIFIABLE,
      `No se pudo verificar la identidad de la base (${redact(error && error.message, secrets)}).`,
    );
  }
  const first = results[0];
  if (!first || !first.ok || !Array.isArray(first.rows) || first.rows.length !== 1) {
    fail(
      CODES.IDENTITY_UNVERIFIABLE,
      `No se pudo verificar la identidad de la base en ${evaluated.label}` +
        `${first && first.error ? ` (${redact(first.error, secrets)})` : ''}.`,
    );
  }
  const row = first.rows[0];
  const sysRow = results[1] && results[1].ok && results[1].rows[0];
  return {
    database: String(row.db),
    sessionUser: String(row.usr),
    serverPort: row.port === '' ? null : Number(row.port),
    marker: String(row.marker ?? ''),
    systemIdentifier: sysRow && sysRow.sysid ? String(sysRow.sysid) : null,
  };
}

/**
 * Verificación de identidad previa a cualquier escritura (solo lectura).
 * - current_database() debe ser EXACTAMENTE la base evaluada.
 * - El usuario de sesión debe coincidir con el de la URL.
 * - DISPOSABLE: el marcador debe existir y corresponder al token autorizado
 *   (y, si está atado a un clúster, al system_identifier vivo).
 * `serverPort` se informa pero NUNCA se compara con la URL (dentro de Docker
 * es el puerto interno, no el publicado).
 */
async function verifyServerIdentity(evaluated, policy, options = {}) {
  const {
    runStatements = createPrismaRunner(),
    timeoutMs = IDENTITY_TIMEOUT_MS,
    secrets = [],
  } = options;
  const identity = await readIdentity(evaluated, secrets, runStatements, timeoutMs);

  if (identity.database !== evaluated.database) {
    fail(
      CODES.IDENTITY_MISMATCH,
      `La conexión terminó en la base "${identity.database}", no en la esperada ` +
        `"${evaluated.database}". Operación abortada.`,
    );
  }
  if (identity.sessionUser !== evaluated.user) {
    fail(
      CODES.IDENTITY_MISMATCH,
      `El usuario de sesión (${identity.sessionUser}) no coincide con el de la URL.`,
    );
  }

  if (evaluated.kind === 'DISPOSABLE') {
    const expected = policy.disposable.tokenHash;
    if (!identity.marker) {
      fail(
        CODES.MARKER_MISSING,
        'La base descartable no tiene marcador. Créalo con ' +
          '"npm run db:test:mark-disposable" (solo sobre una base vacía).',
      );
    }
    const marker = parseMarker(identity.marker);
    if (!marker || marker.tokenHash !== expected) {
      fail(
        CODES.MARKER_MISMATCH,
        'El marcador de la base descartable no corresponde al token autorizado.',
      );
    }
    if (marker.systemIdentifier !== null) {
      if (identity.systemIdentifier === null) {
        fail(
          CODES.IDENTITY_UNVERIFIABLE,
          'El marcador está atado a un clúster pero no se pudo leer el identificador del servidor.',
        );
      }
      if (marker.systemIdentifier !== identity.systemIdentifier) {
        fail(
          CODES.MARKER_MISMATCH,
          'El marcador pertenece a otro servidor PostgreSQL (identificador de clúster distinto).',
        );
      }
    }
  }
  return identity;
}

/**
 * Resolución completa + identidad real. Lanza TestDatabaseGuardError si algo falla.
 */
async function assertTestDatabaseReady(options) {
  const resolved = resolveTarget(options);
  const identity = await verifyServerIdentity(resolved.evaluated, resolved.policy, {
    runStatements: options.runStatements,
    timeoutMs: options.timeoutMs,
    secrets: resolved.secrets,
  });
  return { ...resolved, identity };
}

/**
 * Crea el marcador de una base descartable. Rechaza bases con objetos de
 * usuario salvo que ya tengan un marcador válido para el MISMO token.
 * Es la única operación de escritura de este módulo (COMMENT ON DATABASE).
 */
async function markDisposable(options) {
  const resolved = resolveTarget(options);
  const { evaluated, policy, secrets } = resolved;
  if (evaluated.kind !== 'DISPOSABLE') {
    fail(
      CODES.DISPOSABLE_INVALID,
      'Solo se pueden marcar bases descartables autorizadas en .env.test.local.',
    );
  }
  const runStatements = options.runStatements ?? createPrismaRunner();
  const timeoutMs = options.timeoutMs ?? IDENTITY_TIMEOUT_MS;

  const first = await runStatements(
    evaluated.connectionString,
    [
      { sql: IDENTITY_SQL, required: true },
      { sql: SYSID_SQL },
      { sql: USER_RELATIONS_SQL, required: true },
    ],
    { timeoutMs },
  );
  const idRow = first[0] && first[0].ok && first[0].rows[0];
  if (!idRow) {
    fail(CODES.IDENTITY_UNVERIFIABLE, `No se pudo verificar la identidad de la base en ${evaluated.label}.`);
  }
  if (String(idRow.db) !== evaluated.database || String(idRow.usr) !== evaluated.user) {
    fail(
      CODES.IDENTITY_MISMATCH,
      `La conexión terminó en "${idRow.db}" (usuario ${idRow.usr}); no coincide con lo autorizado.`,
    );
  }
  const relations = first[2] && first[2].ok ? Number(first[2].rows[0].n) : NaN;
  if (!Number.isFinite(relations)) {
    fail(CODES.IDENTITY_UNVERIFIABLE, 'No se pudo comprobar si la base está vacía.');
  }
  const sysid = first[1] && first[1].ok && first[1].rows[0] ? String(first[1].rows[0].sysid) : null;
  const existing = parseMarker(String(idRow.marker ?? ''));

  if (existing && existing.tokenHash === policy.disposable.tokenHash) {
    if (existing.systemIdentifier !== null && existing.systemIdentifier !== sysid) {
      fail(CODES.MARKER_MISMATCH, 'La base ya tiene un marcador atado a otro servidor.');
    }
    return { evaluated, created: false, boundToCluster: existing.systemIdentifier !== null };
  }
  if (relations > 0) {
    fail(
      CODES.MARKER_NOT_EMPTY,
      'La base tiene tablas u otros objetos y no tiene un marcador válido para este token: ' +
        'no se marca (solo se marcan bases vacías).',
    );
  }
  const value = buildMarkerValue(policy.disposable.tokenHash, sysid);
  // Identificador y literal construidos solo con caracteres validados (regex).
  const sql = `COMMENT ON DATABASE "${evaluated.database}" IS '${value}'`;
  const written = await runStatements(
    evaluated.connectionString,
    [{ sql, write: true, required: true }],
    { timeoutMs },
  );
  if (!written[0] || !written[0].ok) {
    fail(
      CODES.IDENTITY_UNVERIFIABLE,
      `No se pudo escribir el marcador (${redact(written[0] && written[0].error, secrets)}).`,
    );
  }
  return { evaluated, created: true, boundToCluster: sysid !== null };
}

// ---------------------------------------------------------------------------
// 4. Huella verificada y carga del entorno en el proceso
// ---------------------------------------------------------------------------

/** Huella emitida por el proceso que verificó la identidad (globalSetup). */
function issueVerifiedFingerprint(evaluated, pid = process.pid) {
  return `v1:${evaluated.fingerprint}:${pid}`;
}

/**
 * Comprueba que la huella proviene del proceso actual (o de su padre, cuando
 * Jest usa workers) y corresponde al destino evaluado ahora mismo. Una huella
 * heredada de otro shell/sesión no cumple el PID y se rechaza.
 */
function assertVerifiedFingerprint(evaluated, value, pids = {}) {
  const pid = pids.pid ?? process.pid;
  const ppid = pids.ppid ?? process.ppid;
  const match = /^v1:([0-9a-f]{64}):(\d+)$/.exec(value ?? '');
  if (!match || match[1] !== evaluated.fingerprint) {
    fail(
      CODES.FINGERPRINT_INVALID,
      'El destino no fue verificado por esta ejecución (falta o no coincide la huella). ' +
        'Ejecuta las pruebas con "npm run test:e2e" (usa globalSetup).',
    );
  }
  const issuer = Number(match[2]);
  if (issuer !== pid && issuer !== ppid) {
    fail(
      CODES.FINGERPRINT_INVALID,
      'La huella de verificación no pertenece a esta ejecución (posible valor heredado).',
    );
  }
}

/**
 * Exporta al entorno del proceso las variables de archivo que NO estén ya
 * definidas (mismo comportamiento previo que dotenv sin override) y fija
 * DATABASE_URL al valor validado. Nunca exporta claves de autorización.
 */
function applyEnvToProcess(values, evaluated, targetEnv = process.env) {
  for (const [key, value] of Object.entries(values)) {
    if (NEVER_EXPORT_KEYS.includes(key)) continue;
    if (!isDefined(targetEnv[key])) targetEnv[key] = value;
  }
  targetEnv.DATABASE_URL = evaluated.connectionString;
}

/**
 * Opciones de línea de comandos compartidas por los scripts TEST:
 *   --env-file <ruta>        (por defecto .env.test en cwd)
 *   --local-env-file <ruta>  (por defecto .env.test.local en cwd)
 * Devuelve las opciones y el resto de argumentos (el comando a ejecutar).
 * Las rutas las decide quien invoca el script, nunca una variable de entorno.
 */
function parseGuardCliArgs(argv, cwd = process.cwd()) {
  let baseFile = path.resolve(cwd, DEFAULT_BASE_ENV_FILE);
  let localFile = path.resolve(cwd, DEFAULT_LOCAL_ENV_FILE);
  const rest = [...argv];
  while (rest.length > 0 && rest[0].startsWith('--')) {
    const flag = rest.shift();
    const value = rest.shift();
    if (!value) fail(CODES.CLI_USAGE, `Falta el valor de ${flag}.`);
    if (flag === '--env-file') baseFile = path.resolve(cwd, value);
    else if (flag === '--local-env-file') localFile = path.resolve(cwd, value);
    else fail(CODES.CLI_USAGE, `Opción desconocida: ${flag}.`);
  }
  return { baseFile, localFile, rest };
}

module.exports = {
  parseGuardCliArgs,
  CODES,
  TestDatabaseGuardError,
  CANONICAL_DATABASE,
  DEFAULT_TEST_PORT,
  DEFAULT_BASE_ENV_FILE,
  DEFAULT_LOCAL_ENV_FILE,
  IDENTITY_TIMEOUT_MS,
  DISPOSABLE_KEYS,
  CONFLICT_KEYS,
  NEVER_EXPORT_KEYS,
  redact,
  loadGuardedEnv,
  parseDatabaseUrl,
  resolvePolicy,
  evaluateTarget,
  resolveTarget,
  createPrismaRunner,
  buildMarkerValue,
  parseMarker,
  verifyServerIdentity,
  assertTestDatabaseReady,
  markDisposable,
  issueVerifiedFingerprint,
  assertVerifiedFingerprint,
  applyEnvToProcess,
};
