import { ConfigModule, ConfigService } from '@nestjs/config';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateEnv } from '../config/env.validation';
import { SireDemoController } from './sire-demo.controller';
import {
  DISABLED_SIRE_DEMO_FLAGS,
  SireDemoConfigError,
  SireDemoFlags,
  resolveSireDemoFlags,
  resolveSireDemoFlagsFailClosed,
} from './sire-demo.flags';
import { SireDemoBootCheck, SireDemoEnabledGuard } from './sire-demo.guards';
import { SireDemoModule } from './sire-demo.module';

const ENV_KEYS = [
  'SIRE_DEMO_ENABLED',
  'SIRE_DEMO_FIXTURES_ENABLED',
  'SIRE_DEMO_ALLOW_IN_PRODUCTION',
] as const;

describe('resolveSireDemoFlags — matriz de arranque', () => {
  it.each([
    // [NODE_ENV, ENABLED, FIXTURES, ALLOW, resultado]
    ['development', undefined, undefined, undefined, 'ok-off'],
    ['production', undefined, undefined, undefined, 'ok-off'],
    ['production', 'false', 'false', 'false', 'ok-off'],
    ['development', 'false', 'true', undefined, 'error'],
    ['production', 'false', 'true', 'true', 'error'],
    ['development', 'true', 'false', undefined, 'ok-on'],
    ['development', 'true', 'true', undefined, 'ok-on'],
    ['test', 'true', 'true', undefined, 'ok-on'],
    ['production', 'true', undefined, undefined, 'error'],
    ['production', 'true', 'true', 'false', 'error'],
    ['production', 'true', 'false', 'true', 'ok-on'],
    ['production', 'true', 'true', 'true', 'ok-on'],
  ] as const)(
    'NODE_ENV=%s ENABLED=%s FIXTURES=%s ALLOW=%s -> %s',
    (nodeEnv, enabled, fixtures, allow, outcome) => {
      const env = {
        NODE_ENV: nodeEnv,
        SIRE_DEMO_ENABLED: enabled,
        SIRE_DEMO_FIXTURES_ENABLED: fixtures,
        SIRE_DEMO_ALLOW_IN_PRODUCTION: allow,
      };
      if (outcome === 'error') {
        expect(() => resolveSireDemoFlags(env)).toThrow(SireDemoConfigError);
        // El registro es fail-closed: nunca monta el módulo ante una configuración prohibida.
        expect(resolveSireDemoFlagsFailClosed(env)).toEqual(
          DISABLED_SIRE_DEMO_FLAGS,
        );
        return;
      }
      const flags = resolveSireDemoFlags(env);
      expect(flags.enabled).toBe(outcome === 'ok-on');
      expect(flags.fixturesEnabled).toBe(fixtures === 'true');
    },
  );

  it('todo apagado por defecto (sin variables)', () => {
    expect(resolveSireDemoFlags({})).toEqual({
      enabled: false,
      fixturesEnabled: false,
      allowInProduction: false,
      production: false,
    });
  });

  it.each(['yes', '1', 'TRUE', 'True', 'on', ' true'])(
    'valor ambiguo %p aborta (nunca se interpreta como apagado)',
    (value) => {
      expect(() => resolveSireDemoFlags({ SIRE_DEMO_ENABLED: value })).toThrow(
        SireDemoConfigError,
      );
      expect(
        resolveSireDemoFlagsFailClosed({ SIRE_DEMO_ENABLED: value }),
      ).toEqual(DISABLED_SIRE_DEMO_FLAGS);
    },
  );

  it('acepta booleanos reales (valores ya validados por ConfigService)', () => {
    expect(
      resolveSireDemoFlags({
        SIRE_DEMO_ENABLED: true,
        SIRE_DEMO_FIXTURES_ENABLED: false,
        NODE_ENV: 'development',
      }).enabled,
    ).toBe(true);
  });
});

