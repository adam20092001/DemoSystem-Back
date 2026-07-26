import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';

/**
 * Archivo aislado: sobrescribe LOGIN_THROTTLE_LIMIT a un valor muy bajo solo
 * para esta suite, para no interferir con el resto de las pruebas de login
 * en auth.e2e-spec.ts (que necesitan margen de peticiones sin toparse con el
 * límite real de .env.test).
 *
 * ConfigModule.forRoot() valida process.env de forma inmediata, en el mismo
 * momento en que se evalúa `@Module({ imports: [...] })` de AppModule — es
 * decir, en cuanto algo hace `import` de AppModule (directa o
 * transitivamente). Por eso el override de LOGIN_THROTTLE_LIMIT se hace
 * ANTES de cargar el helper que a su vez importa AppModule; un `import`
 * estático normal se habría evaluado demasiado pronto. Se usa require()
 * (no import() dinámico) porque Jest, bajo CommonJS, no soporta import()
 * dinámico sin --experimental-vm-modules.
 */
describe('Rate limiting de POST /auth/login (e2e)', () => {
  let app: INestApplication<App>;
  const originalLimit = process.env.LOGIN_THROTTLE_LIMIT;

  beforeAll(async () => {
    process.env.LOGIN_THROTTLE_LIMIT = '3';

    type E2eAppHelpers = typeof import('./helpers/e2e-app');
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const e2eAppHelpers = require('./helpers/e2e-app') as E2eAppHelpers;
    app = await e2eAppHelpers.createE2eApp();
  });

  afterAll(async () => {
    await app.close();
    process.env.LOGIN_THROTTLE_LIMIT = originalLimit;
  });

  it('responde 429 al superar el límite configurado', async () => {
    const statuses: number[] = [];

    for (let i = 0; i < 4; i++) {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({
          identifier: 'usuario-inexistente-rate-limit',
          password: 'cualquiera123',
        });
      statuses.push(response.status);
    }

    expect(statuses.slice(0, 3)).toEqual([401, 401, 401]);
    expect(statuses[3]).toBe(429);
  });
});
