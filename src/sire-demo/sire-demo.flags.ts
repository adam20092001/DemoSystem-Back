/**
 * Flags de seguridad del módulo SIRE DEMO (Plan V2 + Addendum §1).
 *
 * Este archivo es deliberadamente PURO (sin Nest, sin Prisma): lo consumen
 * tanto `validateEnv` (arranque) como el registro condicional del módulo.
 *
 * Matriz de arranque (todo apagado por defecto):
 *  - ENABLED=false                         -> módulo ausente (404).
 *  - FIXTURES=true sin ENABLED=true        -> error de arranque.
 *  - production + ENABLED=true sin ALLOW   -> error de arranque.
 *  - production + ENABLED=true + ALLOW     -> activo, con aviso en el log.
 */
export interface SireDemoFlags {
  /** Interruptor maestro: sin él el módulo entero no existe. */
  enabled: boolean;
  /** Habilita el origen DEMO_FIXTURES. Requiere `enabled`. */
  fixturesEnabled: boolean;
  /** Autorización explícita para usar el módulo con NODE_ENV=production. */
  allowInProduction: boolean;
  /** NODE_ENV === 'production'. */
  production: boolean;
}

export class SireDemoConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SireDemoConfigError';
  }
}

/** Estado fail-closed: nada habilitado. */
export const DISABLED_SIRE_DEMO_FLAGS: SireDemoFlags = Object.freeze({
  enabled: false,
  fixturesEnabled: false,
  allowInProduction: false,
  production: false,
});

/**
 * Solo acepta los literales true/false (booleano real o string). Cualquier
 * otro valor ("yes", "1", "TRUE") falla el arranque en lugar de
 * interpretarse en silencio como apagado: un flag de seguridad ambiguo no
 * debe tener un significado implícito.
 */
function parseStrictBool(name: string, value: unknown): boolean {
  if (value === undefined || value === null || value === '') {
    return false;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  throw new SireDemoConfigError(`${name} debe ser true o false`);
}

/** Resuelve y valida los flags. Lanza SireDemoConfigError ante una combinación prohibida. */
export function resolveSireDemoFlags(
  env: Readonly<Record<string, unknown>>,
): SireDemoFlags {
  const enabled = parseStrictBool('SIRE_DEMO_ENABLED', env.SIRE_DEMO_ENABLED);
  const fixturesEnabled = parseStrictBool(
    'SIRE_DEMO_FIXTURES_ENABLED',
    env.SIRE_DEMO_FIXTURES_ENABLED,
  );
  const allowInProduction = parseStrictBool(
    'SIRE_DEMO_ALLOW_IN_PRODUCTION',
    env.SIRE_DEMO_ALLOW_IN_PRODUCTION,
  );
  const nodeEnv =
    typeof env.NODE_ENV === 'string' && env.NODE_ENV !== ''
      ? env.NODE_ENV
      : 'development';
  const production = nodeEnv === 'production';

  if (fixturesEnabled && !enabled) {
    throw new SireDemoConfigError(
      'SIRE_DEMO_FIXTURES_ENABLED=true requiere SIRE_DEMO_ENABLED=true (los fixtures no existen sin el módulo).',
    );
  }
  if (production && enabled && !allowInProduction) {
    throw new SireDemoConfigError(
      'SIRE_DEMO_ENABLED=true con NODE_ENV=production requiere SIRE_DEMO_ALLOW_IN_PRODUCTION=true (autorización explícita). Por defecto el módulo SIRE DEMO está bloqueado en producción.',
    );
  }

  return { enabled, fixturesEnabled, allowInProduction, production };
}

/**
 * Variante para el REGISTRO del módulo: cualquier error o ambigüedad deja el
 * módulo apagado (fail-closed). El error real no se pierde: `validateEnv`
 * ejecuta la misma validación y hace fallar el arranque con el mensaje exacto.
 */
export function resolveSireDemoFlagsFailClosed(
  env: Readonly<Record<string, unknown>>,
): SireDemoFlags {
  try {
    return resolveSireDemoFlags(env);
  } catch {
    return DISABLED_SIRE_DEMO_FLAGS;
  }
}
