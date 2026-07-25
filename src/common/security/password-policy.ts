/**
 * Política de contraseñas compartida entre prisma/seed.ts y los servicios de
 * la aplicación (UsersService). Función pura, sin dependencia de NestJS, para
 * que el seed —que corre fuera del contenedor de Nest— pueda reutilizarla.
 */
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;

const LETTER_PATTERN = /[a-zA-Z]/;
const DIGIT_PATTERN = /[0-9]/;

export interface PasswordPolicyResult {
  valid: boolean;
  /** Vacío cuando valid es true. Cada entrada es un requisito incumplido. */
  violations: string[];
}

/** Evalúa la contraseña contra la política vigente. Nunca lanza. */
export function checkPasswordPolicy(password: string): PasswordPolicyResult {
  const violations: string[] = [];

  if (password.length < PASSWORD_MIN_LENGTH) {
    violations.push(`mínimo ${PASSWORD_MIN_LENGTH} caracteres`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    violations.push(`máximo ${PASSWORD_MAX_LENGTH} caracteres`);
  }
  if (!LETTER_PATTERN.test(password)) {
    violations.push('al menos una letra');
  }
  if (!DIGIT_PATTERN.test(password)) {
    violations.push('al menos un número');
  }

  return { valid: violations.length === 0, violations };
}

/**
 * Lanza un Error con las violaciones encontradas. `formatMessage` permite a
 * cada llamador dar contexto propio (p. ej. el seed menciona la variable de
 * entorno concreta) sin duplicar la lógica de validación.
 */
export function assertPasswordPolicy(
  password: string,
  formatMessage?: (violations: string[]) => string,
): void {
  const result = checkPasswordPolicy(password);
  if (!result.valid) {
    const message = formatMessage
      ? formatMessage(result.violations)
      : `La contraseña no cumple la política: ${result.violations.join(', ')}.`;
    throw new Error(message);
  }
}
