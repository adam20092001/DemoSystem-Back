import 'reflect-metadata';
import { ConflictException } from '@nestjs/common';
import {
  CustomerDocumentType,
  CustomerStage,
  CustomerType,
  InventoryMovementOrigin,
  InventoryMovementType,
  Prisma,
  ProductType,
  Role,
  RoleName,
} from '@prisma/client';
import { AuditService } from '../src/audit/audit.service';
import { assertPasswordPolicy } from '../src/common/security/password-policy';
import { hashPassword } from '../src/common/security/password.service';
import { PrismaService } from '../src/database/prisma.service';
import { StockMovementEngine } from '../src/inventory/stock-movement.engine';
import { StockMovementCommand } from '../src/inventory/types/stock-movement-command';

/**
 * Subconjunto estructural de PrismaService que realmente usa este seed.
 * PrismaService lo satisface sin ningún cast (duck typing de TypeScript);
 * exponerlo así permite pasar un doble de prueba mínimo en
 * demo-seed.spec.ts sin simular el PrismaClient completo.
 */
export interface DemoSeedPrismaClient {
  role: {
    findMany(args: {
      where: { name: { in: RoleName[] } };
    }): Promise<Pick<Role, 'id' | 'name'>[]>;
  };
  user: {
    findUnique(args: {
      where: { email: string };
    }): Promise<{ id: string } | null>;
    create(args: {
      data: Record<string, unknown>;
    }): Promise<{ id: string }>;
  };
  userRole: {
    upsert(args: {
      where: { userId_roleId: { userId: string; roleId: string } };
      update: Record<string, never>;
      create: { userId: string; roleId: string };
    }): Promise<unknown>;
  };
  customer: {
    upsert(args: {
      where: { code: string };
      update: Record<string, never>;
      create: Record<string, unknown>;
    }): Promise<unknown>;
  };
  category: {
    findUnique(args: { where: { code: string } }): Promise<{ id: string } | null>;
  };
  unit: {
    findUnique(args: { where: { code: string } }): Promise<{ id: string } | null>;
  };
  product: {
    upsert(args: {
      where: { sku: string };
      update: Record<string, never>;
      create: Record<string, unknown>;
    }): Promise<{ id: string; sku: string; isInventoryTracked: boolean }>;
  };
  $transaction<T>(fn: (tx: Prisma.TransactionClient) => Promise<T>): Promise<T>;
}

/**
 * Seed OPCIONAL de datos de demostración (Fase 12, Bloque C).
 *
 * NUNCA se ejecuta como parte de `npm run db:seed` (infraestructura,
 * prisma/seed.ts, seguro para cualquier entorno). Se invoca explícitamente
 * con:
 *
 *   npm run db:seed:demo
 *
 * Reglas de esta ronda, todas deliberadas:
 *
 *  - Se NIEGA a ejecutar si NODE_ENV=production (ver assertNotProduction()):
 *    un entorno productivo nunca debe recibir usuarios/clientes/productos
 *    sintéticos. Sin bandera de bypass.
 *  - Requiere DEMO_USER_PASSWORD (ver .env.example) y la valida con la MISMA
 *    política de contraseñas que UsersService (assertPasswordPolicy) —
 *    nunca una política más débil. Nunca se imprime en ningún log.
 *  - Nunca crea Quote/Sale/SaleItem/Payment/AccountingEntry/
 *    AccountingEntryLine/ElectronicDocument/ElectronicDocumentItem: esos
 *    agregados tienen efectos de negocio (correlativos, inventario, pagos,
 *    contabilidad, auditoría, ciclo fiscal) que solo sus servicios/API
 *    reales deben producir. El flujo de demostración de README.md los crea
 *    en vivo contra la API.
 *  - Nunca toca DocumentSequence.currentNumber ni FiscalSeries.currentNumber.
 *  - Nunca sobrescribe CompanySettings: el operador la configura por
 *    PATCH /api/v1/configuration (ver README.md), porque puede que ya exista
 *    una identidad de empresa configurada legítimamente.
 *  - El stock inicial se registra con StockMovementEngine.apply() —el mismo
 *    motor transaccional que usa InventoryService en producción (Fase 3)—,
 *    nunca escribiendo Product.stockCurrent directamente. Reejecutar el seed
 *    no duplica el saldo inicial: el propio motor rechaza (ConflictException)
 *    un segundo saldo inicial sobre un producto que ya tiene stock o
 *    movimientos, y el seed trata ese rechazo como "ya existía", no como un
 *    error.
 *  - Reejecutar el seed es 100% idempotente: mismo usuario demo, mismos 4
 *    roles, mismos clientes, mismos productos, mismo stock inicial — nunca
 *    duplica filas, nunca resetea password/mustChangePassword, nunca borra
 *    asignaciones de otros usuarios.
 *  - Toda fila creada por este seed usa un identificador determinístico con
 *    prefijo "DEMO-" (clientes por `code`, productos por `sku`) para que sea
 *    reconocible y no colisione con datos reales de un operador.
 */

