/**
 * Constantes compartidas entre archivos e2e. Cada valor sensible proviene de
 * .env.test (cargado por jest-e2e.setup.ts antes de que estos módulos se
 * evalúen), nunca hardcodeado por duplicado.
 */
export const E2E_ADMIN_USERNAME =
  process.env.INITIAL_ADMIN_USERNAME ?? 'e2e_admin';
export const E2E_ADMIN_EMAIL =
  process.env.INITIAL_ADMIN_EMAIL ?? 'e2e_admin@demosystem.test';
export const E2E_ADMIN_SEED_PASSWORD =
  process.env.INITIAL_ADMIN_PASSWORD ?? 'E2eAdminTest2026';

/** Contraseña a la que el admin de prueba transiciona tras completar el cambio obligatorio. */
export const E2E_ADMIN_ACTIVE_PASSWORD = 'E2eAdminActive2026Aa';

export const FORBIDDEN_AUDIT_SUBSTRINGS = [
  'password',
  'passwordhash',
  'temporarypassword',
  'token',
  'jwt',
  'cookie',
  'authorization',
  'secret',
];
