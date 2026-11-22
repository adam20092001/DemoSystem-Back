-- R2-A1 (EXPAND): almacenes, ubicaciones y saldos por ubicación.
--
-- Migración 100% ADITIVA e INERTE respecto al inventario:
--   * No modifica ni elimina ninguna tabla/columna/tipo existente: solo agrega
--     3 columnas NULLABLE en inventory_movements y 1 en sale_items y
--     purchase_receipt_lines (todas NULL, sin DEFAULT), con FK RESTRICT.
--   * NO hace backfill: stock_balances nace VACÍA y NO representa las
--     existencias actuales (siguen consolidadas en products.stock_current).
--   * NO crea triggers ni funciones, y NO impone ninguna restricción que
--     relacione products.stock_current con la suma de saldos (eso es R2-ACT).
--   * Solo inserta DATOS DE CATÁLOGO: el almacén principal MAIN y su ubicación
--     técnica DEFAULT (nunca cantidades).
-- No hay migración "down": la reversión de una base ya migrada es restaurar
-- el respaldo previo (mismo criterio que el resto del repositorio).
--
-- ATOMICIDAD: todo el archivo va en UNA transacción explícita (BEGIN/COMMIT).
-- Es compatible: no contiene ALTER TYPE ... ADD VALUE usado en la misma
-- transacción, CREATE INDEX CONCURRENTLY ni ninguna otra sentencia que
-- PostgreSQL prohíba dentro de una transacción. Un error en cualquier punto
-- revierte TODO (DDL y datos de catálogo); la migración queda registrada como
-- fallida en _prisma_migrations y no queda ningún objeto parcial. Verificado
-- con fallos inyectados en copias temporales (ver docs/r2-migration-plan.md).
-- Ninguna otra migración del repositorio usa BEGIN/COMMIT explícito; aquí se
-- agrega a propósito para no depender de cómo Prisma ejecuta el archivo.
BEGIN;

-- CreateEnum
CREATE TYPE "WarehouseStatus" AS ENUM ('ACTIVE', 'INACTIVE');

-- AlterTable
ALTER TABLE "inventory_movements" ADD COLUMN     "location_id" UUID,
ADD COLUMN     "location_new_stock" DECIMAL(14,3),
ADD COLUMN     "location_previous_stock" DECIMAL(14,3);

-- AlterTable
ALTER TABLE "purchase_receipt_lines" ADD COLUMN     "location_id" UUID;

-- AlterTable
ALTER TABLE "sale_items" ADD COLUMN     "location_id" UUID;

-- CreateTable
CREATE TABLE "warehouses" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(300),
    "status" "WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "warehouse_locations" (
    "id" UUID NOT NULL,
    "warehouse_id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "description" VARCHAR(300),
    "status" "WarehouseStatus" NOT NULL DEFAULT 'ACTIVE',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "warehouse_locations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "stock_balances" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "location_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "stock_balances_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "warehouses_code_key" ON "warehouses"("code");

-- CreateIndex
CREATE UNIQUE INDEX "warehouse_locations_warehouse_id_code_key" ON "warehouse_locations"("warehouse_id", "code");

