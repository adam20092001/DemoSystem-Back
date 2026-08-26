import { ConflictException, INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { UsersService } from '../src/users/users.service';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { ensureActiveTestAdmin, upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

const SELLER_USERNAME = 'e2e_seller_readonly';
const SELLER_PASSWORD = 'SellerReadonly123';
const NON_EXISTENT_UUID = '00000000-0000-0000-0000-000000000000';

interface SafeUserBody {
  id: string;
  username: string;
  email: string;
  roles: RoleName[];
  status: string;
  mustChangePassword: boolean;
}

describe('Users (e2e)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let adminCookie: string;
  let createdUserId: string;
  let createdUsername: string;

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    // Garantiza un ADMIN activo (no pendiente) sin depender de qué haya
    // dejado otro archivo o ejecución anterior.
    await ensureActiveTestAdmin(prisma);
    await upsertFixtureUser(prisma, {
      username: SELLER_USERNAME,
      email: 'e2e_seller_readonly@demosystem.test',
      password: SELLER_PASSWORD,
      roleName: RoleName.SELLER,
    });

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
  });

  afterAll(async () => {
    await app.close();
    await prisma.$disconnect();
  });

  describe('autorización por rol', () => {
    it('SELLER accediendo a /users responde 403', async () => {
      const sellerLogin = await login(
        app.getHttpServer(),
        SELLER_USERNAME,
        SELLER_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Cookie', sellerLogin.cookie);

      expect(response.status).toBe(403);
    });

    it('sin cookie responde 401', async () => {
      const response = await request(app.getHttpServer()).get('/api/v1/users');
      expect(response.status).toBe(401);
    });
  });

  describe('GET /users', () => {
    it('ADMIN lista usuarios de forma paginada', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/users')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      const body = response.body as {
        data: unknown[];
        page: number;
        limit: number;
        total: number;
        totalPages: number;
      };
      expect(typeof body.page).toBe('number');
      expect(typeof body.limit).toBe('number');
      expect(typeof body.total).toBe('number');
      expect(typeof body.totalPages).toBe('number');
      expect(Array.isArray(body.data)).toBe(true);
      expect(JSON.stringify(response.body)).not.toContain('passwordHash');
    });
  });

  describe('POST /users', () => {
    it('crea un usuario correctamente (201) y no expone passwordHash', async () => {
      createdUsername = `e2e_created_${Date.now()}`;
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({
          firstName: 'Usuario',
          lastName: 'Creado',
          username: createdUsername,
          email: `${createdUsername}@demosystem.test`,
          temporaryPassword: 'TemporalCreado123',
          roleNames: [RoleName.WAREHOUSE],
        });

      expect(response.status).toBe(201);
      const body = response.body as SafeUserBody;
      expect(body.username).toBe(createdUsername.toLowerCase());
      expect(body.roles).toEqual([RoleName.WAREHOUSE]);
      expect(body.mustChangePassword).toBe(true);
      expect(response.body).not.toHaveProperty('passwordHash');
      expect(response.body).not.toHaveProperty('roleId');
      expect(response.body).not.toHaveProperty('failedLoginAttempts');
      createdUserId = body.id;

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.USER_CREATED, entityId: createdUserId },
      });
      expect(rows).toHaveLength(1);
      const serialized = JSON.stringify(rows[0]).toLowerCase();
      expect(serialized).not.toContain('temporalcreado123');
    });

    it('username duplicado responde 409', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({
          firstName: 'Otro',
          lastName: 'Usuario',
          username: createdUsername,
          email: `distinto-${Date.now()}@demosystem.test`,
          temporaryPassword: 'OtraTemporal123',
          roleNames: [RoleName.SELLER],
        });

      expect(response.status).toBe(409);
    });

    it('email duplicado responde 409', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({
          firstName: 'Otro',
          lastName: 'Usuario',
          username: `distinto_${Date.now()}`,
          email: `${createdUsername}@demosystem.test`,
          temporaryPassword: 'OtraTemporal123',
          roleNames: [RoleName.SELLER],
        });

      expect(response.status).toBe(409);
    });

    it('rechaza propiedades no declaradas (whitelist del ValidationPipe)', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/users')
        .set('Cookie', adminCookie)
        .send({
          firstName: 'Con',
          lastName: 'Extra',
          username: `extra_${Date.now()}`,
          email: `extra_${Date.now()}@demosystem.test`,
          temporaryPassword: 'TemporalExtra123',
          roleNames: [RoleName.SELLER],
          roleId: 'algo-no-permitido',
        });

      expect(response.status).toBe(400);
    });
  });

  describe('GET /users/:id', () => {
    it('devuelve el detalle por UUID (200)', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/users/${createdUserId}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      expect((response.body as SafeUserBody).id).toBe(createdUserId);
    });

    it('UUID inválido responde 400', async () => {
      const response = await request(app.getHttpServer())
        .get('/api/v1/users/no-es-un-uuid')
        .set('Cookie', adminCookie);

      expect(response.status).toBe(400);
    });

    it('usuario inexistente responde 404', async () => {
      const response = await request(app.getHttpServer())
        .get(`/api/v1/users/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });
  });

  describe('PATCH /users/:id', () => {
    it('edita correctamente (200) y registra USER_UPDATED', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/users/${createdUserId}`)
        .set('Cookie', adminCookie)
        .send({ firstName: 'Usuario Editado' });

      expect(response.status).toBe(200);
      expect(
        (response.body as SafeUserBody & { firstName: string }).firstName,
      ).toBe('Usuario Editado');

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.USER_UPDATED, entityId: createdUserId },
      });
      expect(rows.length).toBeGreaterThanOrEqual(1);
    });

    it('update vacío responde 400', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/users/${createdUserId}`)
        .set('Cookie', adminCookie)
        .send({});

      expect(response.status).toBe(400);
    });

    it('usuario inexistente responde 404', async () => {
      const response = await request(app.getHttpServer())
        .patch(`/api/v1/users/${NON_EXISTENT_UUID}`)
        .set('Cookie', adminCookie)
        .send({ firstName: 'No importa' });

      expect(response.status).toBe(404);
    });

    it('el único ADMIN activo no puede cambiar su propio rol (409) y no queda ningún rastro de la operación', async () => {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      });

      const auditBefore = await prisma.auditLog.count({
        where: { action: AuditAction.USER_UPDATED, entityId: admin.id },
      });

      const response = await request(app.getHttpServer())
        .patch(`/api/v1/users/${admin.id}`)
        .set('Cookie', adminCookie)
        .send({ roleNames: [RoleName.SELLER] });

      expect(response.status).toBe(409);

      const refreshed = await prisma.user.findUniqueOrThrow({
        where: { id: admin.id },
        select: {
          roles: { select: { role: { select: { name: true } } } },
          updatedAt: true,
        },
      });
      expect(refreshed.roles.map((r) => r.role.name)).toEqual([RoleName.ADMIN]);
      expect(refreshed.updatedAt.getTime()).toBe(admin.updatedAt.getTime());

      const activeAdmins = await prisma.user.count({
        where: {
          roles: { some: { role: { name: RoleName.ADMIN } } },
          status: 'ACTIVE',
        },
      });
      expect(activeAdmins).toBe(1);

      const auditAfter = await prisma.auditLog.count({
        where: { action: AuditAction.USER_UPDATED, entityId: admin.id },
      });
      expect(auditAfter).toBe(auditBefore);
    });
  });

  describe('bloqueo y desbloqueo', () => {
    it('bloquea correctamente (200) y registra USER_BLOCKED', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${createdUserId}/block`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      expect((response.body as SafeUserBody).status).toBe('BLOCKED');

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.USER_BLOCKED, entityId: createdUserId },
      });
      expect(rows).toHaveLength(1);
    });

    it('autobloqueo responde 400', async () => {
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      });

      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${admin.id}/block`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(400);
    });

    /**
     * La protección del último ADMIN activo exige un actor ADMIN distinto
     * del objetivo (el autobloqueo se atrapa antes, con 400). Como en este
     * entorno de prueba solo existe un ADMIN real, no hay una combinación de
     * petición HTTP que la ejercite sin crear un segundo administrador
     * permanente que rompería esta misma regla para otras pruebas. Se cubre
     * aquí como integración real contra PostgreSQL, invocando el servicio
     * directamente (sin mocks), tal como ya lo hace la prueba unitaria del
     * Bloque B pero aquí con la base de datos real.
     */
    it('protección del único ADMIN activo responde 409 (integración real, sin mocks)', async () => {
      const usersService = app.get(UsersService);
      const admin = await prisma.user.findUniqueOrThrow({
        where: { username: E2E_ADMIN_USERNAME },
      });

      await expect(
        usersService.blockUser({
          targetUserId: admin.id,
          // Actor arbitrario: la regla se basa en el rol/estado del target,
          // no en la identidad del actor.
          actorUserId: NON_EXISTENT_UUID,
        }),
      ).rejects.toThrow(ConflictException);

      const refreshed = await prisma.user.findUniqueOrThrow({
        where: { id: admin.id },
      });
      expect(refreshed.status).toBe('ACTIVE');
    });

    it('desbloquea correctamente (200) y registra USER_UNBLOCKED', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${createdUserId}/unblock`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      expect((response.body as SafeUserBody).status).toBe('ACTIVE');

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.USER_UNBLOCKED, entityId: createdUserId },
      });
      expect(rows).toHaveLength(1);
    });
  });

  describe('POST /users/:id/reset-password', () => {
    it('genera una contraseña temporal (200), la devuelve una única vez y no la audita', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${createdUserId}/reset-password`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(200);
      const body = response.body as {
        user: SafeUserBody;
        temporaryPassword: string;
      };
      expect(typeof body.temporaryPassword).toBe('string');
      expect(body.temporaryPassword.length).toBeGreaterThanOrEqual(16);
      expect(body.user).not.toHaveProperty('passwordHash');
      expect(JSON.stringify(body.user)).not.toContain(body.temporaryPassword);

      const rows = await prisma.auditLog.findMany({
        where: { action: AuditAction.PASSWORD_RESET, entityId: createdUserId },
      });
      expect(rows).toHaveLength(1);
      assertAuditRowHasNoSecrets(rows[0]);
      expect(JSON.stringify(rows[0])).not.toContain(body.temporaryPassword);

      // La contraseña temporal es real: permite iniciar sesión.
      const loginResult = await login(
        app.getHttpServer(),
        createdUsername,
        body.temporaryPassword,
      );
      expect(loginResult.status).toBe(200);
      expect(loginResult.body.mustChangePassword).toBe(true);
    });

    it('usuario inexistente responde 404', async () => {
      const response = await request(app.getHttpServer())
        .post(`/api/v1/users/${NON_EXISTENT_UUID}/reset-password`)
        .set('Cookie', adminCookie);

      expect(response.status).toBe(404);
    });
  });

  describe('auditoría de acciones de usuarios: sin secretos', () => {
    it('ningún registro de audit_logs relacionado con este archivo contiene claves sensibles', async () => {
      const rows = await prisma.auditLog.findMany({
        where: { entityId: createdUserId },
      });
      expect(rows.length).toBeGreaterThan(0);

      for (const row of rows) {
        assertAuditRowHasNoSecrets(row);
      }
    });
  });
});