describe('validateEnv — flags SIRE DEMO', () => {
  const base = {
    NODE_ENV: 'development',
    DATABASE_URL: 'postgresql://invalid:invalid@127.0.0.1:1/none',
    JWT_SECRET: 'x'.repeat(40),
  };

  it('por defecto quedan en false', () => {
    const config = validateEnv(base);
    expect(config.SIRE_DEMO_ENABLED).toBe(false);
    expect(config.SIRE_DEMO_FIXTURES_ENABLED).toBe(false);
    expect(config.SIRE_DEMO_ALLOW_IN_PRODUCTION).toBe(false);
  });

  it('convierte true/false y acepta una combinación válida', () => {
    const config = validateEnv({
      ...base,
      SIRE_DEMO_ENABLED: 'true',
      SIRE_DEMO_FIXTURES_ENABLED: 'true',
    });
    expect(config.SIRE_DEMO_ENABLED).toBe(true);
    expect(config.SIRE_DEMO_FIXTURES_ENABLED).toBe(true);
  });

  it.each([
    ['valor ambiguo', { SIRE_DEMO_ENABLED: 'yes' }, 'SIRE_DEMO_ENABLED'],
    [
      'fixtures sin módulo',
      { SIRE_DEMO_FIXTURES_ENABLED: 'true' },
      'SIRE_DEMO_FIXTURES_ENABLED',
    ],
    [
      'producción sin autorización',
      { NODE_ENV: 'production', SIRE_DEMO_ENABLED: 'true' },
      'SIRE_DEMO_ALLOW_IN_PRODUCTION',
    ],
    [
      'producción, fixtures y sin autorización',
      {
        NODE_ENV: 'production',
        SIRE_DEMO_ENABLED: 'true',
        SIRE_DEMO_FIXTURES_ENABLED: 'true',
      },
      'SIRE_DEMO_ALLOW_IN_PRODUCTION',
    ],
  ])(
    'configuración prohibida (%s) aborta el arranque',
    (_label, extra, mention) => {
      expect(() => validateEnv({ ...base, ...extra })).toThrow(mention);
    },
  );

  it('producción con autorización explícita es válida', () => {
    const config = validateEnv({
      ...base,
      NODE_ENV: 'production',
      SIRE_DEMO_ENABLED: 'true',
      SIRE_DEMO_ALLOW_IN_PRODUCTION: 'true',
    });
    expect(config.SIRE_DEMO_ENABLED).toBe(true);
  });

  it('producción sin ninguna variable SIRE sigue arrancando con el módulo apagado', () => {
    expect(
      validateEnv({ ...base, NODE_ENV: 'production' }).SIRE_DEMO_ENABLED,
    ).toBe(false);
  });
});

