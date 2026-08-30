/**
 * Auto-prueba de prisma/demo-seed.ts.
 *
 * Se ejecuta manualmente con:
 *   npx ts-node --project prisma/tsconfig.seed.json prisma/demo-seed.test.ts
 *
 * Vive en prisma/, no en src/, así que Jest (rootDir: 'src') no la recoge:
 * no altera el conteo de la suite unitaria existente (77 suites / 2491
 * tests) — mismo criterio que scripts/db-test-clean-volume.test.js en la
 * Fase 12B. No toca pos_db ni pos_db_test: cada función se prueba con un
 * doble de prueba manual (sin librería de mocking nueva) que registra
 * llamadas y devuelve datos fijos.
 *
 * Los 3 guardas más críticos (NODE_ENV=production, DEMO_USER_PASSWORD
 * ausente, política de contraseña débil) ya se probaron en vivo contra el
 * script real (sin tocar la base, porque lanzan antes de cualquier consulta
 * Prisma) durante la Fase 12C; aquí se cubre además lo que un doble de
 * prueba puede probar mejor: comportamiento de creación/reejecución,
 * idempotencia de roles, upserts determinísticos e idempotencia de stock.
 */
import assert from 'node:assert/strict';
import { InventoryMovementOrigin, RoleName } from '@prisma/client';
import { ConflictException } from '@nestjs/common';
import {
  DemoSeedPrismaClient,
  SeededDemoProduct,
  seedDemoCustomers,
  seedDemoProducts,
  seedDemoStock,
  seedDemoUser,
} from './demo-seed';
import { StockMovementEngine } from '../src/inventory/stock-movement.engine';

let passed = 0;

async function test(name: string, fn: () => Promise<void> | void): Promise<void> {
  await fn();
  passed += 1;
  console.log(`  ok - ${name}`);
}

/** Registra cada llamada (nombre + argumentos) para poder inspeccionarlas. */
function callTracker() {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  return {
    calls,
    record(method: string, args: unknown[]): void {
      calls.push({ method, args });
    },
  };
}

const ALL_ROLES = [
  { id: 'role-admin', name: RoleName.ADMIN },
  { id: 'role-seller', name: RoleName.SELLER },
  { id: 'role-warehouse', name: RoleName.WAREHOUSE },
  { id: 'role-management', name: RoleName.MANAGEMENT },
];

const VALID_PASSWORD = 'ClaveDemo1234Segura';

console.log('prisma/demo-seed.ts — auto-prueba');

