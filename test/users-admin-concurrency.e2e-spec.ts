import { ConflictException, INestApplication } from '@nestjs/common';
import { PrismaClient, RoleName, UserStatus } from '@prisma/client';
import { App } from 'supertest/types';
import { UsersService } from '../src/users/users.service';
import { createE2eApp } from './helpers/e2e-app';
import { ensureActiveTestAdmin, upsertFixtureUser } from './helpers/fixtures';
import { createTestPrismaClient } from './helpers/prisma-test-client';

/**
 * KAN-18, remediación de seguridad: prueba de integración real contra
 * PostgreSQL (pos_db_test) que demuestra que el lock `SELECT ... FOR UPDATE`
 * sobre la fila del Role ADMIN serializa correctamente dos operaciones
 * concurrentes capaces de reducir la población de ADMIN activos.
 *
 * Se opera directamente sobre UsersService (sin pasar por HTTP) para poder
 * controlar `actorUserId` sin depender de una segunda sesión autenticada —
 * mismo patrón ya usado en test/users.e2e-spec.ts para la prueba de
 * integración real de la protección del último ADMIN activo.
 *
 * Para que el límite "última población de ADMIN activos" sea determinista,
 * el admin de pruebas sembrado (E2E_ADMIN_USERNAME) se inactiva
 * TEMPORALMENTE (vía escritura directa de Prisma, nunca a través del
 * servicio) mientras dura este archivo, y se restaura exactamente a su
 * estado previo en `afterAll` — mismo criterio de snapshot-y-restauración ya
 * usado en test/configuration-sequences.e2e-spec.ts. Como
 * `test/jest-e2e.json` fija `maxWorkers: 1`, ningún otro archivo e2e se
 * ejecuta mientras este archivo mantiene el estado perturbado.
 */
