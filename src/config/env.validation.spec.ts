import { CookieSameSite, NodeEnv, validateEnv } from './env.validation';

// Secreto de prueba: 64 caracteres hex, no es un secreto real de ningún entorno.
const VALID_JWT_SECRET =
  'a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4a1b2c3d4e5f6a1b2c3d4e5f6a1b2c3d4';

const baseEnv = {
  NODE_ENV: 'development',
  PORT: '3000',
  DATABASE_URL: 'postgresql://pos_user:pos_password@localhost:5432/pos_db',
  CORS_ORIGIN: 'http://localhost:4201',
  SWAGGER_ENABLED: 'true',
  JWT_SECRET: VALID_JWT_SECRET,
  JWT_EXPIRES_IN: '8h',
  AUTH_COOKIE_NAME: 'demosystem_session',
  AUTH_COOKIE_SAMESITE: 'lax',
  MAX_LOGIN_ATTEMPTS: '5',
  LOGIN_THROTTLE_TTL_MS: '60000',
  LOGIN_THROTTLE_LIMIT: '10',
  PRODUCT_UPLOAD_DIR: 'uploads/products',
  PRODUCT_IMAGE_MAX_SIZE_BYTES: '5242880',
};

describe('validateEnv', () => {
  it('normaliza los tipos de las variables válidas', () => {
    const config = validateEnv({ ...baseEnv });

    expect(config.NODE_ENV).toBe(NodeEnv.Development);
    expect(config.PORT).toBe(3000);
    expect(config.SWAGGER_ENABLED).toBe(true);
    expect(config.JWT_SECRET).toBe(VALID_JWT_SECRET);
    expect(config.MAX_LOGIN_ATTEMPTS).toBe(5);
    expect(config.LOGIN_THROTTLE_TTL_MS).toBe(60000);
    expect(config.LOGIN_THROTTLE_LIMIT).toBe(10);
    expect(config.PRODUCT_UPLOAD_DIR).toBe('uploads/products');
    expect(config.PRODUCT_IMAGE_MAX_SIZE_BYTES).toBe(5242880);
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
    const config = validateEnv({
      DATABASE_URL: baseEnv.DATABASE_URL,
      JWT_SECRET: VALID_JWT_SECRET,
    });

    expect(config.NODE_ENV).toBe(NodeEnv.Development);
    expect(config.PORT).toBe(3000);
    expect(config.CORS_ORIGIN).toBe('http://localhost:4201');
    expect(config.SWAGGER_ENABLED).toBe(true);
    expect(config.JWT_EXPIRES_IN).toBe('8h');
    expect(config.AUTH_COOKIE_NAME).toBe('demosystem_session');
    expect(config.AUTH_COOKIE_SAMESITE).toBe(CookieSameSite.Lax);
    expect(config.MAX_LOGIN_ATTEMPTS).toBe(5);
    expect(config.LOGIN_THROTTLE_TTL_MS).toBe(60000);
    expect(config.LOGIN_THROTTLE_LIMIT).toBe(10);
    expect(config.PRODUCT_UPLOAD_DIR).toBe('uploads/products');
    expect(config.PRODUCT_IMAGE_MAX_SIZE_BYTES).toBe(5242880);
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

  describe('JWT_SECRET', () => {
    it('falla si JWT_SECRET no está definida', () => {
      expect(() => validateEnv({ ...baseEnv, JWT_SECRET: undefined })).toThrow(
        /JWT_SECRET/,
      );
    });

    it('falla si JWT_SECRET tiene menos de 32 caracteres', () => {
      expect(() =>
        validateEnv({ ...baseEnv, JWT_SECRET: 'demasiado-corto' }),
      ).toThrow(/JWT_SECRET/);
    });

    it('acepta JWT_SECRET de exactamente 32 caracteres', () => {
      const secret = 'a'.repeat(32);
      const config = validateEnv({ ...baseEnv, JWT_SECRET: secret });

      expect(config.JWT_SECRET).toBe(secret);
    });

    it('no tiene un valor por defecto', () => {
      expect(() =>
        validateEnv({
          DATABASE_URL: baseEnv.DATABASE_URL,
        }),
      ).toThrow(/JWT_SECRET/);
    });
  });

  describe('JWT_EXPIRES_IN', () => {
    it.each(['30m', '8h', '1d'])('acepta el formato válido "%s"', (value) => {
      const config = validateEnv({ ...baseEnv, JWT_EXPIRES_IN: value });

      expect(config.JWT_EXPIRES_IN).toBe(value);
    });

    it.each(['8', '30x', 'abc', '1w', ''])(
      'rechaza el formato inválido "%s"',
      (value) => {
        expect(() =>
          validateEnv({ ...baseEnv, JWT_EXPIRES_IN: value }),
        ).toThrow(/JWT_EXPIRES_IN/);
      },
    );

    it('usa 8h como valor por defecto', () => {
      const config = validateEnv({
        ...baseEnv,
        JWT_EXPIRES_IN: undefined,
      });

      expect(config.JWT_EXPIRES_IN).toBe('8h');
    });
  });

  describe('AUTH_COOKIE_SAMESITE', () => {
    it.each(['lax', 'strict'])('acepta el valor "%s"', (value) => {
      const config = validateEnv({ ...baseEnv, AUTH_COOKIE_SAMESITE: value });

      expect(config.AUTH_COOKIE_SAMESITE).toBe(value);
    });

    it('rechaza un valor fuera de lax, strict o none', () => {
      expect(() =>
        validateEnv({ ...baseEnv, AUTH_COOKIE_SAMESITE: 'invalid' }),
      ).toThrow(/AUTH_COOKIE_SAMESITE/);
    });

    it('falla si AUTH_COOKIE_SAMESITE=none con NODE_ENV distinto de production', () => {
      expect(() =>
        validateEnv({
          ...baseEnv,
          AUTH_COOKIE_SAMESITE: 'none',
          NODE_ENV: 'development',
        }),
      ).toThrow(/AUTH_COOKIE_SAMESITE=none/);
    });

    it('acepta AUTH_COOKIE_SAMESITE=none cuando NODE_ENV=production', () => {
      const config = validateEnv({
        ...baseEnv,
        AUTH_COOKIE_SAMESITE: 'none',
        NODE_ENV: 'production',
      });

      expect(config.AUTH_COOKIE_SAMESITE).toBe(CookieSameSite.None);
    });
  });

  describe('MAX_LOGIN_ATTEMPTS', () => {
    it('falla si no es un entero', () => {
      expect(() =>
        validateEnv({ ...baseEnv, MAX_LOGIN_ATTEMPTS: 'abc' }),
      ).toThrow(/MAX_LOGIN_ATTEMPTS/);
    });

    it('falla si es menor a 1', () => {
      expect(() =>
        validateEnv({ ...baseEnv, MAX_LOGIN_ATTEMPTS: '0' }),
      ).toThrow(/MAX_LOGIN_ATTEMPTS/);
    });

    it('usa 5 como valor por defecto', () => {
      const config = validateEnv({
        ...baseEnv,
        MAX_LOGIN_ATTEMPTS: undefined,
      });

      expect(config.MAX_LOGIN_ATTEMPTS).toBe(5);
    });
  });

  describe('LOGIN_THROTTLE_TTL_MS y LOGIN_THROTTLE_LIMIT', () => {
    it('fallan si no son enteros', () => {
      expect(() =>
        validateEnv({ ...baseEnv, LOGIN_THROTTLE_TTL_MS: 'abc' }),
      ).toThrow(/LOGIN_THROTTLE_TTL_MS/);
      expect(() =>
        validateEnv({ ...baseEnv, LOGIN_THROTTLE_LIMIT: 'abc' }),
      ).toThrow(/LOGIN_THROTTLE_LIMIT/);
    });

    it('fallan si son menores a 1', () => {
      expect(() =>
        validateEnv({ ...baseEnv, LOGIN_THROTTLE_TTL_MS: '0' }),
      ).toThrow(/LOGIN_THROTTLE_TTL_MS/);
      expect(() =>
        validateEnv({ ...baseEnv, LOGIN_THROTTLE_LIMIT: '0' }),
      ).toThrow(/LOGIN_THROTTLE_LIMIT/);
    });

    it('usan 60000 y 10 como valores por defecto', () => {
      const config = validateEnv({
        ...baseEnv,
        LOGIN_THROTTLE_TTL_MS: undefined,
        LOGIN_THROTTLE_LIMIT: undefined,
      });

      expect(config.LOGIN_THROTTLE_TTL_MS).toBe(60000);
      expect(config.LOGIN_THROTTLE_LIMIT).toBe(10);
    });
  });

  describe('PRODUCT_UPLOAD_DIR', () => {
    it('usa "uploads/products" como valor por defecto', () => {
      const config = validateEnv({
        ...baseEnv,
        PRODUCT_UPLOAD_DIR: undefined,
      });

      expect(config.PRODUCT_UPLOAD_DIR).toBe('uploads/products');
    });

    it('acepta un valor personalizado', () => {
      const config = validateEnv({
        ...baseEnv,
        PRODUCT_UPLOAD_DIR: 'custom/uploads',
      });

      expect(config.PRODUCT_UPLOAD_DIR).toBe('custom/uploads');
    });

    it('falla si se envía como cadena vacía', () => {
      expect(() => validateEnv({ ...baseEnv, PRODUCT_UPLOAD_DIR: '' })).toThrow(
        /PRODUCT_UPLOAD_DIR/,
      );
    });
  });

  describe('PRODUCT_IMAGE_MAX_SIZE_BYTES', () => {
    it('usa 5242880 como valor por defecto', () => {
      const config = validateEnv({
        ...baseEnv,
        PRODUCT_IMAGE_MAX_SIZE_BYTES: undefined,
      });

      expect(config.PRODUCT_IMAGE_MAX_SIZE_BYTES).toBe(5242880);
    });

    it('falla si no es un entero', () => {
      expect(() =>
        validateEnv({ ...baseEnv, PRODUCT_IMAGE_MAX_SIZE_BYTES: 'abc' }),
      ).toThrow(/PRODUCT_IMAGE_MAX_SIZE_BYTES/);
    });

    it('falla si es menor a 1024', () => {
      expect(() =>
        validateEnv({ ...baseEnv, PRODUCT_IMAGE_MAX_SIZE_BYTES: '1023' }),
      ).toThrow(/PRODUCT_IMAGE_MAX_SIZE_BYTES/);
    });

    it('acepta exactamente 1024', () => {
      const config = validateEnv({
        ...baseEnv,
        PRODUCT_IMAGE_MAX_SIZE_BYTES: '1024',
      });

      expect(config.PRODUCT_IMAGE_MAX_SIZE_BYTES).toBe(1024);
    });
  });
});
