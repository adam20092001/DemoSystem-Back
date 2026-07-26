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
 * ejecuciones.
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
    roleId: role.id,
    status: input.status ?? UserStatus.ACTIVE,
    mustChangePassword: input.mustChangePassword ?? false,
    failedLoginAttempts: input.failedLoginAttempts ?? 0,
    blockedAt: input.blockedAt ?? null,
  };

  return prisma.user.upsert({
    where: { username: input.username },
    create: { username: input.username, ...data },
    update: data,
  });
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

  return prisma.user.update({
    where: { username: E2E_ADMIN_USERNAME },
    data: {
      passwordHash,
      roleId: role.id,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      blockedAt: null,
    },
  });
}
