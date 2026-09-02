import { INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName, UserStatus } from '@prisma/client';
import request from 'supertest';
import { App } from 'supertest/types';
import { AuditAction } from '../src/audit/audit-action.enum';
import { hashPassword } from '../src/common/security/password.service';
import { assertAuditRowHasNoSecrets } from './helpers/audit-assertions';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_USERNAME,
} from './helpers/constants';
import { createE2eApp } from './helpers/e2e-app';
import { upsertFixtureUser } from './helpers/fixtures';
import { login } from './helpers/http';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * KAN-18, Bloque B — POST /auth/switch-role. Suite dedicada (no se extiende
 * auth.e2e-spec.ts): el comportamiento multi-sesión/multi-cookie merece
 * aislamiento propio.
 *
 * Fixtures multi-rol: `upsertFixtureUser()` (test/helpers/fixtures.ts) se
 * mantiene deliberadamente de un solo rol (contrato externo cerrado del
 * Bloque A) — este archivo define su PROPIO creador local de usuarios
 * multi-rol (`upsertMultiRoleFixtureUser`), nunca modifica ese helper
 * compartido. Limpieza exacta de las filas propias en `afterAll`
 * (`prisma.user.deleteMany({ where: { id: { in: [...] } } })`), nunca un
 * `deleteMany({})` global. El usuario MANAGEMENT reutiliza el mismo
 * username/password que configuration.e2e-spec.ts/audit.e2e-spec.ts
 * (fixture compartida idempotente vía upsertFixtureUser).
 *
 * Aislamiento de auditoría (remediación final de Bloque B): cada ejecución
 * exitosa de esta suite BORRA sus usuarios propios al final (`afterAll`),
 * así que `multiRoleUserId`/`revokeUserId`/`pendingPasswordUserId` son un
 * UUID recién generado en cada corrida — nunca compartido con ninguna otra
 * suite ni con una ejecución anterior de esta misma (salvo que una corrida
 * previa haya terminado en crash sin llegar a su `afterAll`, en cuyo caso
 * el username persiste con su id anterior y esta corrida lo reutiliza,
 * arrastrando también sus filas de auditoría pendientes de limpiar — un
 * caso que la limpieza de abajo repara igual, en vez de dejarlas huérfanas
 * para siempre). Por eso resolver TODO AuditLog por
 * `entityId IN (multiRoleUserId, revokeUserId, pendingPasswordUserId)`
 * identifica exactamente y solo los eventos que esta suite generó
 * (ACTIVE_ROLE_SWITCHED y LOGIN_SUCCESS de sus propios `login()`), sin
 * fecha/rango ambiguo, sin filtrar por acción, y sin tocar el historial de
 * ninguna otra suite o usuario.
 *
 * Los dos únicos `login()` de esta suite contra usuarios COMPARTIDOS
 * (E2E_ADMIN_USERNAME, MANAGEMENT_USERNAME — §42) NO son propiedad
 * exclusiva de esta suite: muchos otros archivos e2e también generan
 * LOGIN_SUCCESS para esos mismos usuarios. Para esos dos casos se captura,
 * inmediatamente después del login, el id exacto de la fila LOGIN_SUCCESS
 * recién creada (la más reciente para ese userId en ese instante) — nunca
 * se borra el historial completo de esos usuarios compartidos.
 */

const MULTI_ROLE_USERNAME = 'e2e_multirole_admin_seller';
const MULTI_ROLE_PASSWORD = 'MultiRoleSwitch123';
const REVOKE_USERNAME = 'e2e_multirole_revoke';
const REVOKE_PASSWORD = 'MultiRoleRevoke123';
const PENDING_PASSWORD_USERNAME = 'e2e_multirole_pending_password';
const PENDING_PASSWORD_PASSWORD = 'MultiRolePending123';
const MANAGEMENT_USERNAME = 'e2e_management_configuration';
const MANAGEMENT_PASSWORD = 'ManagementConfig123';

interface SessionBody {
  id: string;
  roles: RoleName[];
  activeRole: RoleName;
  mustChangePassword: boolean;
}

interface MeBody {
  role: RoleName;
}

/**
 * Creador local de usuarios multi-rol, exclusivo de este archivo. Mismo
 * patrón interno que upsertFixtureUser() (upsert por username + reemplazo
 * total de UserRole), generalizado a N roles simultáneos.
 */
