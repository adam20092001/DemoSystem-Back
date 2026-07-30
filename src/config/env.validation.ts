import { plainToInstance } from 'class-transformer';
import {
  IsBoolean,
  IsEnum,
  IsInt,
  IsNotEmpty,
  IsString,
  Matches,
  Max,
  Min,
  MinLength,
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

export enum CookieSameSite {
  Lax = 'lax',
  Strict = 'strict',
  None = 'none',
}

const JWT_SECRET_MIN_LENGTH = 32;

/**
 * Contrato de las variables de entorno requeridas por la aplicación.
 * Si alguna falta o es inválida, el arranque falla de forma explícita.
 *
 * INITIAL_ADMIN_* queda deliberadamente fuera de este contrato: solo las
 * valida prisma/seed.ts, para no obligar a definirlas en cada arranque.
 */
export class EnvironmentVariables {
  @IsEnum(NodeEnv, {
    message: 'NODE_ENV debe ser: development, production o test',
  })
  NODE_ENV!: NodeEnv;

  @IsInt({ message: 'PORT debe ser un número entero' })
  @Min(1)
  @Max(65535)
  PORT!: number;

  @IsString()
  @IsNotEmpty({ message: 'DATABASE_URL es obligatorio' })
  @Matches(/^postgres(ql)?:\/\/.+/, {
    message: 'DATABASE_URL debe ser una cadena de conexión PostgreSQL válida',
  })
  DATABASE_URL!: string;

  @IsString()
  @IsNotEmpty({ message: 'CORS_ORIGIN es obligatorio' })
  CORS_ORIGIN!: string;

  @IsBoolean({ message: 'SWAGGER_ENABLED debe ser true o false' })
  SWAGGER_ENABLED!: boolean;

  @IsString()
  @MinLength(JWT_SECRET_MIN_LENGTH, {
    message: `JWT_SECRET debe tener al menos ${JWT_SECRET_MIN_LENGTH} caracteres`,
  })
  JWT_SECRET!: string;

  @Matches(/^\d+(m|h|d)$/, {
    message:
      'JWT_EXPIRES_IN debe tener el formato <número><m|h|d>, por ejemplo 30m, 8h o 1d',
  })
  JWT_EXPIRES_IN!: string;

  @IsString()
  @IsNotEmpty({ message: 'AUTH_COOKIE_NAME es obligatorio' })
  AUTH_COOKIE_NAME!: string;

  @IsEnum(CookieSameSite, {
    message: 'AUTH_COOKIE_SAMESITE debe ser lax, strict o none',
  })
  AUTH_COOKIE_SAMESITE!: CookieSameSite;

  @IsInt({ message: 'MAX_LOGIN_ATTEMPTS debe ser un número entero' })
  @Min(1)
  MAX_LOGIN_ATTEMPTS!: number;

  @IsInt({ message: 'LOGIN_THROTTLE_TTL_MS debe ser un número entero' })
  @Min(1)
  LOGIN_THROTTLE_TTL_MS!: number;

  @IsInt({ message: 'LOGIN_THROTTLE_LIMIT debe ser un número entero' })
  @Min(1)
  LOGIN_THROTTLE_LIMIT!: number;

  @IsString()
  @IsNotEmpty({ message: 'PRODUCT_UPLOAD_DIR es obligatorio' })
  PRODUCT_UPLOAD_DIR!: string;

  @IsInt({ message: 'PRODUCT_IMAGE_MAX_SIZE_BYTES debe ser un número entero' })
  @Min(1024, {
    message: 'PRODUCT_IMAGE_MAX_SIZE_BYTES debe ser al menos 1024 bytes',
  })
  PRODUCT_IMAGE_MAX_SIZE_BYTES!: number;
}

/**
 * Normaliza un valor de entorno a entero. Si el valor es inválido se devuelve
 * tal cual para que sea class-validator quien reporte el error.
 */
function toInt(value: unknown, fallback: number): unknown {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  const parsed = Number(value);
  return Number.isInteger(parsed) ? parsed : value;
}

/**
 * Convierte los literales "true"/"false" a boolean real. No usa Boolean(x),
 * que interpretaría "false" (cualquier string no vacío) como verdadero.
 */
function toBool(value: unknown, fallback: boolean): unknown {
  if (value === undefined || value === null || value === '') {
    return fallback;
  }
  if (value === true || value === 'true') {
    return true;
  }
  if (value === false || value === 'false') {
    return false;
  }
  return value;
}

/**
 * Validador consumido por ConfigModule.forRoot({ validate }).
 * Se ejecuta una sola vez, durante el arranque.
 */
export function validateEnv(
  raw: Record<string, unknown>,
): EnvironmentVariables {
  const normalized = {
    NODE_ENV: raw.NODE_ENV ?? NodeEnv.Development,
    PORT: toInt(raw.PORT, 3000),
    DATABASE_URL: raw.DATABASE_URL,
    CORS_ORIGIN: raw.CORS_ORIGIN ?? 'http://localhost:4201',
    SWAGGER_ENABLED: toBool(raw.SWAGGER_ENABLED, true),
    JWT_SECRET: raw.JWT_SECRET,
    JWT_EXPIRES_IN: raw.JWT_EXPIRES_IN ?? '8h',
    AUTH_COOKIE_NAME: raw.AUTH_COOKIE_NAME ?? 'demosystem_session',
    AUTH_COOKIE_SAMESITE: raw.AUTH_COOKIE_SAMESITE ?? CookieSameSite.Lax,
    MAX_LOGIN_ATTEMPTS: toInt(raw.MAX_LOGIN_ATTEMPTS, 5),
    LOGIN_THROTTLE_TTL_MS: toInt(raw.LOGIN_THROTTLE_TTL_MS, 60000),
    LOGIN_THROTTLE_LIMIT: toInt(raw.LOGIN_THROTTLE_LIMIT, 10),
    PRODUCT_UPLOAD_DIR: raw.PRODUCT_UPLOAD_DIR ?? 'uploads/products',
    PRODUCT_IMAGE_MAX_SIZE_BYTES: toInt(
      raw.PRODUCT_IMAGE_MAX_SIZE_BYTES,
      5242880,
    ),
  };

  const config = plainToInstance(EnvironmentVariables, normalized);
  const errors = validateSync(config, { skipMissingProperties: false });

  if (errors.length > 0) {
    const details = errors
      .map((error) => {
        const constraints = Object.values(error.constraints ?? {}).join('; ');
        return `  - ${error.property}: ${constraints}`;
      })
      .join('\n');

    throw new Error(
      `Configuración de entorno inválida:\n${details}\n\n` +
        'Revisa tu archivo .env tomando como referencia .env.example.',
    );
  }

  // Un navegador rechaza SameSite=None sin Secure=true, y Secure solo se
  // activa en producción (NODE_ENV === 'production'). Falla temprano en
  // lugar de emitir cookies que el navegador descartará en silencio.
  if (
    config.AUTH_COOKIE_SAMESITE === CookieSameSite.None &&
    config.NODE_ENV !== NodeEnv.Production
  ) {
    throw new Error(
      'Configuración de entorno inválida:\n' +
        '  - AUTH_COOKIE_SAMESITE=none requiere Secure=true, que solo se activa ' +
        'con NODE_ENV=production.\n\n' +
        'Usa lax o strict en entornos no productivos, o cambia NODE_ENV a production.',
    );
  }

  return config;
}
