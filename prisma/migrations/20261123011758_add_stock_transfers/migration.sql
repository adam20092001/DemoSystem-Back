-- R2-C: transferencias de stock entre ubicaciones (migración 35, 100% aditiva).
-- AlterEnum
ALTER TYPE "InventoryMovementOrigin" ADD VALUE 'TRANSFER';

-- CreateTable
CREATE TABLE "stock_transfers" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "source_location_id" UUID NOT NULL,
    "destination_location_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "reason" VARCHAR(200) NOT NULL,
    "notes" VARCHAR(500),
    "idempotency_key" VARCHAR(100),
    "created_by_user_id" UUID NOT NULL,
    "exit_movement_id" UUID NOT NULL,
    "entry_movement_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "stock_transfers_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_exit_movement_id_key" ON "stock_transfers"("exit_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_entry_movement_id_key" ON "stock_transfers"("entry_movement_id");

-- CreateIndex
CREATE INDEX "stock_transfers_product_id_created_at_idx" ON "stock_transfers"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "stock_transfers_created_at_idx" ON "stock_transfers"("created_at");

-- CreateIndex
CREATE INDEX "stock_transfers_source_location_id_idx" ON "stock_transfers"("source_location_id");

-- CreateIndex
CREATE INDEX "stock_transfers_destination_location_id_idx" ON "stock_transfers"("destination_location_id");

-- CreateIndex
CREATE UNIQUE INDEX "stock_transfers_created_by_user_id_idempotency_key_key" ON "stock_transfers"("created_by_user_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_source_location_id_fkey" FOREIGN KEY ("source_location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_destination_location_id_fkey" FOREIGN KEY ("destination_location_id") REFERENCES "warehouse_locations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_exit_movement_id_fkey" FOREIGN KEY ("exit_movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "stock_transfers" ADD CONSTRAINT "stock_transfers_entry_movement_id_fkey" FOREIGN KEY ("entry_movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- ---------------------------------------------------------------------------
-- R2-C — restricciones a mano (el DSL de Prisma no las expresa)
-- ---------------------------------------------------------------------------

-- Cantidad positiva (el motor ya lo exige; defensa de última línea).
ALTER TABLE "stock_transfers"
ADD CONSTRAINT "stock_transfers_quantity_positive"
CHECK ("quantity" > 0);

-- Origen y destino distintos.
ALTER TABLE "stock_transfers"
ADD CONSTRAINT "stock_transfers_locations_differ"
CHECK ("source_location_id" <> "destination_location_id");

-- La clave de idempotencia, si existe, nunca está en blanco. La unicidad
-- (created_by_user_id, idempotency_key) ya admite múltiples NULL.
ALTER TABLE "stock_transfers"
ADD CONSTRAINT "stock_transfers_idempotency_key_not_blank"
CHECK ("idempotency_key" IS NULL OR BTRIM("idempotency_key") <> '');

-- Un movimiento de origen TRANSFER solo puede ser ENTRY o EXIT, debe llevar
-- ubicación y debe referenciar a su documento (StockTransfer). Se compara
-- origin::text (no el literal del enum) porque PostgreSQL no permite USAR un
-- valor de enum recién agregado dentro de la misma transacción.
ALTER TABLE "inventory_movements"
ADD CONSTRAINT "inventory_movements_transfer_consistency"
CHECK (
  "origin"::text <> 'TRANSFER'
  OR (
    "movement_type"::text IN ('ENTRY', 'EXIT')
    AND "reference_type" = 'StockTransfer'
    AND "reference_id" IS NOT NULL
    AND "location_id" IS NOT NULL
  )
);
