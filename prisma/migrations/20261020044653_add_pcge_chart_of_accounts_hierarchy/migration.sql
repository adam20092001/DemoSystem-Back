-- Nota manual (Fase A1): Prisma generó `updated_at` como columna NOT NULL
-- SIN cláusula DEFAULT a pesar de `@default(now()) @updatedAt` en el
-- schema (comportamiento conocido del motor de diff al agregar esta
-- combinación sobre una tabla ya poblada) — bloqueaba las 6 filas
-- existentes con 23502. Se agrega DEFAULT CURRENT_TIMESTAMP a mano, mismo
-- criterio que created_at arriba y que el resto del dominio (Category,
-- CompanySettings, etc.): Prisma Client sigue reescribiendo esta columna
-- en cada `.update()` real sin importar este default, que solo cubre el
-- backfill de las filas existentes y el INSERT inicial.

-- CreateEnum
CREATE TYPE "AccountStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterEnum
-- This migration adds more than one value to an enum.
-- With PostgreSQL versions 11 and earlier, this is not possible
-- in a single migration. This can be worked around by creating
-- multiple migrations, each migration adding only one value to
-- the enum.


ALTER TYPE "AccountType" ADD VALUE 'EQUITY';
ALTER TYPE "AccountType" ADD VALUE 'EXPENSE';
ALTER TYPE "AccountType" ADD VALUE 'COST';

-- AlterTable
ALTER TABLE "chart_of_accounts" ADD COLUMN     "is_postable" BOOLEAN NOT NULL DEFAULT true,
ADD COLUMN     "level" INTEGER NOT NULL DEFAULT 1,
ADD COLUMN     "parent_id" UUID,
ADD COLUMN     "status" "AccountStatus" NOT NULL DEFAULT 'ACTIVE',
ADD COLUMN     "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
ALTER COLUMN "name" SET DATA TYPE VARCHAR(150),
ALTER COLUMN "system_key" DROP NOT NULL;

-- CreateIndex
CREATE INDEX "chart_of_accounts_parent_id_idx" ON "chart_of_accounts"("parent_id");

-- CreateIndex
CREATE INDEX "chart_of_accounts_status_idx" ON "chart_of_accounts"("status");

-- AddForeignKey
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "chart_of_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Fase A1) --------------------------------------
-- El DSL de Prisma no expresa CHECK de forma declarativa; se agregan a
-- mano, mismo criterio que Category/Unit/Product/Sale/Payment/
-- InventoryMovement/Fase 8. Puramente aditivo: ningún CHECK previo se
-- modifica en esta migración.

-- 1. level siempre positivo (1 = raíz). El cálculo real (parent.level + 1)
--    es responsabilidad exclusiva del servicio, nunca del cliente; este
--    CHECK es la última línea de defensa contra un valor corrupto.
ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_level_positive"
  CHECK ("level" >= 1);

-- 2. Una cuenta nunca puede ser su propio padre (mismo criterio que
--    accounting_entries_not_self_reversal, Fase 8). Un ciclo INDIRECTO
--    (A -> B -> A) no es expresable como CHECK de una sola fila: lo cierra
--    ChartOfAccountsService.assertNoCycle() a nivel de aplicación, mismo
--    patrón ya probado en CategoriesService.
ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_not_own_parent"
  CHECK ("parent_id" IS NULL OR "parent_id" <> "id");
