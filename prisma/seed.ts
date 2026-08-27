import {
  AccountType,
  AccountingSystemKey,
  CustomerStage,
  CustomerStatus,
  DocumentType,
  FiscalDocumentType,
  Prisma,
  PrismaClient,
  RoleName,
} from '@prisma/client';
import { assertPasswordPolicy } from '../src/common/security/password-policy';
import { hashPassword } from '../src/common/security/password.service';

const prisma = new PrismaClient();

const ROLE_DESCRIPTIONS: Record<RoleName, string> = {
  ADMIN: 'Acceso total, configuración y administración de usuarios',
  SELLER: 'Cotizaciones, ventas, pagos y clientes',
  WAREHOUSE: 'Productos, categorías, unidades e inventario',
  MANAGEMENT: 'Dashboard y reportes de lectura y análisis',
};

/**
 * Categorías raíz de demostración (Fase 2, Bloque A). No se inventan
 * subcategorías aquí: la jerarquía se probará en un bloque posterior.
 */
const SEED_CATEGORIES: ReadonlyArray<{ code: string; name: string }> = [
  { code: 'MAQ_CONSTRUCCION', name: 'Máquinas de construcción' },
  { code: 'GASF_TUBERIAS', name: 'Gasfitería y tuberías' },
  { code: 'SIST_AGUA', name: 'Sistemas de agua' },
  { code: 'EQ_HIDRAULICOS', name: 'Equipos hidráulicos' },
  { code: 'PINTURA', name: 'Pintura' },
  { code: 'REPUESTOS', name: 'Repuestos' },
  { code: 'SERVICIOS', name: 'Servicios' },
];

/** Unidades de medida base. allowDecimal solo para las continuas. */
const SEED_UNITS: ReadonlyArray<{
  code: string;
  name: string;
  abbreviation: string;
  allowDecimal: boolean;
}> = [
  { code: 'UND', name: 'Unidad', abbreviation: 'und', allowDecimal: false },
  { code: 'MTR', name: 'Metro', abbreviation: 'm', allowDecimal: true },
  { code: 'KG', name: 'Kilogramo', abbreviation: 'kg', allowDecimal: true },
  { code: 'LTR', name: 'Litro', abbreviation: 'L', allowDecimal: true },
  { code: 'GLN', name: 'Galón', abbreviation: 'gal', allowDecimal: true },
  { code: 'CJ', name: 'Caja', abbreviation: 'cj', allowDecimal: false },
  { code: 'JGO', name: 'Juego', abbreviation: 'jgo', allowDecimal: false },
  { code: 'PAR', name: 'Par', abbreviation: 'par', allowDecimal: false },
  { code: 'RLL', name: 'Rollo', abbreviation: 'rll', allowDecimal: false },
  { code: 'SER', name: 'Servicio', abbreviation: 'ser', allowDecimal: false },
];

/**
 * Plan de cuentas básico (Fase 8, Bloque A — Documento Maestro §17).
 * Exactamente las seis cuentas de sistema aprobadas: sin PCGE, sin cuentas
 * personalizadas, sin mapeo configurable. code/name en este arreglo son la
 * fuente de verdad de los valores canónicos.
 */
