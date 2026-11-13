import { INestApplication } from '@nestjs/common';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { login } from './helpers/http';
import {
  createSireDemoE2eApp,
  snapshotSireDemoEnv,
} from './helpers/sire-demo-app';

const BASE = '/api/v1/sire-demo';

describe('SIRE DEMO — módulo desactivado (valor por defecto) (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = snapshotSireDemoEnv();
    app = await createSireDemoE2eApp({});
    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(
        `No se pudo autenticar al admin: ${JSON.stringify(adminLogin.body)}`,
      );
    }
    adminCookie = adminLogin.cookie;
  }, 60000);

  afterAll(async () => {
    await app?.close();
    restoreEnv();
  });

  const ROUTES = [
    `${BASE}/context`,
    `${BASE}/registers/rvie/documents?source=POS&period=202601`,
    `${BASE}/registers/rce/documents?source=DEMO_FIXTURES&period=202601`,
    `${BASE}/registers/rvie/sample-file?source=DEMO_FIXTURES&period=202601`,
  ];

  it.each(ROUTES)(
    '%s responde 404 incluso a ADMIN autenticado',
    async (url) => {
      const response = await request(app.getHttpServer())
        .get(url)
        .set('Cookie', adminCookie);
      expect(response.status).toBe(404);
    },
  );

  it.each(ROUTES)(
    '%s responde 404 sin sesión (la ruta no existe)',
    async (url) => {
      const response = await request(app.getHttpServer()).get(url);
      expect(response.status).toBe(404);
    },
  );

  it('las rutas no aparecen en la documentación OpenAPI', async () => {
    const docs = await request(app.getHttpServer()).get('/api/docs-json');
    expect(docs.status).toBe(200);
    const paths = Object.keys(
      (docs.body as { paths: Record<string, unknown> }).paths,
    );
    expect(paths.length).toBeGreaterThan(10);
    expect(paths.filter((p) => p.includes('sire-demo'))).toEqual([]);
  });

  it('el resto de la API sigue operando con normalidad', async () => {
    const health = await request(app.getHttpServer()).get('/api/v1/health');
    expect(health.status).toBe(200);
  });
});
