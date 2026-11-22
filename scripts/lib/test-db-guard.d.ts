/** Declaraciones de scripts/lib/test-db-guard.js (módulo CommonJS compartido). */

export type GuardCode =
  | 'ENV_FILE_MISSING'
  | 'ENV_CONFLICT'
  | 'NODE_ENV'
  | 'CONFIG_INVALID'
  | 'URL_MISSING'
  | 'URL_INVALID'
  | 'PROTOCOL'
  | 'HOST_NOT_ALLOWED'
  | 'PORT_NOT_ALLOWED'
  | 'DB_NAME_NOT_ALLOWED'
  | 'DB_RESERVED_NAME'
  | 'USER_NOT_ALLOWED'
  | 'PARAM_NOT_ALLOWED'
  | 'DISPOSABLE_SOURCE_INVALID'
  | 'DISPOSABLE_INCOMPLETE'
  | 'DISPOSABLE_INVALID'
  | 'DISPOSABLE_CONTRADICTORY'
  | 'PRISMA_CLIENT_UNAVAILABLE'
  | 'IDENTITY_UNVERIFIABLE'
  | 'IDENTITY_MISMATCH'
  | 'MARKER_MISSING'
  | 'MARKER_MISMATCH'
  | 'MARKER_NOT_EMPTY'
  | 'TIMEOUT'
  | 'FINGERPRINT_INVALID'
  | 'RESET_NOT_ALLOWED'
  | 'COMPOSE_MISMATCH'
  | 'DOCKER_NOT_LOCAL'
  | 'RESOURCE_UNVERIFIED'
  | 'CLI_USAGE';

export const CODES: Readonly<Record<GuardCode, GuardCode>>;

export class TestDatabaseGuardError extends Error {
  readonly code: GuardCode;
  constructor(code: GuardCode, message: string);
}

export type EnvMap = Record<string, string | undefined>;

export interface LoadEnvOptions {
  baseFile: string;
  localFile?: string;
  inheritedEnv?: EnvMap;
  readFile?: (file: string) => string | null;
}

export interface Policy {
  canonical: {
    hosts: ReadonlySet<string>;
    port: number;
    database: string;
    user: string;
  };
  disposable: null | {
    host: string;
    port: number;
    database: string;
    tokenHash: string;
  };
}

/** `connectionString` y `password` son propiedades NO enumerables (contienen credenciales). */
export interface EvaluatedTarget {
  kind: 'CANONICAL' | 'DISPOSABLE';
  host: string;
  port: number;
  database: string;
  user: string;
  fingerprint: string;
  label: string;
  readonly connectionString: string;
  readonly password: string;
}

export interface StatementSpec {
  sql: string;
  write?: boolean;
  required?: boolean;
}
export interface StatementResult {
  ok: boolean;
  rows?: Array<Record<string, unknown>>;
  error?: string;
}
export type StatementRunner = (
  connectionString: string,
  statements: StatementSpec[],
  options?: { timeoutMs?: number },
) => Promise<StatementResult[]>;

export interface ResolveOptions extends LoadEnvOptions {
  runStatements?: StatementRunner;
  timeoutMs?: number;
}

export interface ResolvedTarget {
  evaluated: EvaluatedTarget;
  policy: Policy;
  values: Record<string, string>;
  secrets: string[];
}

export interface ServerIdentity {
  database: string;
  sessionUser: string;
  serverPort: number | null;
  marker: string;
  systemIdentifier: string | null;
}

export const CANONICAL_DATABASE: string;
export const DEFAULT_TEST_PORT: number;
export const DEFAULT_BASE_ENV_FILE: string;
export const DEFAULT_LOCAL_ENV_FILE: string;
export const IDENTITY_TIMEOUT_MS: number;
export const DISPOSABLE_KEYS: string[];
export const CONFLICT_KEYS: string[];
export const NEVER_EXPORT_KEYS: string[];

export function redact(text: unknown, secrets?: string[]): string;
export function loadGuardedEnv(options: LoadEnvOptions): {
  values: Record<string, string>;
  local: Record<string, string>;
};
export function parseDatabaseUrl(raw: string | undefined): {
  protocol: string;
  host: string;
  port: number;
  database: string;
  user: string;
  params: Record<string, string>;
  readonly connectionString: string;
  readonly password: string;
};
export function resolvePolicy(values: Record<string, string | undefined>): Policy;
export function evaluateTarget(rawUrl: string | undefined, policy: Policy): EvaluatedTarget;
export function resolveTarget(options: LoadEnvOptions): ResolvedTarget;
export function createPrismaRunner(): StatementRunner;
export function buildMarkerValue(tokenHash: string, systemIdentifier?: string | null): string;
export function parseMarker(
  text: string,
): { tokenHash: string; systemIdentifier: string | null } | null;
export function verifyServerIdentity(
  evaluated: EvaluatedTarget,
  policy: Policy,
  options?: { runStatements?: StatementRunner; timeoutMs?: number; secrets?: string[] },
): Promise<ServerIdentity>;
export function assertTestDatabaseReady(
  options: ResolveOptions,
): Promise<ResolvedTarget & { identity: ServerIdentity }>;
export function markDisposable(
  options: ResolveOptions,
): Promise<{ evaluated: EvaluatedTarget; created: boolean; boundToCluster: boolean }>;
export function issueVerifiedFingerprint(evaluated: EvaluatedTarget, pid?: number): string;
export function assertVerifiedFingerprint(
  evaluated: EvaluatedTarget,
  value: string | undefined,
  pids?: { pid?: number; ppid?: number },
): void;
export function applyEnvToProcess(
  values: Record<string, string>,
  evaluated: EvaluatedTarget,
  targetEnv?: EnvMap,
): void;
export function parseGuardCliArgs(
  argv: string[],
  cwd?: string,
): { baseFile: string; localFile: string; rest: string[] };
