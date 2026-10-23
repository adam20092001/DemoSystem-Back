-- Fase B3 (vínculos de recepción física de importación): 100% aditiva.
-- Ninguna tabla/columna existente se modifica; ImportShipmentLine y
-- PurchaseReceiptLine solo ganan una relación inversa opcional nueva.

-- CreateEnum
CREATE TYPE "ImportReceiptLinkStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateTable
CREATE TABLE "import_receipt_links" (
    "id" UUID NOT NULL,
    "import_shipment_line_id" UUID NOT NULL,
    "purchase_receipt_line_id" UUID NOT NULL,
    "linked_quantity" DECIMAL(14,3) NOT NULL,
    "status" "ImportReceiptLinkStatus" NOT NULL DEFAULT 'ACTIVE',
    "idempotency_key" VARCHAR(100),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(300),

    CONSTRAINT "import_receipt_links_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_receipt_links_import_shipment_line_id_idx" ON "import_receipt_links"("import_shipment_line_id");

-- CreateIndex
CREATE INDEX "import_receipt_links_purchase_receipt_line_id_idx" ON "import_receipt_links"("purchase_receipt_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_receipt_links_import_shipment_line_id_idempotency_ke_key" ON "import_receipt_links"("import_shipment_line_id", "idempotency_key");

-- AddForeignKey
ALTER TABLE "import_receipt_links" ADD CONSTRAINT "import_receipt_links_import_shipment_line_id_fkey" FOREIGN KEY ("import_shipment_line_id") REFERENCES "import_shipment_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_receipt_links" ADD CONSTRAINT "import_receipt_links_purchase_receipt_line_id_fkey" FOREIGN KEY ("purchase_receipt_line_id") REFERENCES "purchase_receipt_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_receipt_links" ADD CONSTRAINT "import_receipt_links_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_receipt_links" ADD CONSTRAINT "import_receipt_links_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (editado a mano, Fase B3 — el DSL de Prisma no los expresa)

-- 1. linkedQuantity siempre positivo.
ALTER TABLE "import_receipt_links"
  ADD CONSTRAINT "import_receipt_links_linked_quantity_positive"
  CHECK ("linked_quantity" > 0);

-- 2. Consistencia de cancelación: CANCELLED siempre tiene los tres;
--    cualquier otro estado nunca los tiene (mismo criterio exacto que
--    purchase_invoices_cancellation_consistency).
ALTER TABLE "import_receipt_links"
  ADD CONSTRAINT "import_receipt_links_cancellation_consistency"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
    OR
    ("status" != 'CANCELLED' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
  );
