-- Fase A6.2 (costo de ventas): 100% aditiva. No se modifica ninguna fila
-- existente de forma destructiva; purchase_receipt_line_id pasa a NULLABLE
-- y se agrega un backfill determinista del nuevo source_type para las filas
-- ya existentes (todas, por construcción de A6.1, son PURCHASE_RECEIPT).

-- AlterEnum
ALTER TYPE "AccountingSystemKey" ADD VALUE 'COST_OF_GOODS_SOLD';

-- AlterEnum
ALTER TYPE "AccountingSourceType" ADD VALUE 'COGS';

-- CreateEnum
CREATE TYPE "InventoryValuationSourceType" AS ENUM ('PURCHASE_RECEIPT', 'SALE');

-- AlterTable: purchase_receipt_line_id nunca más obligatoria (una fila
-- sourceType=SALE no referencia ninguna PurchaseReceiptLine); columnas
-- nuevas nacen NULLABLE para poder completar el backfill antes de exigirlas.
ALTER TABLE "inventory_valuations" ALTER COLUMN "purchase_receipt_line_id" DROP NOT NULL;
ALTER TABLE "inventory_valuations" ADD COLUMN     "sale_item_id" UUID;
ALTER TABLE "inventory_valuations" ADD COLUMN     "source_type" "InventoryValuationSourceType";

-- Backfill determinista: toda fila existente proviene de A6.1, que solo
-- valorizaba recepciones físicas de compra.
UPDATE "inventory_valuations" SET "source_type" = 'PURCHASE_RECEIPT' WHERE "source_type" IS NULL;

-- Ahora sí, obligatoria.
ALTER TABLE "inventory_valuations" ALTER COLUMN "source_type" SET NOT NULL;

-- CreateIndex
CREATE INDEX "inventory_valuations_sale_item_id_idx" ON "inventory_valuations"("sale_item_id");

-- CreateIndex
CREATE INDEX "inventory_valuations_source_type_created_at_idx" ON "inventory_valuations"("source_type", "created_at");

-- AddForeignKey
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_sale_item_id_fkey" FOREIGN KEY ("sale_item_id") REFERENCES "sale_items"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (editado a mano, Fase A6.2 — el DSL de Prisma no los expresa)
-- Exclusividad mutua exacta entre purchase_receipt_line_id/sale_item_id según source_type:
-- nunca ambos presentes, nunca ambos ausentes.
ALTER TABLE "inventory_valuations" ADD CONSTRAINT "inventory_valuations_source_reference_consistency" CHECK (
    ("source_type" = 'PURCHASE_RECEIPT' AND "purchase_receipt_line_id" IS NOT NULL AND "sale_item_id" IS NULL)
    OR ("source_type" = 'SALE' AND "sale_item_id" IS NOT NULL AND "purchase_receipt_line_id" IS NULL)
);