async function upsertMultiRoleFixtureUser(
  prisma: PrismaClient,
  input: {
    username: string;
    email: string;
    password: string;
    roleNames: RoleName[];
    mustChangePassword?: boolean;
  },
): Promise<{ id: string }> {
  const roles = await prisma.role.findMany({
    where: { name: { in: input.roleNames } },
  });
  if (roles.length !== input.roleNames.length) {
    throw new Error(
      `upsertMultiRoleFixtureUser: rol(es) no encontrados entre ${input.roleNames.join(', ')}`,
    );
  }
  const passwordHash = await hashPassword(input.password);
  const data = {
    email: input.email,
    firstName: 'E2E',
    lastName: 'MultiRole',
    passwordHash,
    status: UserStatus.ACTIVE,
    mustChangePassword: input.mustChangePassword ?? false,
    failedLoginAttempts: 0,
    blockedAt: null,
  };
  const user = await prisma.user.upsert({
    where: { username: input.username },
    create: { username: input.username, ...data },
    update: data,
  });
  await prisma.userRole.deleteMany({ where: { userId: user.id } });
  await prisma.userRole.createMany({
    data: roles.map((role) => ({ userId: user.id, roleId: role.id })),
  });
  return user;
}

/** Mismo criterio de extracción que test/helpers/http.ts#login(). */
function extractCookie(response: request.Response): string {
  const setCookie = (response.headers['set-cookie'] ??
    []) as unknown as string[];
  const setCookieHeader = setCookie[0] ?? '';
  return setCookieHeader.split(';')[0] ?? '';
}

async function switchRole(
  app: INestApplication<App>,
  cookie: string,
  role: RoleName,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/api/v1/auth/switch-role')
    .set('Cookie', cookie)
    .send({ role });
}

async function getMe(
  app: INestApplication<App>,
  cookie: string,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .get('/api/v1/auth/me')
    .set('Cookie', cookie);
}

async function getConfiguration(
  app: INestApplication<App>,
  cookie: string,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .get('/api/v1/configuration')
    .set('Cookie', cookie);
}

/** Ticket A post-MVP: surface de solo lectura para POS (ADMIN/MANAGEMENT/SELLER). */
async function getPosConfiguration(
  app: INestApplication<App>,
  cookie: string,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .get('/api/v1/configuration/pos')
    .set('Cookie', cookie);
}

async function patchConfiguration(
  app: INestApplication<App>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .patch('/api/v1/configuration')
    .set('Cookie', cookie)
    .send(body);
}

/** Ticket C post-MVP, Bloque C2: lista de métodos de pago (activos por defecto). */
async function getPaymentMethods(
  app: INestApplication<App>,
  cookie: string,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .get('/api/v1/payment-methods')
    .set('Cookie', cookie);
}

async function postPaymentMethod(
  app: INestApplication<App>,
  cookie: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .post('/api/v1/payment-methods')
    .set('Cookie', cookie)
    .send(body);
}

async function patchPaymentMethod(
  app: INestApplication<App>,
  cookie: string,
  id: string,
  body: Record<string, unknown>,
): Promise<request.Response> {
  return request(app.getHttpServer())
    .patch(`/api/v1/payment-methods/${id}`)
    .set('Cookie', cookie)
    .send(body);
}

/**
 * Resuelve el id EXACTO de la fila LOGIN_SUCCESS más reciente para un
 * usuario COMPARTIDO (no propiedad exclusiva de esta suite) — usado
 * inmediatamente después de un `login()` contra ese usuario, cuando ningún
 * otro proceso puede haber generado un LOGIN_SUCCESS más nuevo para ese
 * mismo userId en el mismo instante. Nunca borra ni toca el resto del
 * historial de ese usuario.
 */
async function resolveLatestLoginSuccessId(
  prisma: PrismaClient,
  userId: string,
): Promise<string> {
  const row = await prisma.auditLog.findFirstOrThrow({
    where: { action: AuditAction.LOGIN_SUCCESS, userId },
    orderBy: { createdAt: 'desc' },
  });
  return row.id;
}

