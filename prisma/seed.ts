import { PrismaClient, RoleName } from '@prisma/client';
import { assertPasswordPolicy } from '../src/common/security/password-policy';
import { hashPassword } from '../src/common/security/password.service';

const prisma = new PrismaClient();

const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  ADMIN: 'Acceso total, configuración y administración de usuarios',
  SELLER: 'Cotizaciones, ventas, pagos y clientes',
  WAREHOUSE: 'Productos, categorías, unidades e inventario',
  MANAGEMENT: 'Dashboard y reportes de lectura y análisis',
};

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name} es obligatorio para ejecutar el seed. Defínelo en .env.`,
    );
  }
  return value;
}

async function seedRoles(): Promise<void> {
  for (const name of Object.values(RoleName)) {
    await prisma.role.upsert({
      where: { name },
      update: {},
      create: { name, description: ROLE_DESCRIPTIONS[name] },
    });
  }
  console.log('Roles verificados: ADMIN, SELLER, WAREHOUSE, MANAGEMENT');
}

async function seedInitialAdmin(): Promise<void> {
  const rawUsername = requireEnv('INITIAL_ADMIN_USERNAME');
  const rawEmail = requireEnv('INITIAL_ADMIN_EMAIL');
  const rawPassword = requireEnv('INITIAL_ADMIN_PASSWORD');

  assertPasswordPolicy(
    rawPassword,
    (violations) =>
      `INITIAL_ADMIN_PASSWORD no cumple la política de contraseñas: ${violations.join(', ')}.`,
  );

  const username = normalize(rawUsername);
  const email = normalize(rawEmail);

  const [byUsername, byEmail] = await Promise.all([
    prisma.user.findUnique({ where: { username } }),
    prisma.user.findUnique({ where: { email } }),
  ]);

  if (byUsername === null && byEmail === null) {
    const adminRole = await prisma.role.findUniqueOrThrow({
      where: { name: RoleName.ADMIN },
    });
    const passwordHash = await hashPassword(rawPassword);

    await prisma.user.create({
      data: {
        firstName: 'Administrador',
        lastName: 'Inicial',
        username,
        email,
        passwordHash,
        roleId: adminRole.id,
        status: 'ACTIVE',
        mustChangePassword: true,
      },
    });
    console.log(`Administrador inicial creado: ${username}`);
    return;
  }

  if (byUsername !== null && byEmail !== null && byUsername.id === byEmail.id) {
    console.log(
      `Administrador inicial ya existe (${username}); se conserva su contraseña.`,
    );
    return;
  }

  throw new Error(
    'Conflicto en el seed: INITIAL_ADMIN_USERNAME e INITIAL_ADMIN_EMAIL ' +
      'corresponden a usuarios distintos ya existentes. Revisa los valores ' +
      'en .env o los registros en la base de datos antes de reintentar.',
  );
}

async function main(): Promise<void> {
  await seedRoles();
  await seedInitialAdmin();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