-- CreateIndex
CREATE INDEX "stock_balances_location_id_idx" ON "stock_balances"("location_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_balances_product_id_location_id_key" ON "stock_balances"("product_id", "location_id");

-- CreateIndex
CREATE INDEX "inventory_movements_location_id_idx" ON "inventory_movements"("location_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_lines_location_id_idx" ON "purchase_receipt_lines"("location_id");

-- CreateIndex
CREATE INDEX "sale_items_location_id_idx" ON "sale_items"("location_id");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "warehouse_locations" ADD CONSTRAINT "warehouse_locations_warehouse_id_fkey" FOREIGN KEY ("warehouse_id") REFERENCES "warehouses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_balances" ADD CONSTRAINT "stock_balances_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_location_id_fkey" FOREIGN KEY ("location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Restricciones manuales (R2-A1) -------------------------------------------
-- El DSL de Prisma no expresa CHECK, UPPER()/BTRIM() ni índices parciales;
-- se agregan a mano, mismo criterio que suppliers/customers.

-- 1. Códigos siempre normalizados (mayúsculas, sin espacios perimetrales) y
--    no vacíos: la unicidad exacta de "warehouses_code_key" y de
--    "warehouse_locations_warehouse_id_code_key" equivale así a unicidad
--    insensible a mayúsculas/espacios. El servicio normaliza antes de insertar.
ALTER TABLE "warehouses"
  ADD CONSTRAINT "warehouses_code_normalized"
  CHECK ("code" = UPPER(BTRIM("code")) AND "code" <> '');

ALTER TABLE "warehouse_locations"
  ADD CONSTRAINT "warehouse_locations_code_normalized"
  CHECK ("code" = UPPER(BTRIM("code")) AND "code" <> '');

-- 2. Nombres nunca vacíos ni solo espacios.
ALTER TABLE "warehouses"
  ADD CONSTRAINT "warehouses_name_not_blank"
  CHECK (BTRIM("name") <> '');

ALTER TABLE "warehouse_locations"
  ADD CONSTRAINT "warehouse_locations_name_not_blank"
  CHECK (BTRIM("name") <> '');

-- 3. A lo sumo UN almacén predeterminado.
CREATE UNIQUE INDEX "warehouses_one_default"
  ON "warehouses" ("is_default")
  WHERE "is_default" = true;

-- 4. La ubicación técnica DEFAULT: exactamente la que tiene código 'DEFAULT'
--    (nunca otra, nunca con otro código) y a lo sumo una por almacén.
ALTER TABLE "warehouse_locations"
  ADD CONSTRAINT "warehouse_locations_default_code"
  CHECK (("code" = 'DEFAULT') = "is_default");

CREATE UNIQUE INDEX "warehouse_locations_one_default_per_warehouse"
  ON "warehouse_locations" ("warehouse_id")
  WHERE "is_default" = true;

-- 5. Un saldo por ubicación nunca es negativo (la tabla está vacía en R2-A1).
ALTER TABLE "stock_balances"
  ADD CONSTRAINT "stock_balances_quantity_non_negative"
  CHECK ("quantity" >= 0);

-- 6. Columnas de ubicación del movimiento: las tres nulas o las tres no
--    nulas. Con datos, el saldo de ubicación es no negativo y obedece la misma
--    aritmética que el consolidado (inventory_movements_stock_consistency).
--    Ningún movimiento las llena en R2-A1 (todas NULL): el CHECK es inerte.
ALTER TABLE "inventory_movements"
  ADD CONSTRAINT "inventory_movements_location_columns_consistent"
  CHECK (
    (
      "location_id" IS NULL
      AND "location_previous_stock" IS NULL
      AND "location_new_stock" IS NULL
    )
    OR
    (
      "location_id" IS NOT NULL
      AND "location_previous_stock" IS NOT NULL
      AND "location_new_stock" IS NOT NULL
      AND "location_previous_stock" >= 0
      AND "location_new_stock" >= 0
      AND (
        (
          "movement_type" IN ('ENTRY', 'ADJUSTMENT_IN')
          AND "location_new_stock" = "location_previous_stock" + "quantity"
        )
        OR
        (
          "movement_type" IN ('EXIT', 'ADJUSTMENT_OUT')
          AND "location_new_stock" = "location_previous_stock" - "quantity"
        )
      )
    )
  );

-- Datos de catálogo base (R2-A1) -------------------------------------------
-- Almacén principal MAIN y su ubicación técnica DEFAULT. Solo estructura:
-- NO se inserta ningún saldo ni se asigna ningún movimiento a esta ubicación.
-- Idempotente (ON CONFLICT DO NOTHING). gen_random_uuid() es nativa desde
-- PostgreSQL 13 (el proyecto usa PostgreSQL 16); id/updated_at no tienen
-- DEFAULT en base de datos, por eso se proveen explícitamente.
INSERT INTO "warehouses" ("id", "code", "name", "description", "status", "is_default", "created_at", "updated_at")
VALUES (gen_random_uuid(), 'MAIN', 'Almacén principal', NULL, 'ACTIVE', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

INSERT INTO "warehouse_locations" ("id", "warehouse_id", "code", "name", "description", "status", "is_default", "created_at", "updated_at")
SELECT gen_random_uuid(), w."id", 'DEFAULT', 'Ubicación predeterminada', NULL, 'ACTIVE', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
FROM "warehouses" w
WHERE w."code" = 'MAIN'
ON CONFLICT ("warehouse_id", "code") DO NOTHING;

COMMIT;
