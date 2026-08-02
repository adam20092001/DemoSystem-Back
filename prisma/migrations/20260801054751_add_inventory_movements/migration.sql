-- CreateEnum
CREATE TYPE "InventoryMovementType" AS ENUM ('ENTRY', 'EXIT', 'ADJUSTMENT_IN', 'ADJUSTMENT_OUT');

-- CreateEnum
CREATE TYPE "InventoryMovementOrigin" AS ENUM ('MANUAL', 'INITIAL_BALANCE', 'SALE', 'SALE_CANCELLATION', 'OTHER');

-- CreateTable
CREATE TABLE "inventory_movements" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "movement_type" "InventoryMovementType" NOT NULL,
    "origin" "InventoryMovementOrigin" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "previous_stock" DECIMAL(14,3) NOT NULL,
    "new_stock" DECIMAL(14,3) NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "notes" VARCHAR(500),
    "reference_type" VARCHAR(50),
    "reference_id" VARCHAR(64),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_movements_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "inventory_movements_product_id_created_at_idx" ON "inventory_movements"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_created_at_idx" ON "inventory_movements"("created_at");

-- CreateIndex
CREATE INDEX "inventory_movements_created_by_user_id_created_at_idx" ON "inventory_movements"("created_by_user_id", "created_at");

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_movements" ADD CONSTRAINT "inventory_movements_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =============================================================
-- Añadido manualmente (Fase 3, Bloque A): Prisma DSL no expresa CHECK ni
-- índices únicos parciales en esta versión. Ver el plan técnico aprobado
-- para la justificación de cada restricción.
-- =============================================================

-- CHECK 1: cantidad siempre positiva. La dirección la aporta movement_type.
ALTER TABLE "inventory_movements"
ADD CONSTRAINT "inventory_movements_quantity_positive"
CHECK ("quantity" > 0);

-- CHECK 2: saldo previo nunca negativo.
ALTER TABLE "inventory_movements"
ADD CONSTRAINT "inventory_movements_previous_stock_non_negative"
CHECK ("previous_stock" >= 0);

-- CHECK 3: saldo nuevo nunca negativo.
ALTER TABLE "inventory_movements"
ADD CONSTRAINT "inventory_movements_new_stock_non_negative"
CHECK ("new_stock" >= 0);

-- CHECK 4: consistencia aritmética EXACTA entre quantity y la variación de
-- stock. NUMERIC se compara en PostgreSQL con precisión decimal exacta, sin
-- el error de representación de punto flotante binario.
ALTER TABLE "inventory_movements"
ADD CONSTRAINT "inventory_movements_stock_consistency"
CHECK (
  (
    "movement_type" IN ('ENTRY', 'ADJUSTMENT_IN')
    AND "new_stock" = "previous_stock" + "quantity"
  )
  OR
  (
    "movement_type" IN ('EXIT', 'ADJUSTMENT_OUT')
    AND "new_stock" = "previous_stock" - "quantity"
  )
);

-- CHECK 5: consistencia entre origin y movement_type. Para INITIAL_BALANCE
-- se refuerza además que previous_stock sea cero y que no haya referencia
-- (defensa de última línea; la regla de negocio completa —incluida "sin
-- movimientos previos"— se valida bajo lock en el Bloque B).
ALTER TABLE "inventory_movements"
ADD CONSTRAINT "inventory_movements_origin_type_consistency"
CHECK (
  (
    "origin" <> 'INITIAL_BALANCE'
    OR (
      "movement_type" = 'ENTRY'
      AND "previous_stock" = 0
      AND "reference_type" IS NULL
      AND "reference_id" IS NULL
    )
  )
  AND
  (
    "origin" <> 'SALE'
    OR "movement_type" = 'EXIT'
  )
  AND
  (
    "origin" <> 'SALE_CANCELLATION'
    OR "movement_type" = 'ENTRY'
  )
);

-- CHECK 6: referencia polimórfica completa o completamente ausente.
ALTER TABLE "inventory_movements"
ADD CONSTRAINT "inventory_movements_reference_pair"
CHECK (
  (
    "reference_type" IS NULL
    AND "reference_id" IS NULL
  )
  OR
  (
    "reference_type" IS NOT NULL
    AND "reference_id" IS NOT NULL
  )
);

-- Índice único parcial: como máximo un INITIAL_BALANCE por producto. No
-- garantiza por sí solo que el saldo inicial sea el primer movimiento del
-- producto; esa regla se valida bajo lock en el Bloque B.
CREATE UNIQUE INDEX
"inventory_movements_one_initial_balance_per_product"
ON "inventory_movements" ("product_id")
WHERE "origin" = 'INITIAL_BALANCE';