async function run(): Promise<void> {
  await test('seedDemoUser: primera ejecución crea el usuario con los 4 roles', async () => {
    const tracker = callTracker();
    const fakePrisma: DemoSeedPrismaClient = {
      role: {
        findMany: async (args) => {
          tracker.record('role.findMany', [args]);
          return ALL_ROLES;
        },
      },
      user: {
        findUnique: async (args) => {
          tracker.record('user.findUnique', [args]);
          return null; // no existe todavía
        },
        create: async (args) => {
          tracker.record('user.create', [args]);
          assert.equal(args.data.mustChangePassword, true);
          assert.ok(typeof args.data.passwordHash === 'string');
          assert.notEqual(args.data.passwordHash, VALID_PASSWORD); // nunca texto plano
          const roles = args.data.roles as { create: Array<{ roleId: string }> };
          assert.equal(roles.create.length, 4);
          return { id: 'user-1' };
        },
      },
      userRole: {
        upsert: async (args) => {
          tracker.record('userRole.upsert', [args]);
          return {};
        },
      },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => null },
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };

    const result = await seedDemoUser(fakePrisma, VALID_PASSWORD);
    assert.deepEqual(result, { userId: 'user-1', created: true });
    // En la creación NUNCA se llama userRole.upsert (las 4 asignaciones se
    // crean anidadas en la misma operación user.create).
    assert.equal(tracker.calls.filter((c) => c.method === 'userRole.upsert').length, 0);
  });

  await test('seedDemoUser: DEFECTO A EVITAR — reejecución NUNCA llama user.create ni toca password', async () => {
    const tracker = callTracker();
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => ALL_ROLES },
      user: {
        findUnique: async () => ({ id: 'user-existing' }), // ya existe
        create: async (args) => {
          tracker.record('user.create', [args]);
          throw new Error('user.create NUNCA debe llamarse en una reejecución');
        },
      },
      userRole: {
        upsert: async (args) => {
          tracker.record('userRole.upsert', [args]);
          return {};
        },
      },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => null },
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };

    const result = await seedDemoUser(fakePrisma, VALID_PASSWORD);
    assert.deepEqual(result, { userId: 'user-existing', created: false });
    assert.equal(tracker.calls.filter((c) => c.method === 'user.create').length, 0);
  });

  await test('seedDemoUser: reejecución asegura los 4 roles sin duplicar (un upsert por rol, ninguno repetido)', async () => {
    const tracker = callTracker();
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => ALL_ROLES },
      user: {
        findUnique: async () => ({ id: 'user-existing' }),
        create: async () => {
          throw new Error('no debería llamarse');
        },
      },
      userRole: {
        upsert: async (args) => {
          tracker.record('userRole.upsert', [args]);
          return {};
        },
      },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => null },
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };

    await seedDemoUser(fakePrisma, VALID_PASSWORD);
    const roleUpsertCalls = tracker.calls.filter((c) => c.method === 'userRole.upsert');
    assert.equal(roleUpsertCalls.length, 4);
    const roleIds = roleUpsertCalls.map(
      (c) => (c.args[0] as { create: { roleId: string } }).create.roleId,
    );
    assert.deepEqual(new Set(roleIds).size, 4); // los 4 son distintos, ninguno repetido
    for (const call of roleUpsertCalls) {
      const arg = call.args[0] as { update: Record<string, never> };
      assert.deepEqual(arg.update, {}); // nunca escribe nada al reasignar un rol ya existente
    }
  });

  await test('seedDemoCustomers: upsert determinístico por code DEMO-CUST-*, update vacío', async () => {
    const tracker = callTracker();
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => [] },
      user: { findUnique: async () => null, create: async () => ({ id: '' }) },
      userRole: { upsert: async () => ({}) },
      customer: {
        upsert: async (args) => {
          tracker.record('customer.upsert', [args]);
          return {};
        },
      },
      category: { findUnique: async () => null },
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };

    await seedDemoCustomers(fakePrisma);
    assert.equal(tracker.calls.length, 2);
    const codes = tracker.calls.map((c) => (c.args[0] as { where: { code: string } }).where.code);
    assert.deepEqual(codes.sort(), ['DEMO-CUST-COMPANY', 'DEMO-CUST-PERSON']);
    for (const call of tracker.calls) {
      const arg = call.args[0] as { update: Record<string, never>; create: { code: string } };
      assert.deepEqual(arg.update, {});
      assert.ok(arg.create.code.startsWith('DEMO-')); // identificador reconocible (Fase 12C §41)
    }
  });

  await test('seedDemoProducts: upsert determinístico por sku DEMO-SKU-*, falla claro si falta categoría/unidad', async () => {
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => [] },
      user: { findUnique: async () => null, create: async () => ({ id: '' }) },
      userRole: { upsert: async () => ({}) },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => null }, // simula infraestructura no sembrada
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };

    await assert.rejects(
      () => seedDemoProducts(fakePrisma),
      /Ejecuta primero "npm run db:seed"/,
    );
  });

  await test('seedDemoProducts: con catálogo base disponible, upsert de todos los SKU con update vacío', async () => {
    const tracker = callTracker();
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => [] },
      user: { findUnique: async () => null, create: async () => ({ id: '' }) },
      userRole: { upsert: async () => ({}) },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => ({ id: 'cat-1' }) },
      unit: { findUnique: async () => ({ id: 'unit-1' }) },
      product: {
        upsert: async (args) => {
          tracker.record('product.upsert', [args]);
          return { id: `id-${(args.create as { sku: string }).sku}`, sku: (args.create as { sku: string }).sku, isInventoryTracked: (args.create as { isInventoryTracked: boolean }).isInventoryTracked };
        },
      },
      $transaction: async (fn) => fn({} as never),
    };

    const products = await seedDemoProducts(fakePrisma);
    assert.ok(products.length >= 5 && products.length <= 8); // rango pedido en el kickoff
    assert.ok(products.every((p) => p.sku.startsWith('DEMO-SKU-')));
    assert.ok(products.some((p) => !p.isInventoryTracked)); // al menos un SERVICE
    for (const call of tracker.calls) {
      const arg = call.args[0] as { update: Record<string, never> };
      assert.deepEqual(arg.update, {});
    }
  });

  await test('seedDemoStock: crea saldo inicial solo para productos inventariables', async () => {
    const applied: unknown[] = [];
    const fakeEngine: Pick<StockMovementEngine, 'apply'> = {
      apply: async (_tx, command) => {
        applied.push(command);
        return {} as never;
      },
    };
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => [] },
      user: { findUnique: async () => null, create: async () => ({ id: '' }) },
      userRole: { upsert: async () => ({}) },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => null },
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };
    const products: SeededDemoProduct[] = [
      { id: 'p1', sku: 'DEMO-SKU-001', isInventoryTracked: true, initialStock: '10' },
      { id: 'p2', sku: 'DEMO-SKU-007', isInventoryTracked: false, initialStock: null }, // SERVICE
    ];

    const result = await seedDemoStock(fakePrisma, fakeEngine, products, 'actor-1');
    assert.equal(result.createdCount, 1);
    assert.equal(result.alreadyExistedCount, 0);
    assert.equal(applied.length, 1);
    const command = applied[0] as { origin: InventoryMovementOrigin; productId: string };
    assert.equal(command.origin, InventoryMovementOrigin.INITIAL_BALANCE);
    assert.equal(command.productId, 'p1'); // nunca el SERVICE
  });

  await test('seedDemoStock: DEFECTO A EVITAR — reejecución no duplica el saldo (ConflictException se cuenta, no se relanza)', async () => {
    const fakeEngine: Pick<StockMovementEngine, 'apply'> = {
      apply: async () => {
        throw new ConflictException('El producto ya tiene stock distinto de cero');
      },
    };
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => [] },
      user: { findUnique: async () => null, create: async () => ({ id: '' }) },
      userRole: { upsert: async () => ({}) },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => null },
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };
    const products: SeededDemoProduct[] = [
      { id: 'p1', sku: 'DEMO-SKU-001', isInventoryTracked: true, initialStock: '10' },
    ];

    const result = await seedDemoStock(fakePrisma, fakeEngine, products, 'actor-1');
    assert.equal(result.createdCount, 0);
    assert.equal(result.alreadyExistedCount, 1); // tratado como "ya existía", no como error
  });

  await test('seedDemoStock: un error distinto a ConflictException SÍ se propaga (no se silencia)', async () => {
    const fakeEngine: Pick<StockMovementEngine, 'apply'> = {
      apply: async () => {
        throw new Error('fallo de base de datos inesperado');
      },
    };
    const fakePrisma: DemoSeedPrismaClient = {
      role: { findMany: async () => [] },
      user: { findUnique: async () => null, create: async () => ({ id: '' }) },
      userRole: { upsert: async () => ({}) },
      customer: { upsert: async () => ({}) },
      category: { findUnique: async () => null },
      unit: { findUnique: async () => null },
      product: { upsert: async () => ({ id: '', sku: '', isInventoryTracked: true }) },
      $transaction: async (fn) => fn({} as never),
    };
    const products: SeededDemoProduct[] = [
      { id: 'p1', sku: 'DEMO-SKU-001', isInventoryTracked: true, initialStock: '10' },
    ];

    await assert.rejects(
      () => seedDemoStock(fakePrisma, fakeEngine, products, 'actor-1'),
      /fallo de base de datos inesperado/,
    );
  });

  console.log(`\n${passed} aserciones pasaron. Ningún comando real de Prisma/Docker fue ejecutado.`);
}

run().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
