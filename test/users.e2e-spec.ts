import { ConflictException, INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName, UserStatus } from '@prisma/client';
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
    // Fase 12E: limpia exactamente el usuario propio creado por el test de
    // POST /users (createdUserId), nunca visto antes de esta ronda — era
    // exactamente el leak "e2e_created_${Date.now()}" identificado en la
    // Fase 12A. Guarda explícita (nunca un deleteMany sin condición): si el
    // test que lo crea no llegó a ejecutarse, createdUserId permanece
    // undefined y no se toca la tabla.
    if (createdUserId) {
      await prisma.user.deleteMany({ where: { id: createdUserId } });
    }
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

  describe('GET /users/lookup (R3-B1)', () => {
    const LOOKUP_KEYS = [
      'firstName',
      'id',
      'lastName',
      'status',
      'username',
    ].sort();
    const MANAGEMENT_USERNAME = 'e2e_lookup_management';
    const MANAGEMENT_PASSWORD = 'LookupManagement123';
    const WAREHOUSE_USERNAME = 'e2e_lookup_warehouse';
    const WAREHOUSE_PASSWORD = 'LookupWarehouse123';
    const MULTIROLE_USERNAME = 'e2e_lookup_multirole';
    const MULTIROLE_PASSWORD = 'LookupMultiRole123';
    const INACTIVE_USERNAME = 'e2e_lookup_inactive';
    const BLOCKED_USERNAME = 'e2e_lookup_blocked';

    interface LookupItemBody {
      id: string;
      username: string;
      firstName: string;
      lastName: string;
      status: UserStatus;
    }

    let sellerCookie: string;
    let managementCookie: string;
    let warehouseCookie: string;
    let inactiveUserId: string;
    let blockedUserId: string;

    async function loginOrThrow(
      username: string,
      password: string,
    ): Promise<string> {
      const result = await login(app.getHttpServer(), username, password);
      if (result.status !== 200) {
        throw new Error(
          `No se pudo autenticar a ${username}: ${JSON.stringify(result.body)}`,
        );
      }
      return result.cookie;
    }

    function getLookup(cookie?: string): request.Test {
      const req = request(app.getHttpServer()).get('/api/v1/users/lookup');
      return cookie === undefined ? req : req.set('Cookie', cookie);
    }

    beforeAll(async () => {
      await upsertFixtureUser(prisma, {
        username: MANAGEMENT_USERNAME,
        email: 'e2e_lookup_management@demosystem.test',
        password: MANAGEMENT_PASSWORD,
        roleName: RoleName.MANAGEMENT,
      });
      await upsertFixtureUser(prisma, {
        username: WAREHOUSE_USERNAME,
        email: 'e2e_lookup_warehouse@demosystem.test',
        password: WAREHOUSE_PASSWORD,
        roleName: RoleName.WAREHOUSE,
      });
      const inactive = await upsertFixtureUser(prisma, {
        username: INACTIVE_USERNAME,
        email: 'e2e_lookup_inactive@demosystem.test',
        firstName: 'Histórico',
        lastName: 'Inactivo',
        password: 'LookupInactive123',
        roleName: RoleName.SELLER,
        status: UserStatus.INACTIVE,
      });
      inactiveUserId = inactive.id;
      const blocked = await upsertFixtureUser(prisma, {
        username: BLOCKED_USERNAME,
        email: 'e2e_lookup_blocked@demosystem.test',
        firstName: 'Histórico',
        lastName: 'Bloqueado',
        password: 'LookupBlocked123',
        roleName: RoleName.SELLER,
        status: UserStatus.BLOCKED,
        blockedAt: new Date(),
      });
      blockedUserId = blocked.id;

      // Usuario con dos roles asignados (WAREHOUSE + SELLER), para verificar
      // que la autorización se evalúa contra el rol ACTIVO de la sesión.
      const multiRole = await upsertFixtureUser(prisma, {
        username: MULTIROLE_USERNAME,
        email: 'e2e_lookup_multirole@demosystem.test',
        password: MULTIROLE_PASSWORD,
        roleName: RoleName.WAREHOUSE,
      });
      const sellerRole = await prisma.role.findUniqueOrThrow({
        where: { name: RoleName.SELLER },
      });
      await prisma.userRole.create({
        data: { userId: multiRole.id, roleId: sellerRole.id },
      });

      sellerCookie = await loginOrThrow(SELLER_USERNAME, SELLER_PASSWORD);
      managementCookie = await loginOrThrow(
        MANAGEMENT_USERNAME,
        MANAGEMENT_PASSWORD,
      );
      warehouseCookie = await loginOrThrow(
        WAREHOUSE_USERNAME,
        WAREHOUSE_PASSWORD,
      );
    });

    it.each([
      ['ADMIN', () => adminCookie],
      ['SELLER', () => sellerCookie],
      ['MANAGEMENT', () => managementCookie],
    ])('%s responde 200 con un arreglo', async (_role, cookieOf) => {
      const response = await getLookup(cookieOf());

      expect(response.status).toBe(200);
      expect(Array.isArray(response.body)).toBe(true);
    });

    it('WAREHOUSE responde 403', async () => {
      const response = await getLookup(warehouseCookie);
      expect(response.status).toBe(403);
    });

    it('sin cookie responde 401', async () => {
      const response = await getLookup();
      expect(response.status).toBe(401);
    });

    it('"lookup" no se resuelve como :id (nunca 400 de ParseUUIDPipe)', async () => {
      const response = await getLookup(adminCookie);
      expect(response.status).not.toBe(400);
      expect(response.status).toBe(200);
    });

    it('cada elemento expone exactamente id/username/firstName/lastName/status, sin datos sensibles', async () => {
      const response = await getLookup(sellerCookie);
      const body = response.body as LookupItemBody[];

      expect(body.length).toBeGreaterThan(0);
      for (const item of body) {
        expect(Object.keys(item).sort()).toEqual(LOOKUP_KEYS);
      }
      const serialized = JSON.stringify(response.body);
      expect(serialized).not.toContain('passwordHash');
      expect(serialized).not.toContain('email');
      expect(serialized).not.toContain('roles');
      expect(serialized).not.toContain('failedLoginAttempts');
      expect(serialized).not.toContain('blockedAt');
      expect(serialized).not.toContain('@demosystem');
    });

    it('incluye usuarios históricos INACTIVE y BLOCKED con su estado real', async () => {
      const response = await getLookup(sellerCookie);
      const body = response.body as LookupItemBody[];

      expect(body.find((item) => item.id === inactiveUserId)).toEqual({
        id: inactiveUserId,
        username: INACTIVE_USERNAME,
        firstName: 'Histórico',
        lastName: 'Inactivo',
        status: UserStatus.INACTIVE,
      });
      expect(body.find((item) => item.id === blockedUserId)).toEqual({
        id: blockedUserId,
        username: BLOCKED_USERNAME,
        firstName: 'Histórico',
        lastName: 'Bloqueado',
        status: UserStatus.BLOCKED,
      });
    });

    it('no modifica a los usuarios históricos (lectura pura)', async () => {
      await getLookup(adminCookie);

      const rows = await prisma.user.findMany({
        where: { id: { in: [inactiveUserId, blockedUserId] } },
        select: { id: true, status: true },
      });
      expect(rows).toEqual(
        expect.arrayContaining([
          { id: inactiveUserId, status: UserStatus.INACTIVE },
          { id: blockedUserId, status: UserStatus.BLOCKED },
        ]),
      );
    });

    it('orden determinista firstName, lastName, username, id', async () => {
      const response = await getLookup(adminCookie);
      const body = response.body as LookupItemBody[];

      const expected = await prisma.user.findMany({
        select: { id: true },
        orderBy: [
          { firstName: 'asc' },
          { lastName: 'asc' },
          { username: 'asc' },
          { id: 'asc' },
        ],
      });
      expect(body.map((item) => item.id)).toEqual(
        expected.map((row) => row.id),
      );
    });

    it('se evalúa contra el rol ACTIVO: un usuario SELLER+WAREHOUSE obtiene 200 como SELLER y 403 como WAREHOUSE', async () => {
      const cookie = await loginOrThrow(MULTIROLE_USERNAME, MULTIROLE_PASSWORD);

      const asSeller = await getLookup(cookie);
      expect(asSeller.status).toBe(200);

      const switchToWarehouse = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-role')
        .set('Cookie', cookie)
        .send({ role: RoleName.WAREHOUSE });
      expect(switchToWarehouse.status).toBe(200);
      // Mismo criterio de extracción que test/helpers/http.ts#login().
      const setCookie = (switchToWarehouse.headers['set-cookie'] ??
        []) as unknown as string[];
      const warehouseSessionCookie = (setCookie[0] ?? '').split(';')[0] ?? '';
      expect(warehouseSessionCookie.length).toBeGreaterThan(0);

      const asWarehouse = await getLookup(warehouseSessionCookie);
      expect(asWarehouse.status).toBe(403);
    });

    describe('GET /users (administración) sigue siendo exclusivo de ADMIN', () => {
      it('SELLER → 403', async () => {
        const response = await request(app.getHttpServer())
          .get('/api/v1/users')
          .set('Cookie', sellerCookie);
        expect(response.status).toBe(403);
      });

      it('MANAGEMENT → 403', async () => {
        const response = await request(app.getHttpServer())
          .get('/api/v1/users')
          .set('Cookie', managementCookie);
        expect(response.status).toBe(403);
      });

      it('ADMIN → 200 paginado, comportamiento sin cambios', async () => {
        const response = await request(app.getHttpServer())
          .get('/api/v1/users')
          .set('Cookie', adminCookie);
        expect(response.status).toBe(200);
        expect(Object.keys(response.body as object).sort()).toEqual(
          ['data', 'limit', 'page', 'total', 'totalPages'].sort(),
        );
      });

      it('MANAGEMENT → GET /users/:id sigue siendo 403', async () => {
        const response = await request(app.getHttpServer())
          .get(`/api/v1/users/${inactiveUserId}`)
          .set('Cookie', managementCookie);
        expect(response.status).toBe(403);
      });
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
