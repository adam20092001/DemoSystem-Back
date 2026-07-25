import {
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  assertPasswordPolicy,
  checkPasswordPolicy,
} from './password-policy';

describe('checkPasswordPolicy', () => {
  it('acepta una contraseña válida', () => {
    const result = checkPasswordPolicy('Temporal1234');

    expect(result.valid).toBe(true);
    expect(result.violations).toEqual([]);
  });

  it('rechaza una contraseña con menos de 12 caracteres', () => {
    const result = checkPasswordPolicy('Corta1');

    expect(result.valid).toBe(false);
    expect(result.violations).toContain(
      `mínimo ${PASSWORD_MIN_LENGTH} caracteres`,
    );
  });

  it('rechaza una contraseña con más de 128 caracteres', () => {
    const tooLong = `Aa1${'x'.repeat(130)}`;
    const result = checkPasswordPolicy(tooLong);

    expect(result.valid).toBe(false);
    expect(result.violations).toContain(
      `máximo ${PASSWORD_MAX_LENGTH} caracteres`,
    );
  });

  it('rechaza una contraseña sin letras', () => {
    const result = checkPasswordPolicy('123456789012');

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('al menos una letra');
  });

  it('rechaza una contraseña sin números', () => {
    const result = checkPasswordPolicy('SoloLetrasAqui');

    expect(result.valid).toBe(false);
    expect(result.violations).toContain('al menos un número');
  });

  it('acumula todas las violaciones aplicables', () => {
    const result = checkPasswordPolicy('corta');

    expect(result.violations).toEqual([
      `mínimo ${PASSWORD_MIN_LENGTH} caracteres`,
      'al menos un número',
    ]);
  });
});

describe('assertPasswordPolicy', () => {
  it('no lanza con una contraseña válida', () => {
    expect(() => assertPasswordPolicy('Temporal1234')).not.toThrow();
  });

  it('lanza con el mensaje por defecto si no se provee formatMessage', () => {
    expect(() => assertPasswordPolicy('corta')).toThrow(
      /La contraseña no cumple la política/,
    );
  });

  it('usa formatMessage para dar contexto propio a cada llamador', () => {
    expect(() =>
      assertPasswordPolicy(
        'corta',
        (violations) =>
          `INITIAL_ADMIN_PASSWORD inválida: ${violations.join(', ')}.`,
      ),
    ).toThrow(/INITIAL_ADMIN_PASSWORD inválida/);
  });
});
