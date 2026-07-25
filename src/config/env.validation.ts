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
  validateSync,
} from 'class-validator';

export enum NodeEnv {
  Development = 'development',
  Production = 'production',
  Test = 'test',
}

/**
 * Contrato de las variables de entorno requeridas por la aplicación.
 * Si alguna falta o es inválida, el arranque falla de forma explícita.
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

/** Normaliza un valor de entorno a booleano, con el mismo criterio que toInt. */
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

  return config;
}
