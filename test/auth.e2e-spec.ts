import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName, UserStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { hashPassword } from '../src/common/security/password.service';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_SEED_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

const LOCKOUT_USERNAME = 'e2e_lockout';
const INACTIVE_USERNAME = 'e2e_inactive';
const BLOCKED_USERNAME = 'e2e_blocked';
const LOCKOUT_PASSWORD = 'LockoutUserPass123';
const INACTIVE_PASSWORD = 'InactiveUserPass123';
const BLOCKED_PASSWORD = 'BlockedUserPass123';

describe('Auth (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    await upsertFixtureUser(prisma, {
      username: LOCKOUT_USERNAME,
      email: 'e2e_lockout@demosystem.test',
      password: LOCKOUT_PASSWORD,
      roleName: RoleName.SELLER,
      status: UserStatus.ACTIVE,
      failedLoginAttempts: 0,
      blockedAt: null,
    });
    await upsertFixtureUser(prisma, {
      username: INACTIVE_USERNAME,
      email: 'e2e_inactive@demosystem.test',
      password: INACTIVE_PASSWORD,
      roleName: RoleName.SELLER,
      status: UserStatus.INACTIVE,
    });
    await upsertFixtureUser(prisma, {
      username: BLOCKED_USERNAME,
      email: 'e2e_blocked@demosystem.test',
      password: BLOCKED_PASSWORD,
      roleName: RoleName.SELLER,
      status: UserStatus.BLOCKED,
      blockedAt: new Date(),
    });

    // El admin de prueba se restablece a su estado "recién sembrado" para
    // poder ejercitar aquí, de forma repetible, todo el ciclo de vida de
    // mustChangePassword (login pendiente -> cambio -> activo).
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMIN },
    });
    await prisma.user.update({
      where: { username: E2E_ADMIN_USERNAME },
      data: {
        passwordHash: await hashPassword(E2E_ADMIN_SEED_PASSWORD),
        roleId: adminRole.id,
        status: UserStatus.ACTIVE,
        mustChangePassword: true,
        failedLoginAttempts: 0,
        blockedAt: null,
      },
    });
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('health y raíz con los guards globales activos', () => {
    it('GET /api/v1/health sigue siendo público', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/health');
      expect(response.status).toBe(200);
    });

    it('GET / responde 404, no 401', async () => {
      const response = await request(app.getHttpServer()).get('/');
      expect(response.status).toBe(404);
    });
  });

  describe('GET /auth/me sin autenticación', () => {
    it('responde 401', async () => {
      const response = await request(app.getHttpServer()).get(
        '/api/v1/auth/me',
      );
      expect(response.status).toBe(401);
    });
  });

  describe('POST /auth/login', () => {
    it('usuario inexistente responde 401 genérico', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: 'no-existe-en-absoluto', password: 'loquesea123' });

      expect(response.status).toBe(401);
      expect((response.body as { message: string }).message).toBe(
        'Credenciales inválidas',
      );
    });

    it('registra LOGIN_FAILED con userId nulo y sin el identifier ingresado', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.LOGIN_FAILED, userId: null },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });

      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]);
      expect(serialized).not.toContain('no-existe-en-absoluto');
      expect((rows[0].metadata as { reason: string }).reason).toBe(
        'USER_NOT_FOUND',
      );
    });

    it('contraseña incorrecta responde 401 genérico', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: LOCKOUT_USERNAME, password: 'contraseña-mala-1' });

      expect(response.status).toBe(401);
      expect((response.body as { message: string }).message).toBe(
        'Credenciales inválidas',
      );
    });

    it('incrementa failedLoginAttempts y bloquea al alcanzar MAX_LOGIN_ATTEMPTS (5)', async () => {
      // El primer intento incorrecto ya se hizo en la prueba anterior (van 1).
      for (let attempt = 2; attempt <= 4; attempt++) {
        await request(app.getHttpServer())
          .post('/api/v1/auth/login')
          .send({ identifier: LOCKOUT_USERNAME, password: `mala-${attempt}` });

        const user = await prisma.user.findUniqueOrThrow({
          where: { username: LOCKOUT_USERNAME },
        });
        expect(user.failedLoginAttempts).toBe(attempt);
        expect(user.status).toBe(UserStatus.ACTIVE);
      }

      // 5to intento: alcanza el máximo y bloquea.
      const finalAttempt = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: LOCKOUT_USERNAME, password: 'mala-5' });

      expect(finalAttempt.status).toBe(401);
      const blockedUser = await prisma.user.findUniqueOrThrow({
        where: { username: LOCKOUT_USERNAME },
      });
      expect(blockedUser.failedLoginAttempts).toBe(5);
      expect(blockedUser.status).toBe(UserStatus.BLOCKED);
      expect(blockedUser.blockedAt).not.toBeNull();

      // Incluso con la contraseña correcta, ya está bloqueado.
      const afterBlock = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: LOCKOUT_USERNAME, password: LOCKOUT_PASSWORD });
      expect(afterBlock.status).toBe(401);
    });

    it('usuario INACTIVE responde 401 genérico', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: INACTIVE_USERNAME, password: INACTIVE_PASSWORD });

      expect(response.status).toBe(401);
      expect((response.body as { message: string }).message).toBe(
        'Credenciales inválidas',
      );
    });

    it('usuario BLOCKED responde 401 genérico', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/login')
        .send({ identifier: BLOCKED_USERNAME, password: BLOCKED_PASSWORD });

      expect(response.status).toBe(401);
      expect((response.body as { message: string }).message).toBe(
        'Credenciales inválidas',
      );
    });

    it('login correcto: 200, cookie HttpOnly, sin token en el body, y registra LOGIN_SUCCESS', async () => {
      const result = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      expect(result.status).toBe(200);
      expect(result.setCookieHeader).toContain('HttpOnly');
      expect(result.setCookieHeader).toMatch(/demosystem_session=/);
      expect(result.body).not.toHaveProperty('token');
      expect(result.body).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(result.body)).not.toContain(
        result.setCookieHeader.split('=')[1]?.split(';')[0],
      );
      expect(result.body.mustChangePassword).toBe(true);

      const successRows = await prisma.auditLog.findMany({
        where: { action: AuditAction.LOGIN_SUCCESS },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(successRows).toHaveLength(1);
      expect(successRows[0].userId).not.toBeNull();
    });

    it('GET /auth/me con cookie devuelve el usuario seguro', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
      expect(response.body).toMatchObject({ username: E2E_ADMIN_USERNAME });
      expect(response.body).not.toHaveProperty('passwordHash');
    });
  });

  describe('mustChangePassword (admin recién sembrado, aún pendiente)', () => {
    it('bloquea rutas normales (GET /users) con 403', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Cookie', cookie);

      expect(response.status).toBe(403);
    });

    it('permite GET /auth/me mientras está pendiente', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/auth/me')
        .set('Cookie', cookie);

      expect(response.status).toBe(200);
    });

    it('permite POST /auth/logout mientras está pendiente', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie);

      expect(response.status).toBe(204);
    });

    it('rechaza el cambio de contraseña con currentPassword incorrecto (401)', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({
          currentPassword: 'esta-no-es-la-actual',
          newPassword: 'NuevaClaveValida2026',
        });

      expect(response.status).toBe(401);
    });

    it('rechaza una nueva contraseña fuera de política (400)', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({
          currentPassword: E2E_ADMIN_SEED_PASSWORD,
          newPassword: 'corta1',
        });

      expect(response.status).toBe(400);
    });

    it('cambia la contraseña correctamente (204), registra PASSWORD_CHANGED sin secretos, y desbloquea rutas normales', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_SEED_PASSWORD,
      );

      const changeResponse = await request(app.getHttpServer())
        .post('/api/v1/auth/change-password')
        .set('Cookie', cookie)
        .send({
          currentPassword: E2E_ADMIN_SEED_PASSWORD,
          newPassword: E2E_ADMIN_ACTIVE_PASSWORD,
        });
      expect(changeResponse.status).toBe(204);

      const changedRows = await prisma.auditLog.findMany({
        where: { action: AuditAction.PASSWORD_CHANGED },
        orderBy: { createdAt: 'desc' },
        take: 1,
      });
      expect(changedRows).toHaveLength(1);
      assertAuditRowHasNoSecrets(changedRows[0]);
      const serialized = JSON.stringify(changedRows[0]);
      expect(serialized).not.toContain(E2E_ADMIN_ACTIVE_PASSWORD);
      expect(serialized).not.toContain(E2E_ADMIN_SEED_PASSWORD);

      const fresh = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_ACTIVE_PASSWORD,
      );
      expect(fresh.body.mustChangePassword).toBe(false);

      const usersResponse = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Cookie', fresh.cookie);
      // ADMIN + mustChangePassword false: RolesGuard ya no lo detiene.
      expect(usersResponse.status).toBe(200);
    });
  });

  describe('POST /auth/logout', () => {
    it('elimina la cookie de sesión', async () => {
      const { cookie } = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_ACTIVE_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', cookie);

      expect(response.status).toBe(204);
      const setCookie = (response.headers['set-cookie'] ?? []) as string[];
      expect(setCookie[0]).toContain('demosystem_session=;');
    });
  });
});
