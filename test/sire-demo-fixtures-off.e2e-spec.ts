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

describe('SIRE DEMO — módulo activo con el origen DEMO_FIXTURES deshabilitado (e2e)', () => {
  let app: INestApplication<App>;
  let adminCookie: string;
  let restoreEnv: () => void;

  beforeAll(async () => {
    restoreEnv = snapshotSireDemoEnv();
    app = await createSireDemoE2eApp({ enabled: true });
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

  it('el contexto marca DEMO_FIXTURES como no disponible y POS como disponible', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/context`)
      .set('Cookie', adminCookie);
    expect(response.status).toBe(200);
    const body = response.body as {
      mode: string;
      officialValidity: boolean;
      sources: { source: string; available: boolean; registers: unknown }[];
    };
    expect(body).toMatchObject({ mode: 'DEMO', officialValidity: false });
    expect(body.sources.find((s) => s.source === 'POS')?.available).toBe(true);
    expect(
      body.sources.find((s) => s.source === 'DEMO_FIXTURES'),
    ).toMatchObject({
      available: false,
      isEmpty: true,
      registers: { RVIE: { periods: [] }, RCE: { periods: [] } },
    });
  });

  it.each([
    `${BASE}/registers/rvie/documents?source=DEMO_FIXTURES&period=202601`,
    `${BASE}/registers/rce/sample-file?source=DEMO_FIXTURES&period=202601`,
  ])('%s responde 403 con código SIRE_SOURCE_DISABLED', async (url) => {
    const response = await request(app.getHttpServer())
      .get(url)
      .set('Cookie', adminCookie);
    expect(response.status).toBe(403);
    expect(response.body).toMatchObject({ code: 'SIRE_SOURCE_DISABLED' });
  });

  it('el origen POS sigue disponible', async () => {
    const response = await request(app.getHttpServer())
      .get(`${BASE}/registers/rvie/documents?source=POS&period=200001`)
      .set('Cookie', adminCookie);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      source: 'POS',
      fixtureSetVersion: null,
      items: [],
    });
  });
});
