import { PrismaClient } from '@prisma/client';

/**
 * Cliente Prisma exclusivo de e2e. Verifica en cada creación que
 * DATABASE_URL apunte a pos_db_test, para que un error de configuración no
 * arriesgue accidentalmente la base de desarrollo.
 */
export function createTestPrismaClient(): PrismaClient {
  if (!process.env.DATABASE_URL?.includes('pos_db_test')) {
    throw new Error(
      'createTestPrismaClient: DATABASE_URL no apunta a pos_db_test. ' +
        'Abortando para no operar sobre la base incorrecta.',
    );
  }
  return new PrismaClient();
}