const DEMO_USER_EMAIL = 'demo@demosystem.local';
const DEMO_USER_USERNAME = 'demo';
const DEMO_USER_FIRST_NAME = 'Usuario';
const DEMO_USER_LAST_NAME = 'Demo';

/**
 * Un único usuario multi-rol es suficiente para demostrar KAN-18
 * (switch-role): no se crean 4 cuentas separadas porque la arquitectura de
 * autorización (activeRole resuelto por sesión, no por usuario) no lo exige.
 */
const DEMO_USER_ROLES: readonly RoleName[] = [
  RoleName.ADMIN,
  RoleName.SELLER,
  RoleName.WAREHOUSE,
  RoleName.MANAGEMENT,
];

// El modelo User de este esquema no tiene ningún campo de documento/DNI
// (eso solo existe en Customer) — no se inventa un campo que no existe.

const DEMO_CUSTOMER_COMPANY_CODE = 'DEMO-CUST-COMPANY';
const DEMO_CUSTOMER_PERSON_CODE = 'DEMO-CUST-PERSON';

interface DemoProductSeed {
  sku: string;
  name: string;
  brand?: string;
  categoryCode: string;
  unitCode: string;
  /** Decimal(14,2) como string. */
  salePrice: string;
  /**
   * Decimal(14,3) como string, o null para un SERVICE (nunca descuenta ni
   * recibe stock — CLAUDE.md §6).
   */
  initialStock: string | null;
}

/**
 * 5–8 productos con categorías/unidades ya existentes en el seed de
 * infraestructura (prisma/seed.ts) — nunca se inventan categorías/unidades
 * nuevas aquí. El último es un SERVICE a propósito, para que el flujo de
 * demo pueda mostrar la invariante "los servicios no descuentan stock".
 */
const DEMO_PRODUCTS: readonly DemoProductSeed[] = [
  {
    sku: 'DEMO-SKU-001',
    name: 'Taladro percutor 750W',
    brand: 'ForzaTools',
    categoryCode: 'MAQ_CONSTRUCCION',
    unitCode: 'UND',
    salePrice: '350.00',
    initialStock: '12',
  },
  {
    sku: 'DEMO-SKU-002',
    name: 'Tubo PVC 1/2" x 5m',
    categoryCode: 'GASF_TUBERIAS',
    unitCode: 'UND',
    salePrice: '18.50',
    initialStock: '80',
  },
  {
    sku: 'DEMO-SKU-003',
    name: 'Bomba de agua 1HP',
    brand: 'HidroMax',
    categoryCode: 'SIST_AGUA',
    unitCode: 'UND',
    salePrice: '480.00',
    initialStock: '6',
  },
  {
    sku: 'DEMO-SKU-004',
    name: 'Manguera hidráulica 3/4" (metro)',
    categoryCode: 'EQ_HIDRAULICOS',
    unitCode: 'MTR',
    salePrice: '22.00',
    initialStock: '150',
  },
  {
    sku: 'DEMO-SKU-005',
    name: 'Pintura látex blanco (galón)',
    brand: 'ColorPlus',
    categoryCode: 'PINTURA',
    unitCode: 'GLN',
    salePrice: '65.00',
    initialStock: '40',
  },
  {
    sku: 'DEMO-SKU-006',
    name: 'Kit de empaquetaduras universal',
    categoryCode: 'REPUESTOS',
    unitCode: 'JGO',
    salePrice: '15.00',
    initialStock: '25',
  },
  {
    sku: 'DEMO-SKU-007',
    name: 'Servicio de instalación técnica',
    categoryCode: 'SERVICIOS',
    unitCode: 'SER',
    salePrice: '120.00',
    initialStock: null,
  },
];

