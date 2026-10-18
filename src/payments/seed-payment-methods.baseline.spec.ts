import { readFileSync } from 'fs';
import { join } from 'path';

/**
 * NR-01: valida el baseline real de `prisma/seed.ts` (SEED_PAYMENT_METHODS)
 * SIN importar ese archivo: `seed.ts` es un script que instancia
 * PrismaClient y ejecuta `main()` al cargarse (no distingue "importado" de
 * "ejecutado como entrypoint"), así que importarlo abriría una conexión
 * real a base de datos. Se lee el código fuente como texto plano y se
 * valida por bloque de método con una expresión regular — sin Prisma, sin
 * conexión, sin efectos secundarios.
 */
describe('SEED_PAYMENT_METHODS baseline (NR-01: referencia opcional por defecto)', () => {
  const seedSource = readFileSync(
    join(__dirname, '../../prisma/seed.ts'),
    'utf-8',
  );

  function requiresReferenceFor(code: string): boolean {
    const blockPattern = new RegExp(
      `code:\\s*'${code}'[\\s\\S]*?requiresReference:\\s*(true|false)`,
    );
    const match = blockPattern.exec(seedSource);
    if (!match) {
      throw new Error(
        `No se encontró el bloque de SEED_PAYMENT_METHODS para "${code}"`,
      );
    }
    return match[1] === 'true';
  }

  it.each(['CASH', 'CARD', 'TRANSFER', 'YAPE', 'PLIN'])(
    '%s (activo): requiresReference=false en el baseline',
    (code) => {
      expect(requiresReferenceFor(code)).toBe(false);
    },
  );

  it.each([
    ['BANK_TRANSFER', true],
    ['BANK_DEPOSIT', true],
    ['DIGITAL_WALLET', false],
    ['OTHER', false],
  ] as const)(
    '%s (legacy inactivo): requiresReference sin cambios respecto al baseline previo a NR-01',
    (code, expected) => {
      expect(requiresReferenceFor(code)).toBe(expected);
    },
  );

  it('seedPaymentMethods() sigue usando upsert con update: {} (NR-01 no debe tocar la lógica de upsert)', () => {
    expect(seedSource).toMatch(
      /async function seedPaymentMethods[\s\S]*?update:\s*\{\}/,
    );
  });
});
