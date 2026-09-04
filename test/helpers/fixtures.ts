import {
  CashSessionStatus,
  Prisma,
  PrismaClient,
  RoleName,
  User,
  UserStatus,
} from '@prisma/client';
import { hashPassword } from '../../src/common/security/password.service';
import {
  E2E_ADMIN_ACTIVE_PASSWORD,
  E2E_ADMIN_EMAIL,
  E2E_ADMIN_USERNAME,
} from './constants';

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
 * Garantiza que el admin de prueba compartido (E2E_ADMIN_USERNAME) exista y
 * esté en estado "activo" (ya completó el cambio obligatorio de
 * contraseña), sin importar qué haya dejado otra ejecución o archivo
 * previo. Idempotente y, a partir de la Fase 12E, también AUTO-REPARABLE:
 *
 *  - Si la fila ya existe (caso normal): la actualiza (status ACTIVE,
 *    mustChangePassword=false, contraseña "activa", contador de intentos y
 *    bloqueo limpios) — comportamiento idéntico al de antes de esta ronda.
 *  - Si la fila NO existe (fue borrada por algún efecto colateral de otro
 *    archivo — ver Fase 12D/12E): la RECREA con la misma identidad
 *    determinística que usaría `prisma/seed.ts` para el admin inicial, en
 *    vez de lanzar `PrismaClientKnownRequestError` (P2025) como hacía la
 *    versión anterior basada en `update()`. Esto es lo que permite que esta
 *    función se invoque de forma segura al inicio de CUALQUIER archivo e2e
 *    (ver jest-e2e.bootstrap.ts), sin depender de que otro archivo haya
 *    corrido antes para "sembrar" el estado esperado.
 *
 * Nunca relaja la política de contraseñas real (usa hashPassword() con la
 * MISMA función que produción) ni el contrato mustChangePassword=true en el
 * seed real: esta función solo existe para que las suites e2e puedan partir
 * de un estado "ya pasó el primer cambio de contraseña" determinístico,
 * igual que si un operador real hubiera iniciado sesión y cambiado su
 * contraseña una vez.
 */
export async function ensureActiveTestAdmin(
  prisma: PrismaClient,
): Promise<User> {
  const role = await prisma.role.findUniqueOrThrow({
    where: { name: RoleName.ADMIN },
  });
  const passwordHash = await hashPassword(E2E_ADMIN_ACTIVE_PASSWORD);

  const user = await prisma.user.upsert({
    where: { username: E2E_ADMIN_USERNAME },
    update: {
      passwordHash,
      status: UserStatus.ACTIVE,
      mustChangePassword: false,
      failedLoginAttempts: 0,
      blockedAt: null,
    },
    create: {
      username: E2E_ADMIN_USERNAME,
      email: E2E_ADMIN_EMAIL,
      firstName: 'Administrador',
      lastName: 'E2E',
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

/**
 * Abre una CashSession OPEN directamente en BD para el actor de una suite
 * NO relacionada con CashSessions (Ticket B, Bloque B4 §29 del plan
 * aprobado): desde este bloque, PaymentEngine.register() exige que
 * cualquier cobrador tenga su propia caja sin resolver, así que las
 * suites de Payments/Sales/Accounting/Reports/etc. necesitan esta fila
 * para que sus fixtures de cobro no sean rechazadas con 409 — sin
 * necesitar ejercer el endpoint HTTP real de apertura (eso queda reservado
 * a cash-sessions.e2e-spec.ts, la única suite que SÍ prueba el flujo de
 * apertura en sí). El índice único parcial
 * `cash_sessions_one_unresolved_per_user` impide abrir dos veces para el
 * mismo usuario: cada suite que llama a esto lo hace UNA sola vez
 * (normalmente en beforeAll) para su propio actor cobrador dedicado, y
 * elimina la fila por su ID exacto en su propio afterAll — nunca una
 * reutilización entre archivos, nunca un actor compartido globalmente
 * (mismo criterio de propiedad exacta que el resto del repositorio).
 */
export async function openCashSessionFixture(
  prisma: PrismaClient,
  userId: string,
  openingAmount: string = '0',
): Promise<{ id: string }> {
  return prisma.cashSession.create({
    data: {
      userId,
      status: CashSessionStatus.OPEN,
      openingAmount: new Prisma.Decimal(openingAmount),
    },
    select: { id: true },
  });
}
