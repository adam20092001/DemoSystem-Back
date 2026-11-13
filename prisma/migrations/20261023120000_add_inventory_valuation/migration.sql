-- CreateEnum
CREATE TYPE "InventoryValuationMethod" AS ENUM ('MOVING_WEIGHTED_AVERAGE', 'FIFO');

-- CreateEnum
CREATE TYPE "InventoryValuationEventType" AS ENUM ('ORIGINAL', 'REVERSAL');

-- AlterTable
ALTER TABLE "products" ADD COLUMN     "valuation_method" "InventoryValuationMethod";

-- CreateTable
CREATE TABLE "inventory_valuations" (
    "id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "inventory_movement_id" UUID NOT NULL,
    "purchase_receipt_line_id" UUID NOT NULL,
    "event_type" "InventoryValuationEventType" NOT NULL,
    "reverses_valuation_id" UUID,
    "method" "InventoryValuationMethod" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "purchase_price_amount" DECIMAL(14,2) NOT NULL,
    "non_creditable_tax_amount" DECIMAL(14,2) NOT NULL,
    "additional_costs_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total_cost" DECIMAL(14,2) NOT NULL,
    "unit_cost" DECIMAL(18,6) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "inventory_valuations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "inventory_valuations_inventory_movement_id_key" ON "inventory_valuations"("inventory_movement_id");

-- CreateIndex
CREATE UNIQUE INDEX "inventory_valuations_reverses_valuation_id_key" ON "inventory_valuations"("reverses_valuation_id");

-- CreateIndex
CREATE INDEX "inventory_valuations_product_id_created_at_idx" ON "inventory_valuations"("product_id", "created_at");

-- CreateIndex
CREATE INDEX "inventory_valuations_purchase_receipt_line_id_idx" ON "inventory_valuations"("purchase_receipt_line_id");

-- CreateIndex
CREATE INDEX "inventory_valuations_event_type_created_at_idx" ON "inventory_valuations"("event_type", "created_at");

-- AddForeignKey
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_inventory_movement_id_fkey" FOREIGN KEY ("inventory_movement_id") REFERENCES "inventory_movements"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_purchase_receipt_line_id_fkey" FOREIGN KEY ("purchase_receipt_line_id") REFERENCES "purchase_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_reverses_valuation_id_fkey" FOREIGN KEY ("reverses_valuation_id") REFERENCES "inventory_valuations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (editado a mano, Fase A6.1 — el DSL de Prisma no los expresa, mismo criterio que el resto del dominio)
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_quantity_positive" CHECK ("quantity" > 0);

ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_amounts_non_negative" CHECK (
    "purchase_price_amount" >= 0
    AND "non_creditable_tax_amount" >= 0
    AND "additional_costs_amount" >= 0
    AND "unit_cost" >= 0
);

-- total_cost es SIEMPRE la suma exacta de los tres componentes capitalizados — nunca un valor independiente.
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_total_cost_consistency" CHECK (
    "total_cost" = "purchase_price_amount" + "non_creditable_tax_amount" + "additional_costs_amount"
);

-- ORIGINAL nunca tiene reverses_valuation_id; REVERSAL siempre lo tiene (mismo criterio que accounting_entries, aplicado explícitamente aquí vía CHECK).
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_reversal_consistency" CHECK (
    ("event_type" = 'REVERSAL' AND "reverses_valuation_id" IS NOT NULL)
    OR ("event_type" = 'ORIGINAL' AND "reverses_valuation_id" IS NULL)
);
