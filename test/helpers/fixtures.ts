import { PrismaClient, RoleName, User, UserStatus } from '@prisma/client';
import { hashPassword } from '../../src/common/security/password.service';
import { E2E_ADMIN_ACTIVE_PASSWORD, E2E_ADMIN_USERNAME } from './constants';

export interface FixtureUserInput {
  username: string;
  email: string;
  firstName?: string;
  lastName?: string;
  password: string;
  roleName: RoleName;
  status?: UserStatus;
  mustChangePassword?: boolean;
  failedLoginAttempts?: number;
  blockedAt?: Date | null;
}

/**
 * Crea o restablece un usuario de prueba a un estado conocido, para que las
 * pruebas sean repetibles sin depender de una re-siembra manual entre
 * ejecuciones. KAN-18, Bloque A: el contrato EXTERNO se preserva a
 * propósito (`roleName: RoleName`, un solo rol) para no obligar a ~16
 * suites E2E no relacionadas a volverse conscientes de multi-rol —
 * internamente, la fixture asegura que el usuario tenga exactamente esa
 * única fila UserRole asignada (nunca dos filas tras una reejecución: se
 * reemplaza por completo, igual criterio que UsersService.updateUser()).
 */
export async function upsertFixtureUser(
  prisma: PrismaClient,
  input: FixtureUserInput,
): Promise<User> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: input.roleName },
  });
  const passwordHash = await hashPassword(input.password);

  const data = {
    email: input.email,
    firstName: input.firstName ?? 'E2E',
    lastName: input.lastName ?? 'Fixture',
    passwordHash,
    status: input.status ?? UserStatus.ACTIVE,
    mustChangePassword: input.mustChangePassword ?? false,
    failedLoginAttempts: input.failedLoginAttempts ?? 0,
    blockedAt: input.blockedAt ?? null,
  };

  const user = await prisma.user.upsert({
    where: { username: input.username },
    create: { username: input.username, ...data },
    update: data,
  });

  // Reemplazo total de la membresía de rol (nunca add/remove incremental,
  // mismo criterio que UsersService.updateUser()): garantiza exactamente
  // un UserRole = el solicitado, sin importar qué haya dejado una
  // ejecución previa (incluyendo un rol distinto de una fixture anterior
  // con el mismo username).
  await prisma.userRole.deleteMany({ where: { userId: user.id } });
  await prisma.userRole.create({
    data: { userId: user.id, roleId: role.id },
  });

  return user;
}

/**
 * Garantiza que el admin de prueba esté en estado "activo" (ya completó el
 * cambio obligatorio de contraseña), sin importar qué haya dejado otra
 * ejecución o archivo previo. Idempotente.
 */
export async function ensureActiveTestAdmin(
  prisma: PrismaClient,
): Promise<User> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: RoleName.ADMIN },
  });
  const passwordHash = await hashPassword(E2E_ADMIN_ACTIVE_PASSWORD);

  const user = await prisma.user.update({
    where: { username: E2E_ADMIN_USERNAME },
    data: {
      passwordHash,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      blockedAt: null,
    },
  });

  // Mismo criterio de reemplazo total que upsertFixtureUser(): garantiza
  // exactamente un UserRole = ADMIN para el admin de pruebas, sin importar
  // qué haya dejado una ejecución previa.
  await prisma.userRole.deleteMany({ where: { userId: user.id } });
  await prisma.userRole.create({
    data: { userId: user.id, roleId: role.id },
  });

  return user;
}
