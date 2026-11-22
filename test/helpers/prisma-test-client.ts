import { PrismaClient } from '@prisma/client';
import { assertVerifiedE2eTarget } from './e2e-database-target';

/**
 * Cliente Prisma exclusivo de e2e. Reevalúa la política estructural de la
 * guardia compartida (INC-E2E-database-guard), exige que el destino haya sido
 * verificado por jest-e2e.global-setup.ts en esta ejecución y ata el cliente
 * EXPLÍCITAMENTE a esa URL validada (`datasourceUrl`), en vez de dejar que
 * Prisma relea DATABASE_URL del entorno. No usa coincidencia de texto.
 */
export function createTestPrismaClient(): PrismaClient {
  const target = assertVerifiedE2eTarget();
  return new PrismaClient({ datasourceUrl: target.connectionString });
}