const SEED_ACCOUNTS: ReadonlyArray<{
  systemKey: AccountingSystemKey;
  code: string;
  name: string;
  type: AccountType;
}> = [
  {
    systemKey: AccountingSystemKey.CASH,
    code: 'CASH',
    name: 'Caja',
    type: AccountType.ASSET,
  },
  {
    systemKey: AccountingSystemKey.BANK,
    code: 'BANK',
    name: 'Bancos',
    type: AccountType.ASSET,
  },
  {
    systemKey: AccountingSystemKey.ACCOUNTS_RECEIVABLE,
    code: 'AR',
    name: 'Cuentas por cobrar',
    type: AccountType.ASSET,
  },
  {
    systemKey: AccountingSystemKey.VAT_PAYABLE,
    code: 'VAT',
    name: 'IGV por pagar',
    type: AccountType.LIABILITY,
  },
  {
    systemKey: AccountingSystemKey.SALES_REVENUE,
    code: 'SALES',
    name: 'Ventas',
    type: AccountType.REVENUE,
  },
  {
    systemKey: AccountingSystemKey.DISCOUNTS,
    code: 'DISCOUNTS',
    name: 'Descuentos',
    type: AccountType.CONTRA_REVENUE,
  },
];

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

    // KAN-18, Bloque A: la asignación de rol ahora vive en UserRole, creada
    // en la MISMA operación (nested create) — nunca una fila de usuario
    // transitoriamente sin ningún rol.
    await prisma.user.create({
      data: {
        firstName: 'Administrador',
        lastName: 'Inicial',
        username,
        email,
        passwordHash,
        status: 'ACTIVE',
        mustChangePassword: true,
        roles: { create: { roleId: adminRole.id } },
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

/**
 * Categorías raíz de demostración. upsert por code: no duplica en
 * reejecuciones y no sobrescribe cambios que un administrador haya hecho
 * después (update: {} — igual que seedRoles()).
 */
async function seedCategories(): Promise<void> {
  for (const category of SEED_CATEGORIES) {
    await prisma.category.upsert({
      where: { code: category.code },
      update: {},
      create: {
        code: category.code,
        name: category.name,
      },
    });
  }
  console.log(`Categorías verificadas: ${SEED_CATEGORIES.length}`);
}

/** Unidades de medida base. Mismo criterio de idempotencia que seedCategories(). */
async function seedUnits(): Promise<void> {
  for (const unit of SEED_UNITS) {
    await prisma.unit.upsert({
      where: { code: unit.code },
      update: {},
      create: {
        code: unit.code,
        name: unit.name,
        abbreviation: unit.abbreviation,
        allowDecimal: unit.allowDecimal,
      },
    });
  }
  console.log(`Unidades verificadas: ${SEED_UNITS.length}`);
}

/**
 * Cliente genérico "Público general" (Fase 4, Bloque A). A diferencia del
 * resto de seeds de este archivo, el `update` NO está vacío: los valores de
 * sistema del genérico (nombre, isGeneric, ausencia de tipo/documento,
 * etapa y estado) son invariantes de dominio, no datos editables por un
 * administrador, así que cada ejecución del seed los restaura si alguien
 * los alteró directamente en la base. Los campos de contacto opcionales
 * (tradeName, contactName, phone, email, address, internalNotes) no se
 * tocan en el update para no pisar anotaciones legítimas.
 */
async function seedGenericCustomer(): Promise<void> {
  await prisma.customer.upsert({
    where: { code: 'PUBLIC_GENERAL' },
    update: {
      name: 'Público general',
      isGeneric: true,
      customerType: null,
      customerStage: CustomerStage.CUSTOMER,
      status: CustomerStatus.ACTIVE,
      documentType: null,
      documentNumber: null,
    },
    create: {
      code: 'PUBLIC_GENERAL',
      name: 'Público general',
      isGeneric: true,
      customerType: null,
      customerStage: CustomerStage.CUSTOMER,
      status: CustomerStatus.ACTIVE,
      documentType: null,
      documentNumber: null,
    },
  });
  console.log('Cliente genérico verificado: Público general (PUBLIC_GENERAL)');
}

/**
 * Secuencias de correlativos COT (Fase 5) y NV (Fase 6, Bloque A). `update:
 * {}` a propósito en ambas (igual que seedCategories()/seedUnits()): a
 * diferencia del cliente genérico, current_number/prefix/padding son
 * configuración operativa, no invariantes de dominio protegidas. Reejecutar
 * el seed jamás debe tocar current_number — una vez emitido un COT o NV,
 * retroceder el contador produciría números duplicados. El upsert por
 * documentType solo garantiza que la fila exista la primera vez; después
 * queda intacta.
 */
async function seedDocumentSequences(): Promise<void> {
  await prisma.documentSequence.upsert({
    where: { documentType: DocumentType.QUOTE },
    update: {},
    create: {
      documentType: DocumentType.QUOTE,
      prefix: 'COT-',
      currentNumber: 0,
      padding: 6,
    },
  });
  console.log('Secuencia de documento verificada: QUOTE (COT-)');

  // Secuencia del correlativo NV (Fase 6, Bloque A). Mismo criterio exacto
  // que QUOTE: update: {} para no tocar jamás current_number en una
  // reejecución del seed.
  await prisma.documentSequence.upsert({
    where: { documentType: DocumentType.SALE },
    update: {},
    create: {
      documentType: DocumentType.SALE,
      prefix: 'NV-',
      currentNumber: 0,
      padding: 6,
    },
  });
  console.log('Secuencia de documento verificada: SALE (NV-)');
}

/**
 * Serie fiscal de demostración por tipo de documento electrónico (Fase 11,
 * Bloque B — fundación fiscal, sin emisión todavía). Mismo criterio EXACTO
 * que seedDocumentSequences(): `update: {}` a propósito — currentNumber es
 * el ÚLTIMO número emitido y jamás debe retroceder en una reejecución del
 * seed; el upsert por (documentType, series) solo garantiza que la fila
 * exista la primera vez, después queda intacta. Este seed NUNCA crea filas
 * de ElectronicDocument.
 */
async function seedFiscalSeries(): Promise<void> {
  await prisma.fiscalSeries.upsert({
    where: {
      documentType_series: {
        documentType: FiscalDocumentType.FACTURA,
        series: 'F001',
      },
    },
    update: {},
    create: {
      documentType: FiscalDocumentType.FACTURA,
      series: 'F001',
      currentNumber: 0,
      active: true,
    },
  });
  console.log('Serie fiscal verificada: FACTURA / F001');

  await prisma.fiscalSeries.upsert({
    where: {
      documentType_series: {
        documentType: FiscalDocumentType.BOLETA,
        series: 'B001',
      },
    },
    update: {},
    create: {
      documentType: FiscalDocumentType.BOLETA,
      series: 'B001',
      currentNumber: 0,
      active: true,
    },
  });
  console.log('Serie fiscal verificada: BOLETA / B001');
}

/**
 * Cuentas de sistema del plan de cuentas básico (Fase 8, Bloque A). Mismo
 * criterio que seedGenericCustomer(): systemKey/code/name/type son
 * invariantes de dominio, no configuración editable, así que el `update`
 * restaura los valores canónicos aprobados en cada reejecución (nunca
 * `update: {}`). Sin AccountingEntry/AccountingEntryLine aquí: este seed
 * jamás crea historial financiero, solo el plan de cuentas fijo.
 */
async function seedAccounts(): Promise<void> {
  for (const account of SEED_ACCOUNTS) {
    await prisma.account.upsert({
      where: { systemKey: account.systemKey },
      update: {
        code: account.code,
        name: account.name,
        type: account.type,
      },
      create: {
        systemKey: account.systemKey,
        code: account.code,
        name: account.name,
        type: account.type,
      },
    });
  }
  console.log(`Cuentas contables verificadas: ${SEED_ACCOUNTS.length}`);
}

/**
 * Configuración de la empresa (Fase 10, Bloque A): fila singleton única.
 * Mismo criterio de idempotencia que seedDocumentSequences() — `update: {}`
 * a propósito: businessName/tradeName/taxId/address/phone/email/
 * currencyCode/currencySymbol son configuración operativa editable por
 * ADMIN vía PATCH /api/v1/configuration, nunca invariantes de dominio
 * protegidas (a diferencia de seedGenericCustomer()/seedAccounts()).
 * Reejecutar el seed después de que un administrador haya personalizado la
 * configuración jamás debe restaurar los valores de fábrica. taxEnabled/
 * taxRate/quoteValidityDays/maxDiscountPercent tampoco se tocan en el
 * update por el mismo motivo, aunque en el Bloque A todavía no son
 * editables por PATCH.
 */
async function seedCompanySettings(): Promise<void> {
  await prisma.companySettings.upsert({
    where: { singleton: true },
    update: {},
    create: {
      singleton: true,
      businessName: 'Empresa Comercial Demo S.A.C.',
      tradeName: 'Comercial Demo',
      taxId: null,
      address: null,
      phone: null,
      email: null,
      currencyCode: 'PEN',
      currencySymbol: 'S/',
      taxEnabled: false,
      taxRate: new Prisma.Decimal('18.00'),
      quoteValidityDays: 15,
      maxDiscountPercent: new Prisma.Decimal('100.00'),
    },
  });
  console.log('Configuración de la empresa verificada (fila singleton)');
}

async function main(): Promise<void> {
  await seedRoles();
  await seedInitialAdmin();
  await seedCategories();
  await seedUnits();
  await seedGenericCustomer();
  await seedDocumentSequences();
  await seedAccounts();
  await seedCompanySettings();
  await seedFiscalSeries();
}

main()
  .catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  })
  .finally(() => {
    void prisma.$disconnect();
  });