export function requireEnv(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim().length === 0) {
    throw new Error(
      `${name} es obligatorio para ejecutar el seed de demostración. ` +
        'Defínelo en .env (ver .env.example).',
    );
  }
  return value;
}

/**
 * Bloquea la ejecución completa antes de tocar la base de datos si el
 * entorno es de producción. Deliberadamente sin bandera de bypass.
 */
export function assertNotProduction(): void {
  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'El seed de demostración no puede ejecutarse con NODE_ENV=production. ' +
        'Está reservado para desarrollo y demostraciones locales desechables.',
    );
  }
}

/**
 * Crea (o, en reejecuciones, deja intacto) el usuario multi-rol de
 * demostración. En la creación fija passwordHash + mustChangePassword=true;
 * en reejecuciones NUNCA toca password/mustChangePassword — solo asegura,
 * de forma idempotente, que las 4 asignaciones de rol existan.
 */
export async function seedDemoUser(
  prisma: DemoSeedPrismaClient,
  password: string,
): Promise<{ userId: string; created: boolean }> {
  assertPasswordPolicy(
    password,
    (violations) =>
      `DEMO_USER_PASSWORD no cumple la política de contraseñas: ${violations.join(', ')}.`,
  );

  const roles = await prisma.role.findMany({
    where: { name: { in: DEMO_USER_ROLES as RoleName[] } },
  });
  if (roles.length !== DEMO_USER_ROLES.length) {
    throw new Error(
      'No se encontraron los 4 roles base (ADMIN, SELLER, WAREHOUSE, ' +
        'MANAGEMENT). Ejecuta primero "npm run db:seed".',
    );
  }

  const existing = await prisma.user.findUnique({
    where: { email: DEMO_USER_EMAIL },
  });

  if (existing !== null) {
    // Idempotencia de roles sin tocar password/mustChangePassword ni borrar
    // asignaciones existentes de otros roles.
    for (const role of roles) {
      await prisma.userRole.upsert({
        where: { userId_roleId: { userId: existing.id, roleId: role.id } },
        update: {},
        create: { userId: existing.id, roleId: role.id },
      });
    }
    return { userId: existing.id, created: false };
  }

  const passwordHash = await hashPassword(password);
  const created = await prisma.user.create({
    data: {
      firstName: DEMO_USER_FIRST_NAME,
      lastName: DEMO_USER_LAST_NAME,
      username: DEMO_USER_USERNAME,
      email: DEMO_USER_EMAIL,
      passwordHash,
      status: 'ACTIVE',
      mustChangePassword: true,
      // Las 4 asignaciones se crean en la MISMA operación que el usuario —
      // igual que seedInitialAdmin() en prisma/seed.ts — nunca una fila de
      // usuario transitoriamente sin ningún rol.
      roles: { create: roles.map((role) => ({ roleId: role.id })) },
    },
  });
  return { userId: created.id, created: true };
}

/**
 * Dos clientes no genéricos de demostración, con `code` determinístico
 * prefijado "DEMO-" (nunca 'PUBLIC_GENERAL', reservado al cliente genérico
 * de prisma/seed.ts). `update: {}` a propósito, mismo criterio que
 * seedCategories()/seedDocumentSequences() en prisma/seed.ts: reejecutar el
 * seed nunca pisa ediciones legítimas de un operador.
 */