describe('Auth multi-rol — switch-role (KAN-18, Bloque B)', () => {
  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let multiRoleUserId: string;
  let revokeUserId: string;
  let pendingPasswordUserId: string;
  /**
   * Ticket C post-MVP, Bloque C2: id propio del ÚNICO PaymentMethod
   * personalizado que la regresión de rol activo crea (nunca uno de los 9
   * baseline). Eliminado por su ID exacto en afterAll, nunca
   * deleteMany({}) sobre payment_methods.
   */
  let paymentMethodOwnedId: string | undefined;
  /**
   * Conteos GLOBALES (todas las entidades/usuarios, incluido historial ajeno
   * a esta suite) al arrancar. La única aserción de aislamiento final es que
   * estos números no cambien una vez limpiadas las filas propias — nunca se
   * asume que el conteo global deba ser cero.
   */
  let globalSwitchAuditBaselineCount: number;
  let globalLoginSuccessBaselineCount: number;
  /**
   * IDs exactos de AuditLog propiedad de esta suite, resueltos de dos formas
   * (ver comentario de cabecera): (a) capturados en el momento para los dos
   * `login()` contra usuarios COMPARTIDOS (§42); (b) resueltos en bloque en
   * `afterAll()` para los 3 usuarios de propiedad exclusiva de esta suite.
   * El único `deleteMany()` final borra únicamente `id IN ownedAuditLogIds`.
   */
  const ownedAuditLogIds: string[] = [];

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();

    globalSwitchAuditBaselineCount = await prisma.auditLog.count({
      where: { action: AuditAction.ACTIVE_ROLE_SWITCHED },
    });
    globalLoginSuccessBaselineCount = await prisma.auditLog.count({
      where: { action: AuditAction.LOGIN_SUCCESS },
    });

    const multiRoleUser = await upsertMultiRoleFixtureUser(prisma, {
      username: MULTI_ROLE_USERNAME,
      email: `${MULTI_ROLE_USERNAME}@demosystem.test`,
      password: MULTI_ROLE_PASSWORD,
      roleNames: [RoleName.SELLER, RoleName.ADMIN],
    });
    multiRoleUserId = multiRoleUser.id;

    const revokeUser = await upsertMultiRoleFixtureUser(prisma, {
      username: REVOKE_USERNAME,
      email: `${REVOKE_USERNAME}@demosystem.test`,
      password: REVOKE_PASSWORD,
      roleNames: [RoleName.SELLER, RoleName.ADMIN],
    });
    revokeUserId = revokeUser.id;

    const pendingUser = await upsertFixtureUser(prisma, {
      username: PENDING_PASSWORD_USERNAME,
      email: `${PENDING_PASSWORD_USERNAME}@demosystem.test`,
      password: PENDING_PASSWORD_PASSWORD,
      roleName: RoleName.SELLER,
      mustChangePassword: true,
    });
    pendingPasswordUserId = pendingUser.id;

    // Fixture MANAGEMENT compartida con configuration.e2e-spec.ts/
    // audit.e2e-spec.ts, reutilizada tal cual (idempotente).
    await upsertFixtureUser(prisma, {
      username: MANAGEMENT_USERNAME,
      email: 'e2e_management_configuration@demosystem.test',
      password: MANAGEMENT_PASSWORD,
      roleName: RoleName.MANAGEMENT,
    });
  });

  afterAll(async () => {
    // KAN-18, remediación final de Bloque B: se resuelven los IDs EXACTOS de
    // TODO AuditLog (cualquier acción — ACTIVE_ROLE_SWITCHED, LOGIN_SUCCESS,
    // y cualquier otra que llegara a existir) cuyo entityId pertenece a un
    // User de propiedad exclusiva de esta ejecución (ver comentario de
    // cabecera) — nunca por rango de fecha, nunca filtrando solo por acción,
    // nunca por un deleteMany({}) global sobre audit_logs.
    const ownedFixtureUserIds = [
      multiRoleUserId,
      revokeUserId,
      pendingPasswordUserId,
    ];
    const ownedFixtureAuditRows = await prisma.auditLog.findMany({
      where: { entityId: { in: ownedFixtureUserIds } },
      select: { id: true },
    });
    ownedAuditLogIds.push(...ownedFixtureAuditRows.map((row) => row.id));

    // Ticket C, Bloque C2: auditoría PAYMENT_METHOD_* del único método
    // personalizado propio de esta suite (entityId distinto de cualquier
    // userId, así que el barrido de arriba no lo cubre).
    if (paymentMethodOwnedId !== undefined) {
      const ownedPaymentMethodAuditRows = await prisma.auditLog.findMany({
        where: { entityId: paymentMethodOwnedId },
        select: { id: true },
      });
      ownedAuditLogIds.push(
        ...ownedPaymentMethodAuditRows.map((row) => row.id),
      );
    }

    // Deduplicado defensivo: los dos ids capturados en §42 (login compartido
    // de ADMIN/MANAGEMENT) nunca deberían coincidir con los de arriba (son
    // usuarios distintos), pero un Set evita cualquier doble-conteo si algo
    // cambiara en el futuro.
    const uniqueOwnedAuditLogIds = [...new Set(ownedAuditLogIds)];

    // La auditoría se limpia ANTES que los Users a propósito: AuditLog.userId
    // (el actor) es una FK con onDelete: SetNull sobre User — borrar primero
    // al usuario dejaría estas mismas filas con userId=null antes de poder
    // resolverlas con confianza por entityId. AuditLog.entityId en cambio es
    // texto plano (nunca FK), así que de todos modos sobrevive intacto.
    await prisma.auditLog.deleteMany({
      where: { id: { in: uniqueOwnedAuditLogIds } },
    });

    // Aserción de aislamiento: ninguna fila propia sobrevive, y los conteos
    // GLOBALES (que incluyen historial ajeno a esta suite, entre ellos el
    // propio LOGIN_SUCCESS histórico de E2E_ADMIN_USERNAME/MANAGEMENT_USERNAME)
    // vuelven exactamente al valor con el que arrancó esta ejecución.
    const survivingOwnedRows = await prisma.auditLog.count({
      where: { id: { in: uniqueOwnedAuditLogIds } },
    });
    expect(survivingOwnedRows).toBe(0);

    const finalGlobalSwitchAuditCount = await prisma.auditLog.count({
      where: { action: AuditAction.ACTIVE_ROLE_SWITCHED },
    });
    expect(finalGlobalSwitchAuditCount).toBe(globalSwitchAuditBaselineCount);

    const finalGlobalLoginSuccessCount = await prisma.auditLog.count({
      where: { action: AuditAction.LOGIN_SUCCESS },
    });
    expect(finalGlobalLoginSuccessCount).toBe(globalLoginSuccessBaselineCount);

    // Limpieza exacta de las filas propias de este archivo únicamente
    // (cascade elimina sus UserRole); el usuario MANAGEMENT compartido NO
    // se borra (pertenece a otras suites). Nunca deleteMany({}) global.
    await prisma.user.deleteMany({
      where: { id: { in: ownedFixtureUserIds } },
    });

    // Ticket C, Bloque C2: eliminación física del único PaymentMethod
    // personalizado propio de esta suite, por su ID exacto — nunca uno de
    // los 9 baseline, nunca deleteMany({}) sobre payment_methods.
    if (paymentMethodOwnedId !== undefined) {
      await prisma.paymentMethodDefinition.delete({
        where: { id: paymentMethodOwnedId },
      });
    }

    await app.close();
    await prisma.$disconnect();
  });

  describe('§32 — login por defecto con múltiples roles asignados', () => {
    it('roles contiene ADMIN y SELLER; activeRole es SELLER (orden cerrado)', async () => {
      const result = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );

      expect(result.status).toBe(200);
      const body = result.body as unknown as SessionBody;
      expect(body.roles).toEqual(
        expect.arrayContaining([RoleName.ADMIN, RoleName.SELLER]),
      );
      expect(body.activeRole).toBe(RoleName.SELLER);
    });
  });

  describe('§33 — switch-role exitoso', () => {
    it('SELLER -> ADMIN: 200, activeRole ADMIN, /auth/me lo confirma, y GET /configuration se vuelve accesible', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );

      const switchResponse = await switchRole(
        app,
        loginResult.cookie,
        RoleName.ADMIN,
      );
      expect(switchResponse.status).toBe(200);
      expect((switchResponse.body as SessionBody).activeRole).toBe(
        RoleName.ADMIN,
      );
      expect(JSON.stringify(switchResponse.body)).not.toMatch(/"token"/i);

      const newCookie = extractCookie(switchResponse);
      const meResponse = await getMe(app, newCookie);
      expect(meResponse.status).toBe(200);
      expect((meResponse.body as MeBody).role).toBe(RoleName.ADMIN);

      const configResponse = await getConfiguration(app, newCookie);
      expect(configResponse.status).toBe(200);
    });
  });

  describe('§34 — switch a un privilegio menor', () => {
    it('vuelta a SELLER: pierde acceso a GET /configuration (403) aunque el usuario conserve ADMIN asignado', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      const toAdmin = await switchRole(app, loginResult.cookie, RoleName.ADMIN);
      const adminCookie = extractCookie(toAdmin);

      const backToSeller = await switchRole(app, adminCookie, RoleName.SELLER);
      expect(backToSeller.status).toBe(200);
      const sellerCookie = extractCookie(backToSeller);

      const configResponse = await getConfiguration(app, sellerCookie);
      expect(configResponse.status).toBe(403);
    });
  });

  describe('§34.1 — GET /configuration/pos respeta el ROL ACTIVO (Ticket A post-MVP)', () => {
    it('activeRole SELLER: POS 200, administrativo GET/PATCH 403; switch a ADMIN: administrativo PATCH 200', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      // resolveDefaultActiveRole() (KAN-18, Bloque A: SELLER > WAREHOUSE >
      // MANAGEMENT > ADMIN) ya deja a este usuario [SELLER, ADMIN] con
      // activeRole=SELLER apenas hace login — un switch-role explícito a
      // SELLER aquí sería el no-op documentado (mismo rol ya activo, sin
      // token/cookie nuevos, ver AuthService.switchRole()), así que se
      // reutiliza directamente la cookie de sesión recién obtenida.
      const sellerCookie = loginResult.cookie;

      // activeRole SELLER: el recorte POS es accesible...
      const posAsSeller = await getPosConfiguration(app, sellerCookie);
      expect(posAsSeller.status).toBe(200);
      const posBody = posAsSeller.body as Record<string, unknown>;
      expect(Object.keys(posBody).sort()).toEqual(
        [
          'businessName',
          'tradeName',
          'taxId',
          'address',
          'currencyCode',
          'currencySymbol',
          'taxEnabled',
          'taxRate',
          'maxDiscountPercent',
        ].sort(),
      );

      // ...pero la configuración administrativa completa NO, ni siquiera de lectura.
      const configAsSeller = await getConfiguration(app, sellerCookie);
      expect(configAsSeller.status).toBe(403);

      // Ni de escritura: mismo usuario, mismo rol activo, PATCH sigue prohibido.
      const patchAsSeller = await patchConfiguration(app, sellerCookie, {
        businessName: 'Intento no autorizado desde SELLER',
      });
      expect(patchAsSeller.status).toBe(403);

      // Cambiar el rol activo a ADMIN (mismo usuario, mismo assigned roles)
      // habilita PATCH — se envía un no-op (mismo businessName ya vigente)
      // para no dejar ninguna fila CONFIGURATION_UPDATED que limpiar, mismo
      // criterio de residuo-cero que el resto de esta suite.
      const toAdmin = await switchRole(app, sellerCookie, RoleName.ADMIN);
      expect(toAdmin.status).toBe(200);
      const adminCookie = extractCookie(toAdmin);

      const currentConfig = await getConfiguration(app, adminCookie);
      expect(currentConfig.status).toBe(200);
      const currentBusinessName = (
        currentConfig.body as { businessName: string }
      ).businessName;

      const patchAsAdmin = await patchConfiguration(app, adminCookie, {
        businessName: currentBusinessName,
      });
      expect(patchAsAdmin.status).toBe(200);
    });
  });

  describe('§34.2 — /payment-methods respeta el ROL ACTIVO (Ticket C post-MVP, Bloque C2)', () => {
    it('activeRole SELLER: GET permitido, POST/PATCH prohibidos; switch a ADMIN: POST permitido', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      // Mismo criterio que §34.1: activeRole ya es SELLER apenas hace
      // login (resolveDefaultActiveRole), sin necesidad de un switch-role
      // explícito.
      const sellerCookie = loginResult.cookie;

      const listAsSeller = await getPaymentMethods(app, sellerCookie);
      expect(listAsSeller.status).toBe(200);

      const postAsSeller = await postPaymentMethod(app, sellerCookie, {
        code: 'MULTIROLE_NOPE',
        name: 'No debería crearse',
        requiresReference: false,
        affectsCashDrawer: false,
        accountingDestination: 'BANK',
      });
      expect(postAsSeller.status).toBe(403);

      const toAdmin = await switchRole(app, sellerCookie, RoleName.ADMIN);
      expect(toAdmin.status).toBe(200);
      const adminCookie = extractCookie(toAdmin);

      const postAsAdmin = await postPaymentMethod(app, adminCookie, {
        code: 'E2E_MULTIROLE_PM',
        name: 'Método multi-rol E2E',
        requiresReference: false,
        affectsCashDrawer: false,
        accountingDestination: 'BANK',
      });
      expect(postAsAdmin.status).toBe(201);
      paymentMethodOwnedId = (postAsAdmin.body as { id: string }).id;

      const patchAsAdmin = await patchPaymentMethod(
        app,
        adminCookie,
        paymentMethodOwnedId,
        { active: false },
      );
      expect(patchAsAdmin.status).toBe(200);
    });
  });

  describe('§35 — rol no asignado', () => {
    it('MANAGEMENT no asignado: 403, la sesión SELLER original sigue intacta, sin mutar UserRole ni auditar', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );

      const rolesBefore = await prisma.userRole.findMany({
        where: { userId: multiRoleUserId },
        select: { roleId: true },
      });
      const auditsBefore = await prisma.auditLog.count({
        where: {
          action: AuditAction.ACTIVE_ROLE_SWITCHED,
          entityId: multiRoleUserId,
        },
      });

      const response = await switchRole(
        app,
        loginResult.cookie,
        RoleName.MANAGEMENT,
      );
      expect(response.status).toBe(403);

      // La sesión original sigue usable, sin cambios.
      const meResponse = await getMe(app, loginResult.cookie);
      expect(meResponse.status).toBe(200);
      expect((meResponse.body as MeBody).role).toBe(RoleName.SELLER);

      const rolesAfter = await prisma.userRole.findMany({
        where: { userId: multiRoleUserId },
        select: { roleId: true },
      });
      expect(rolesAfter).toEqual(rolesBefore);

      const auditsAfter = await prisma.auditLog.count({
        where: {
          action: AuditAction.ACTIVE_ROLE_SWITCHED,
          entityId: multiRoleUserId,
        },
      });
      expect(auditsAfter).toBe(auditsBefore);
    });
  });

  describe('§36 — mismo rol activo (no-op)', () => {
    it('solicitar el rol ya activo: 200, sin nueva cookie, sin evento de auditoría', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      const auditsBefore = await prisma.auditLog.count({
        where: {
          action: AuditAction.ACTIVE_ROLE_SWITCHED,
          entityId: multiRoleUserId,
        },
      });

      const response = await switchRole(
        app,
        loginResult.cookie,
        RoleName.SELLER,
      );

      expect(response.status).toBe(200);
      expect((response.body as SessionBody).activeRole).toBe(RoleName.SELLER);
      expect(response.headers['set-cookie']).toBeUndefined();

      const auditsAfter = await prisma.auditLog.count({
        where: {
          action: AuditAction.ACTIVE_ROLE_SWITCHED,
          entityId: multiRoleUserId,
        },
      });
      expect(auditsAfter).toBe(auditsBefore);

      // La cookie original sigue siendo válida (nunca fue invalidada).
      const meResponse = await getMe(app, loginResult.cookie);
      expect(meResponse.status).toBe(200);
    });
  });

  describe('§37 — dos sesiones independientes', () => {
    it('cambiar el rol activo en una sesión no afecta a la otra', async () => {
      const sessionA = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      const sessionB = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      expect((sessionA.body as unknown as SessionBody).activeRole).toBe(
        RoleName.SELLER,
      );
      expect((sessionB.body as unknown as SessionBody).activeRole).toBe(
        RoleName.SELLER,
      );

      const switchA = await switchRole(app, sessionA.cookie, RoleName.ADMIN);
      expect(switchA.status).toBe(200);
      const cookieA = extractCookie(switchA);

      const meA = await getMe(app, cookieA);
      expect((meA.body as MeBody).role).toBe(RoleName.ADMIN);
      const meB = await getMe(app, sessionB.cookie);
      expect((meB.body as MeBody).role).toBe(RoleName.SELLER);

      const configA = await getConfiguration(app, cookieA);
      expect(configA.status).toBe(200);
      const configB = await getConfiguration(app, sessionB.cookie);
      expect(configB.status).toBe(403);
    });
  });

  describe('§38 — rol revocado tras el switch', () => {
    it('ADMIN revocado en vivo: la siguiente petición con esa sesión responde 401, sin fallback silencioso', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        REVOKE_USERNAME,
        REVOKE_PASSWORD,
      );
      const switchResponse = await switchRole(
        app,
        loginResult.cookie,
        RoleName.ADMIN,
      );
      expect(switchResponse.status).toBe(200);
      const adminCookie = extractCookie(switchResponse);

      // Confirma que la sesión ADMIN realmente funciona antes de revocar.
      const configBefore = await getConfiguration(app, adminCookie);
      expect(configBefore.status).toBe(200);

      // Revocación directa y propia (fixture de este archivo), nunca a
      // través de switch-role.
      const adminRole = await prisma.role.findUniqueOrThrow({
        where: { name: RoleName.ADMIN },
      });
      await prisma.userRole.deleteMany({
        where: { userId: revokeUserId, roleId: adminRole.id },
      });

      const meAfterRevoke = await getMe(app, adminCookie);
      expect(meAfterRevoke.status).toBe(401);
    });
  });

  describe('§39 — logout y login de nuevo', () => {
    it('el rol activo por defecto vuelve a ser SELLER: no se recuerda el switch anterior', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      expect((loginResult.body as unknown as SessionBody).activeRole).toBe(
        RoleName.SELLER,
      );

      const switchResponse = await switchRole(
        app,
        loginResult.cookie,
        RoleName.ADMIN,
      );
      const adminCookie = extractCookie(switchResponse);

      const logoutResponse = await request(app.getHttpServer())
        .post('/api/v1/auth/logout')
        .set('Cookie', adminCookie);
      expect(logoutResponse.status).toBe(204);

      const freshLogin = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      expect((freshLogin.body as unknown as SessionBody).activeRole).toBe(
        RoleName.SELLER,
      );
    });
  });

  describe('§40 — cambio de contraseña pendiente', () => {
    it('mustChangePassword=true: switch-role responde 403 (PasswordChangeGuard), no llega a AuthService', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        PENDING_PASSWORD_USERNAME,
        PENDING_PASSWORD_PASSWORD,
      );
      expect(loginResult.status).toBe(200);
      expect(
        (loginResult.body as unknown as SessionBody).mustChangePassword,
      ).toBe(true);

      const response = await switchRole(
        app,
        loginResult.cookie,
        RoleName.SELLER,
      );
      expect(response.status).toBe(403);
    });
  });

  describe('§41 — auditoría de un switch real', () => {
    it('genera exactamente un ACTIVE_ROLE_SWITCHED con module/entityType/entityId/metadata/ip correctos', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      const before = await prisma.auditLog.count({
        where: {
          action: AuditAction.ACTIVE_ROLE_SWITCHED,
          entityId: multiRoleUserId,
        },
      });

      const response = await switchRole(
        app,
        loginResult.cookie,
        RoleName.ADMIN,
      );
      expect(response.status).toBe(200);

      const rows = await prisma.auditLog.findMany({
        where: {
          action: AuditAction.ACTIVE_ROLE_SWITCHED,
          entityId: multiRoleUserId,
        },
        orderBy: { createdAt: 'desc' },
      });
      expect(rows).toHaveLength(before + 1);

      const row = rows[0];
      expect(row.module).toBe('AUTH');
      expect(row.entityType).toBe('User');
      expect(row.entityId).toBe(multiRoleUserId);
      expect(row.metadata).toEqual({
        fromRole: RoleName.SELLER,
        toRole: RoleName.ADMIN,
      });
      // Mismo convenio que LOGIN_SUCCESS/LOGIN_FAILED: se registra la IP de
      // la petición (ver AuthService.login()/switchRole()).
      expect(row.ipAddress).not.toBeNull();
      assertAuditRowHasNoSecrets(row);
    });
  });

  describe('§42 — regresión de lectura de auditoría (Bloque E)', () => {
    it('GET /audit?action=ACTIVE_ROLE_SWITCHED es aceptado; ADMIN lee el detalle con IP; MANAGEMENT sigue recibiendo ipAddress=null', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      const switchResponse = await switchRole(
        app,
        loginResult.cookie,
        RoleName.ADMIN,
      );
      expect(switchResponse.status).toBe(200);

      const row = await prisma.auditLog.findFirstOrThrow({
        where: {
          action: AuditAction.ACTIVE_ROLE_SWITCHED,
          entityId: multiRoleUserId,
        },
        orderBy: { createdAt: 'desc' },
      });

      const adminLogin = await login(
        app.getHttpServer(),
        E2E_ADMIN_USERNAME,
        E2E_ADMIN_ACTIVE_PASSWORD,
      );
      // E2E_ADMIN_USERNAME es compartido con casi toda la suite e2e: se
      // captura únicamente el id exacto del LOGIN_SUCCESS que ESTE login
      // acaba de crear, nunca se toca el resto de su historial.
      ownedAuditLogIds.push(
        await resolveLatestLoginSuccessId(
          prisma,
          (adminLogin.body as unknown as SessionBody).id,
        ),
      );

      const listResponse = await request(app.getHttpServer())
        .get('/api/v1/audit')
        .query({ action: AuditAction.ACTIVE_ROLE_SWITCHED })
        .set('Cookie', adminLogin.cookie);
      expect(listResponse.status).toBe(200);

      const detailAsAdmin = await request(app.getHttpServer())
        .get(`/api/v1/audit/${row.id}`)
        .set('Cookie', adminLogin.cookie);
      expect(detailAsAdmin.status).toBe(200);
      expect(
        (detailAsAdmin.body as { ipAddress: string | null }).ipAddress,
      ).not.toBeNull();

      const managementLogin = await login(
        app.getHttpServer(),
        MANAGEMENT_USERNAME,
        MANAGEMENT_PASSWORD,
      );
      // MANAGEMENT_USERNAME es una fixture compartida con
      // configuration.e2e-spec.ts/audit.e2e-spec.ts: mismo criterio que
      // arriba, solo se captura el LOGIN_SUCCESS exacto de este login.
      ownedAuditLogIds.push(
        await resolveLatestLoginSuccessId(
          prisma,
          (managementLogin.body as unknown as SessionBody).id,
        ),
      );

      const detailAsManagement = await request(app.getHttpServer())
        .get(`/api/v1/audit/${row.id}`)
        .set('Cookie', managementLogin.cookie);
      expect(detailAsManagement.status).toBe(200);
      expect(
        (detailAsManagement.body as { ipAddress: string | null }).ipAddress,
      ).toBeNull();
    });
  });

  describe('§43 — inmutabilidad de UserRole durante el switch', () => {
    it('las filas UserRole del usuario son idénticas antes y después de una secuencia de switches', async () => {
      const rowsBefore = await prisma.userRole.findMany({
        where: { userId: multiRoleUserId },
        select: { id: true, userId: true, roleId: true },
        orderBy: { roleId: 'asc' },
      });

      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );
      const toAdmin = await switchRole(app, loginResult.cookie, RoleName.ADMIN);
      const adminCookie = extractCookie(toAdmin);
      await switchRole(app, adminCookie, RoleName.SELLER);

      const rowsAfter = await prisma.userRole.findMany({
        where: { userId: multiRoleUserId },
        select: { id: true, userId: true, roleId: true },
        orderBy: { roleId: 'asc' },
      });

      expect(rowsAfter).toEqual(rowsBefore);
    });
  });

  describe('DTO — validación', () => {
    it('cuerpo vacío responde 400', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-role')
        .set('Cookie', loginResult.cookie)
        .send({});

      expect(response.status).toBe(400);
    });

    it('valor fuera del enum RoleName responde 400', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-role')
        .set('Cookie', loginResult.cookie)
        .send({ role: 'SUPERADMIN' });

      expect(response.status).toBe(400);
    });

    it('propiedad no declarada (roleId) responde 400 (whitelist del ValidationPipe)', async () => {
      const loginResult = await login(
        app.getHttpServer(),
        MULTI_ROLE_USERNAME,
        MULTI_ROLE_PASSWORD,
      );

      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-role')
        .set('Cookie', loginResult.cookie)
        .send({ role: RoleName.SELLER, roleId: 'algo-no-permitido' });

      expect(response.status).toBe(400);
    });

    it('sin cookie de sesión responde 401', async () => {
      const response = await request(app.getHttpServer())
        .post('/api/v1/auth/switch-role')
        .send({ role: RoleName.SELLER });

      expect(response.status).toBe(401);
    });
  });
});
