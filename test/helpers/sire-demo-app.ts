import { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { App } from 'supertest/types';

export interface SireDemoE2eEnv {
  /** undefined => la variable se elimina (valor por defecto del módulo: apagado). */
  enabled?: boolean;
  fixtures?: boolean;
}

const ENV_KEYS: Record<keyof SireDemoE2eEnv, string> = {
  enabled: 'SIRE_DEMO_ENABLED',
  fixtures: 'SIRE_DEMO_FIXTURES_ENABLED',
};

/** Restaura las variables SIRE_DEMO_* que tenía el proceso antes de la prueba. */
export function snapshotSireDemoEnv(): () => void {
  const saved = [
    'SIRE_DEMO_ENABLED',
    'SIRE_DEMO_FIXTURES_ENABLED',
    'SIRE_DEMO_ALLOW_IN_PRODUCTION',
  ].map((key) => [key, process.env[key]] as const);
  return () => {
    for (const [key, value] of saved) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  };
}

/**
 * Crea la app con los flags SIRE DEMO indicados. El registro condicional del
 * módulo se decide al EVALUAR AppModule (import), así que las variables se
 * fijan ANTES de importarlo de forma dinámica: este helper nunca importa
 * AppModule de forma estática. Cada archivo e2e tiene su propio registro de
 * módulos de Jest, por lo que el flag no se filtra a otros archivos.
 */
export async function createSireDemoE2eApp(
  env: SireDemoE2eEnv,
): Promise<INestApplication<App>> {
  for (const [field, key] of Object.entries(ENV_KEYS) as [
    keyof SireDemoE2eEnv,
    string,
  ][]) {
    const value = env[field];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = String(value);
    }
  }
  delete process.env.SIRE_DEMO_ALLOW_IN_PRODUCTION;

  // require() (no import()): Jest en CommonJS no admite import() dinámico sin
  // --experimental-vm-modules, y aquí hace falta evaluar AppModule DESPUÉS de
  // fijar las variables SIRE_DEMO_*.
  /* eslint-disable @typescript-eslint/no-require-imports */
  const { AppModule } =
    require('../../src/app.module') as typeof import('../../src/app.module');
  const { setupApp } =
    require('../../src/app.setup') as typeof import('../../src/app.setup');
  const { setupSwagger } =
    require('../../src/config/swagger') as typeof import('../../src/config/swagger');
  /* eslint-enable @typescript-eslint/no-require-imports */

  const moduleFixture = await Test.createTestingModule({
    imports: [AppModule],
  }).compile();
  const app = moduleFixture.createNestApplication<INestApplication<App>>();
  setupApp(app);
  setupSwagger(app);
  await app.init();
  return app;
}