export async function seedDemoCustomers(
  prisma: DemoSeedPrismaClient,
): Promise<void> {
  await prisma.customer.upsert({
    where: { code: DEMO_CUSTOMER_COMPANY_CODE },
    update: {},
    create: {
      code: DEMO_CUSTOMER_COMPANY_CODE,
      customerType: CustomerType.COMPANY,
      customerStage: CustomerStage.CUSTOMER,
      name: 'Constructora Sintética Demo S.A.C.',
      // RUC sintético de 11 dígitos, sin correspondencia con ningún
      // contribuyente real — usable en el flujo de FACTURA del README.
      documentType: CustomerDocumentType.RUC,
      documentNumber: '20123456789',
      email: 'contacto@constructorademo.test',
      phone: '01-555-0100',
      address: 'Av. Demo 123, Lima (dato sintético)',
      isGeneric: false,
      status: 'ACTIVE',
    },
  });

  await prisma.customer.upsert({
    where: { code: DEMO_CUSTOMER_PERSON_CODE },
    update: {},
    create: {
      code: DEMO_CUSTOMER_PERSON_CODE,
      customerType: CustomerType.PERSON,
      customerStage: CustomerStage.CUSTOMER,
      name: 'Ana Torres Demo',
      // DNI sintético de 8 dígitos, sin correspondencia con ninguna persona
      // real.
      documentType: CustomerDocumentType.DNI,
      documentNumber: '12345678',
      email: 'ana.torres.demo@example.test',
      phone: '999-000-111',
      isGeneric: false,
      status: 'ACTIVE',
    },
  });

  console.log('Clientes de demostración verificados: 2 (DEMO-CUST-COMPANY, DEMO-CUST-PERSON)');
}

export interface SeededDemoProduct {
  id: string;
  sku: string;
  isInventoryTracked: boolean;
  initialStock: string | null;
}

/**
 * Upsert por `sku` (determinístico, prefijo "DEMO-"): reejecutar el seed
 * nunca duplica productos ni pisa ediciones posteriores de un operador
 * (`update: {}`, mismo criterio que seedCategories()/seedUnits() en
 * prisma/seed.ts). Usa exclusivamente Category/Unit ya sembrados por
 * `npm run db:seed` — nunca inventa una categoría/unidad nueva.
 */
export async function seedDemoProducts(
  prisma: DemoSeedPrismaClient,
): Promise<SeededDemoProduct[]> {
  const results: SeededDemoProduct[] = [];

  for (const spec of DEMO_PRODUCTS) {
    const [category, unit] = await Promise.all([
      prisma.category.findUnique({ where: { code: spec.categoryCode } }),
      prisma.unit.findUnique({ where: { code: spec.unitCode } }),
    ]);
    if (category === null || unit === null) {
      throw new Error(
        `Categoría "${spec.categoryCode}" o unidad "${spec.unitCode}" no ` +
          'encontrada. Ejecuta primero "npm run db:seed".',
      );
    }

    const isService = spec.initialStock === null;
    const product = await prisma.product.upsert({
      where: { sku: spec.sku },
      update: {},
      create: {
        sku: spec.sku,
        name: spec.name,
        brand: spec.brand ?? null,
        productType: isService ? ProductType.SERVICE : ProductType.PRODUCT,
        categoryId: category.id,
        unitId: unit.id,
        salePrice: spec.salePrice,
        isInventoryTracked: !isService,
        status: 'ACTIVE',
      },
    });

    results.push({
      id: product.id,
      sku: product.sku,
      isInventoryTracked: product.isInventoryTracked,
      initialStock: spec.initialStock,
    });
  }

  console.log(`Productos de demostración verificados: ${results.length}`);
  return results;
}

/**
 * Registra el saldo inicial de cada producto inventariable usando
 * StockMovementEngine.apply() — el MISMO motor transaccional que
 * InventoryService usa en producción (Fase 3, único punto que puede
 * escribir Product.stockCurrent). Nunca escribe stockCurrent a mano.
 *
 * Idempotente por diseño del propio motor: si el producto ya tiene stock
 * distinto de cero o ya registra movimientos, apply() lanza
 * ConflictException (mismo comportamiento que un segundo intento manual vía
 * API) — el seed interpreta ese rechazo como "ya existía" y continúa, sin
 * reintentar ni duplicar el saldo inicial.
 */
