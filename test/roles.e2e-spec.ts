import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * GET /api/v1/roles — catálogo de RoleName para el selector de Angular.
 * Exclusivo de ADMIN. Suite dedicada y aislada: limpia exclusivamente el
 * usuario fixture que ella misma crea.
 */

interface RoleOptionBody {
  name: string;
}

const SELLER_USERNAME = 'e2e_roles_seller';
const FIXTURE_PASSWORD = 'E2eRolesFixture2026Aa';

describe('Roles — catálogo del sistema (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let sellerCookie: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    const adminLogin = await login(
      app.getHttpServer(),
      E2E_ADMIN_USERNAME,
      E2E_ADMIN_ACTIVE_PASSWORD,
    );
    if (adminLogin.status !== 200) {
      throw new Error(
        `No se pudo autenticar al admin de prueba: ${JSON.stringify(adminLogin.body)}`,
      );
    }
    adminCookie = adminLogin.cookie;

    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_roles_seller@demosystem.test',
      password: FIXTURE_PASSWORD,
      roleName: RoleName.SELLER,
    });
    sellerCookie = (
      await login(app.getHttpServer(), SELLER_USERNAME, FIXTURE_PASSWORD)
    ).cookie;
  }, 60000);

  afterAll(async () => {
    try {
      await prisma.userRole.deleteMany({
        where: { user: { username: SELLER_USERNAME } },
      });
      await prisma.user.deleteMany({ where: { username: SELLER_USERNAME } });
    } finally {
      await app.close();
    }
  }, 60000);

  it('sin autenticación: 401', async () => {
    const response = await request(app.getHttpServer()).get('/api/v1/roles');
    expect(response.status).toBe(401);
  });

  it('autenticado con un rol distinto de ADMIN: 403', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/roles')
      .set('Cookie', sellerCookie);
    expect(response.status).toBe(403);
  });

  it('ADMIN: 200 con exactamente los valores de RoleName, sin duplicados ni inventados', async () => {
    const response = await request(app.getHttpServer())
      .get('/api/v1/roles')
      .set('Cookie', adminCookie);
    expect(response.status).toBe(200);
    const body = response.body as RoleOptionBody[];
    const names = body.map((r) => r.name);
    expect(new Set(names)).toEqual(new Set(Object.values(RoleName)));
    expect(names).toHaveLength(Object.values(RoleName).length);
  });
});
