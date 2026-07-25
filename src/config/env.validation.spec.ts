import { NodeEnv, validateEnv } from './env.validation';

const baseEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://pos_user:pos_password@localhost:5432/pos_db',
  CORS_ORIGIN: 'http://localhost:4201',
  SWAGGER_ENABLED: 'true',
};

describe('validateEnv', () => {
  it('normaliza los tipos de las variables válidas', () => {
    const config = validateEnv({ ...baseEnv });

    expect(config.NODE_ENV).toBe(NodeEnv.Development);
    expect(config.PORT).toBe(3000);
    expect(config.SWAGGER_ENABLED).toBe(true);
  });

  // Regresión: Boolean('false') devuelve true y habilitaría Swagger por error.
  it.each([
    ['true', true],
    ['false', false],
  ])('interpreta SWAGGER_ENABLED="%s" como %s', (raw, expected) => {
    const config = validateEnv({ ...baseEnv, SWAGGER_ENABLED: raw });

    expect(config.SWAGGER_ENABLED).toBe(expected);
  });

  it('aplica los valores por defecto cuando faltan variables opcionales', () => {
    const config = validateEnv({ DATABASE_URL: baseEnv.DATABASE_URL });

    expect(config.NODE_ENV).toBe(NodeEnv.Development);
    expect(config.PORT).toBe(3000);
    expect(config.CORS_ORIGIN).toBe('http://localhost:4201');
    expect(config.SWAGGER_ENABLED).toBe(true);
  });

  it('falla si DATABASE_URL no está definida', () => {
    expect(() => validateEnv({ ...baseEnv, DATABASE_URL: undefined })).toThrow(
      /DATABASE_URL/,
    );
  });

  it('falla si DATABASE_URL no es una cadena de conexión PostgreSQL', () => {
    expect(() =>
      validateEnv({ ...baseEnv, DATABASE_URL: 'mysql://localhost:3306/pos' }),
    ).toThrow(/DATABASE_URL/);
  });

  it('falla si PORT no es un entero válido', () => {
    expect(() => validateEnv({ ...baseEnv, PORT: 'abc' })).toThrow(/PORT/);
  });

  it('falla si NODE_ENV no es un valor permitido', () => {
    expect(() => validateEnv({ ...baseEnv, NODE_ENV: 'staging' })).toThrow(
      /NODE_ENV/,
    );
  });
});