describe('SireDemoModule.register — registro condicional', () => {
  const on: SireDemoFlags = {
    enabled: true,
    fixturesEnabled: true,
    allowInProduction: false,
    production: false,
  };

  it('apagado: módulo vacío (sin controllers) salvo la verificación de arranque', () => {
    const dynamic = SireDemoModule.register(DISABLED_SIRE_DEMO_FLAGS);
    expect(dynamic.controllers).toBeUndefined();
    expect(dynamic.providers).toContain(SireDemoBootCheck);
    expect(dynamic.providers).toHaveLength(2);
  });

  it('activado: monta el controller y el guard', () => {
    const dynamic = SireDemoModule.register(on);
    expect(dynamic.controllers).toEqual([SireDemoController]);
    expect(dynamic.providers).toContain(SireDemoEnabledGuard);
  });

  it('por defecto lee process.env y es fail-closed', () => {
    const saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    try {
      process.env.SIRE_DEMO_ENABLED = 'maybe';
      expect(SireDemoModule.register().controllers).toBeUndefined();
      process.env.SIRE_DEMO_ENABLED = 'true';
      expect(SireDemoModule.register().controllers).toEqual([
        SireDemoController,
      ]);
    } finally {
      for (const [k, v] of saved) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  });
});

describe('SireDemoEnabledGuard', () => {
  it('responde 404 si el interruptor maestro está apagado', () => {
    expect(() =>
      new SireDemoEnabledGuard(DISABLED_SIRE_DEMO_FLAGS).canActivate(),
    ).toThrow('Not Found');
    expect(
      new SireDemoEnabledGuard({
        ...DISABLED_SIRE_DEMO_FLAGS,
        enabled: true,
      }).canActivate(),
    ).toBe(true);
  });
});

describe('SireDemoBootCheck — verificación autoritativa tras ConfigModule', () => {
  const config = (values: Record<string, unknown>): ConfigService =>
    ({ get: (key: string) => values[key] }) as unknown as ConfigService;
  const mounted = (over: Partial<SireDemoFlags>): SireDemoFlags => ({
    ...DISABLED_SIRE_DEMO_FLAGS,
    ...over,
  });

  it('acepta lo montado cuando coincide con la configuración validada', () => {
    expect(() =>
      new SireDemoBootCheck(
        mounted({}),
        config({
          NODE_ENV: 'development',
          SIRE_DEMO_ENABLED: false,
          SIRE_DEMO_FIXTURES_ENABLED: false,
        }),
      ).onModuleInit(),
    ).not.toThrow();
    expect(() =>
      new SireDemoBootCheck(
        mounted({ enabled: true, fixturesEnabled: true }),
        config({
          NODE_ENV: 'development',
          SIRE_DEMO_ENABLED: true,
          SIRE_DEMO_FIXTURES_ENABLED: true,
        }),
      ).onModuleInit(),
    ).not.toThrow();
  });

  it('aborta si el módulo quedó ausente pero la configuración lo pide (flags no visibles al registrar)', () => {
    expect(() =>
      new SireDemoBootCheck(
        mounted({}),
        config({ NODE_ENV: 'development', SIRE_DEMO_ENABLED: true }),
      ).onModuleInit(),
    ).toThrow('flags distintos');
  });

  it('aborta si quedó montado pero la configuración validada no lo autoriza', () => {
    expect(() =>
      new SireDemoBootCheck(
        mounted({ enabled: true }),
        config({ NODE_ENV: 'development', SIRE_DEMO_ENABLED: false }),
      ).onModuleInit(),
    ).toThrow('flags distintos');
    expect(() =>
      new SireDemoBootCheck(
        mounted({ enabled: true, fixturesEnabled: true }),
        config({
          NODE_ENV: 'development',
          SIRE_DEMO_ENABLED: true,
          SIRE_DEMO_FIXTURES_ENABLED: false,
        }),
      ).onModuleInit(),
    ).toThrow('flags distintos');
  });

  it('aborta ante una configuración prohibida aunque lo montado coincida', () => {
    expect(() =>
      new SireDemoBootCheck(
        mounted({ enabled: true, production: true }),
        config({
          NODE_ENV: 'production',
          SIRE_DEMO_ENABLED: true,
          SIRE_DEMO_ALLOW_IN_PRODUCTION: false,
        }),
      ).onModuleInit(),
    ).toThrow(SireDemoConfigError);
  });
});

describe('orden real de ConfigModule.forRoot dentro de un arreglo de imports (comportamiento verificado de @nestjs/config)', () => {
  let dir: string;
  let saved: ReadonlyArray<readonly [string, string | undefined]>;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'sire-env-'));
    saved = ENV_KEYS.map((k) => [k, process.env[k]] as const);
    for (const k of ENV_KEYS) delete process.env[k];
  });

  afterEach(() => {
    for (const [k, v] of saved) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('un flag definido SOLO en el archivo .env ya es visible al evaluar el siguiente elemento del arreglo', async () => {
    const envPath = join(dir, '.env');
    writeFileSync(
      envPath,
      'SIRE_DEMO_ENABLED=true\nSIRE_DEMO_FIXTURES_ENABLED=true\n',
    );
    expect(process.env.SIRE_DEMO_ENABLED).toBeUndefined();

    // Mismo patrón que AppModule: ConfigModule.forRoot primero, el módulo después.
    const imports = [
      ConfigModule.forRoot({ envFilePath: envPath, validate: (raw) => raw }),
      SireDemoModule.register(),
    ];

    expect((imports[1] as { controllers?: unknown[] }).controllers).toEqual([
      SireDemoController,
    ]);
    await imports[0];
  });

  it('si la validación del entorno falla, el flag NO se publica y el registro queda apagado (fail-closed)', async () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'SIRE_DEMO_ENABLED=true\n');

    const forRoot = ConfigModule.forRoot({
      envFilePath: envPath,
      validate: () => {
        throw new Error('entorno inválido simulado');
      },
    });
    const dynamic = SireDemoModule.register();

    expect(dynamic.controllers).toBeUndefined();
    await expect(forRoot).rejects.toThrow('entorno inválido simulado');
  });

  it('una variable ya presente en el entorno del proceso prevalece sobre el .env', async () => {
    const envPath = join(dir, '.env');
    writeFileSync(envPath, 'SIRE_DEMO_ENABLED=true\n');
    process.env.SIRE_DEMO_ENABLED = 'false';

    const imports = [
      ConfigModule.forRoot({ envFilePath: envPath, validate: (raw) => raw }),
      SireDemoModule.register(),
    ];
    expect(
      (imports[1] as { controllers?: unknown[] }).controllers,
    ).toBeUndefined();
    await imports[0];
  });
});