describe('Concurrencia — invariante del último ADMIN activo (e2e real)', () => {
  const ADMIN_A_USERNAME = 'e2e_concurrency_admin_a';
  const ADMIN_B_USERNAME = 'e2e_concurrency_admin_b';

  let app: INestApplication<App>;
  let prisma: PrismaClient;
  let usersService: UsersService;
  let realAdminId: string;
  let realAdminStatusBefore: UserStatus;
  let adminAId: string;
  let adminBId: string;

  async function countActiveAdmins(): Promise<number> {
    return prisma.user.count({
      where: {
        status: UserStatus.ACTIVE,
        roles: { some: { role: { name: RoleName.ADMIN } } },
      },
    });
  }

  async function resetControlledAdmins(): Promise<void> {
    // Reemplazo total determinista (mismo criterio que upsertFixtureUser):
    // ambos usuarios controlados vuelven a ser exactamente ADMIN + ACTIVE
    // antes de cada escenario concurrente.
    await upsertFixtureUser(prisma, {
      username: ADMIN_A_USERNAME,
      email: `${ADMIN_A_USERNAME}@demosystem.test`,
      password: 'ConcurrencyAdminA123',
      roleName: RoleName.ADMIN,
      status: UserStatus.ACTIVE,
    });
    await upsertFixtureUser(prisma, {
      username: ADMIN_B_USERNAME,
      email: `${ADMIN_B_USERNAME}@demosystem.test`,
      password: 'ConcurrencyAdminB123',
      roleName: RoleName.ADMIN,
      status: UserStatus.ACTIVE,
    });
  }

  beforeAll(async () => {
    prisma = createTestPrismaClient();
    app = await createE2eApp();
    usersService = app.get(UsersService);

    // Punto de partida conocido: el admin sembrado, ACTIVE.
    const realAdmin = await ensureActiveTestAdmin(prisma);
    realAdminId = realAdmin.id;
    realAdminStatusBefore = realAdmin.status;

    // Se inactiva TEMPORALMENTE para que la población global de ADMIN
    // activos quede en exactamente 0 antes de crear los dos usuarios
    // controlados — nunca se hace a través de UsersService (eso ejercitaría
    // la propia invariante que se está preparando para probar).
    await prisma.user.update({
      where: { id: realAdminId },
      data: { status: UserStatus.INACTIVE },
    });

    const adminA = await upsertFixtureUser(prisma, {
      username: ADMIN_A_USERNAME,
      email: `${ADMIN_A_USERNAME}@demosystem.test`,
      password: 'ConcurrencyAdminA123',
      roleName: RoleName.ADMIN,
      status: UserStatus.ACTIVE,
    });
    const adminB = await upsertFixtureUser(prisma, {
      username: ADMIN_B_USERNAME,
      email: `${ADMIN_B_USERNAME}@demosystem.test`,
      password: 'ConcurrencyAdminB123',
      roleName: RoleName.ADMIN,
      status: UserStatus.ACTIVE,
    });
    adminAId = adminA.id;
    adminBId = adminB.id;

    const precondition = await countActiveAdmins();
    if (precondition !== 2) {
      throw new Error(
        `Precondición del escenario de concurrencia no alcanzada: se esperaban exactamente 2 ADMIN activos, hay ${precondition}`,
      );
    }
  });

  afterAll(async () => {
    // Restauración exacta del admin real sembrado (snapshot-y-restauración,
    // nunca un valor fijo asumido) y limpieza de los dos usuarios creados
    // exclusivamente por este archivo (no son fixtures compartidas con
    // ningún otro archivo e2e — borrado dirigido por id, nunca deleteMany
    // sin condición).
    await prisma.user.update({
      where: { id: realAdminId },
      data: { status: realAdminStatusBefore },
    });
    await prisma.user.deleteMany({
      where: { id: { in: [adminAId, adminBId] } },
    });

    await app.close();
    await prisma.$disconnect();
  });

  it('democión concurrente: exactamente una de las dos solicitudes se rechaza con 409, nunca llegan 0 ADMIN activos', async () => {
    const [resultA, resultB] = await Promise.allSettled([
      usersService.updateUser({
        userId: adminAId,
        roleNames: [RoleName.SELLER],
        actorUserId: realAdminId,
      }),
      usersService.updateUser({
        userId: adminBId,
        roleNames: [RoleName.SELLER],
        actorUserId: realAdminId,
      }),
    ]);

    const settled = [resultA, resultB];
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    // Invariante crítica: nunca 0 ADMIN activos.
    const finalActiveAdmins = await countActiveAdmins();
    expect(finalActiveAdmins).toBeGreaterThanOrEqual(1);
    expect(finalActiveAdmins).toBe(1);

    // Sin reemplazo parcial de UserRole: el rechazado conserva exactamente
    // [ADMIN] (nunca vacío, nunca [ADMIN, SELLER] a medias); el exitoso
    // queda exactamente en [SELLER] (reemplazo completo, sin ADMIN residual).
    const [rowA, rowB] = await Promise.all([
      prisma.user.findUniqueOrThrow({
        where: { id: adminAId },
        include: { roles: { include: { role: true } } },
      }),
      prisma.user.findUniqueOrThrow({
        where: { id: adminBId },
        include: { roles: { include: { role: true } } },
      }),
    ]);
    for (const row of [rowA, rowB]) {
      const roleNames = row.roles.map((r) => r.role.name).sort();
      expect(roleNames).toHaveLength(1);
      expect([[RoleName.ADMIN], [RoleName.SELLER]]).toContainEqual(roleNames);
    }
    const combinedRoles = [rowA, rowB]
      .flatMap((row) => row.roles.map((r) => r.role.name))
      .sort();
    expect(combinedRoles).toEqual([RoleName.ADMIN, RoleName.SELLER].sort());
  });

  it('lock liberado tras el rechazo: una operación protegida legítima subsiguiente puede adquirirlo (sin lock/deadlock persistente)', async () => {
    // En este punto (tras la prueba anterior) queda exactamente 1 ADMIN
    // activo entre los dos usuarios controlados. Intentar bloquearlo debe
    // seguir funcionando: si el lock del intento rechazado anterior hubiera
    // quedado sostenido indefinidamente, esta llamada colgaría hasta el
    // timeout de Jest en lugar de resolver con un 409 normal.
    const remaining = await prisma.user.findFirstOrThrow({
      where: {
        id: { in: [adminAId, adminBId] },
        status: UserStatus.ACTIVE,
        roles: { some: { role: { name: RoleName.ADMIN } } },
      },
    });

    await expect(
      usersService.blockUser({
        targetUserId: remaining.id,
        actorUserId: realAdminId,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const finalActiveAdmins = await countActiveAdmins();
    expect(finalActiveAdmins).toBe(1);
  });

  it('bloqueo concurrente: exactamente una de las dos solicitudes se rechaza con 409, nunca llegan 0 ADMIN activos, sin deadlock', async () => {
    await resetControlledAdmins();
    const precondition = await countActiveAdmins();
    expect(precondition).toBe(2);

    const [resultA, resultB] = await Promise.allSettled([
      usersService.blockUser({
        targetUserId: adminAId,
        actorUserId: realAdminId,
      }),
      usersService.blockUser({
        targetUserId: adminBId,
        actorUserId: realAdminId,
      }),
    ]);

    const settled = [resultA, resultB];
    const fulfilled = settled.filter((r) => r.status === 'fulfilled');
    const rejected = settled.filter((r) => r.status === 'rejected');

    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(ConflictException);

    const finalActiveAdmins = await countActiveAdmins();
    expect(finalActiveAdmins).toBeGreaterThanOrEqual(1);
    expect(finalActiveAdmins).toBe(1);

    // La finalización de este `it` dentro del timeout de Jest (30s, sin
    // colgarse) ya es en sí evidencia de ausencia de deadlock: ambas
    // transacciones toman el mismo único lock (Role ADMIN) en el mismo
    // orden y ningún otro recurso compartido, así que no hay ciclo posible.
  });
});