export async function seedDemoStock(
  prisma: DemoSeedPrismaClient,
  engine: Pick<StockMovementEngine, 'apply'>,
  products: readonly SeededDemoProduct[],
  actorUserId: string,
): Promise<{ createdCount: number; alreadyExistedCount: number }> {
  let createdCount = 0;
  let alreadyExistedCount = 0;

  for (const product of products) {
    if (!product.isInventoryTracked || product.initialStock === null) {
      continue;
    }

    const command: StockMovementCommand = {
      productId: product.id,
      quantity: new Prisma.Decimal(product.initialStock),
      movementType: InventoryMovementType.ENTRY,
      origin: InventoryMovementOrigin.INITIAL_BALANCE,
      reason: 'Saldo inicial de demostración (Fase 12, Bloque C)',
      notes: null,
      actorUserId,
      ipAddress: null,
      referenceType: null,
      referenceId: null,
    };

    try {
      await prisma.$transaction((tx) => engine.apply(tx, command));
      createdCount += 1;
    } catch (error) {
      if (error instanceof ConflictException) {
        // Ya tiene stock o movimientos previos: exactamente el resultado
        // esperado en una reejecución. No es un error del seed.
        alreadyExistedCount += 1;
        continue;
      }
      throw error;
    }
  }

  return { createdCount, alreadyExistedCount };
}

const prisma = new PrismaService();
const auditService = new AuditService(prisma);
const stockEngine = new StockMovementEngine(auditService);

// DemoSeedPrismaClient declara únicamente los métodos que este seed usa con
// tipos deliberadamente laxos (Record<string, unknown> en create/update) para
// que un doble de prueba mínimo pueda satisfacerlo en demo-seed.spec.ts sin
// implementar el delegado Prisma completo (docenas de métodos irrelevantes
// aquí). PrismaService es estructuralmente más estricto en esos mismos
// campos, así que este cast angosto (mismo patrón que
// stock-movement.engine.spec.ts: `as unknown as AuditService`) es la forma
// establecida en este repo de acotar un tipo real a un subconjunto de prueba.
const demoSeedPrisma = prisma as unknown as DemoSeedPrismaClient;

async function main(): Promise<void> {
  assertNotProduction();
  const password = requireEnv('DEMO_USER_PASSWORD');

  const { userId, created } = await seedDemoUser(demoSeedPrisma, password);
  await seedDemoCustomers(demoSeedPrisma);
  const products = await seedDemoProducts(demoSeedPrisma);
  const stock = await seedDemoStock(demoSeedPrisma, stockEngine, products, userId);

  console.log('');
  console.log('Datos de demostración listos.');
  console.log(`Usuario: ${DEMO_USER_EMAIL} (${created ? 'creado ahora' : 'ya existía, sin cambios'})`);
  console.log(`Roles asignados: ${DEMO_USER_ROLES.join(', ')}`);
  console.log(`Productos: ${products.length}`);
  console.log('Clientes: 2 (más "Público general" del seed de infraestructura)');
  console.log(
    stock.createdCount > 0
      ? `Stock inicial creado para ${stock.createdCount} producto(s) (${stock.alreadyExistedCount} ya existía(n)).`
      : 'Stock inicial ya existía para todos los productos (sin cambios).',
  );
  console.log('Usa la contraseña definida en DEMO_USER_PASSWORD para iniciar sesión.');
  console.log('El primer inicio de sesión exige cambiar la contraseña (mustChangePassword).');
  console.log('Siguiente paso: sección "Datos de demostración opcionales" en README.md.');
}

// Guarda de entrypoint: importar este módulo (p. ej. desde
// demo-seed.test.ts, para probar seedDemoUser/seedDemoCustomers/
// seedDemoProducts/seedDemoStock de forma aislada) NUNCA debe disparar
// main() ni tocar la base de datos. Solo se ejecuta cuando el archivo es
// invocado directamente (`npm run db:seed:demo`).
if (require.main === module) {
  main()
    .catch((error: unknown) => {
      console.error(error instanceof Error ? error.message : error);
      process.exitCode = 1;
    })
    .finally(() => {
      void prisma.$disconnect();
    });
}
