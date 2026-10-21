-- Fase A5.2b — Recepciones físicas de mercadería (purchase_receipts/
-- purchase_receipt_lines) + reclasificación contable opcional
-- (chart_of_accounts.receipt_reclassification_target_account_id).
-- 100% aditiva: ninguna tabla/columna existente se modifica salvo la
-- columna nueva nullable en chart_of_accounts. Generada con
-- `prisma migrate diff --script` y editada a mano para agregar los CHECK
-- que el DSL de Prisma no expresa (mismo criterio que A5.2a).

-- CreateEnum
CREATE TYPE "PurchaseReceiptStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AccountingSourceType" ADD VALUE 'PURCHASE_RECEIPT';

-- AlterEnum (dos valores nuevos; PostgreSQL 12+ permite varios ADD VALUE
-- en la misma transacción siempre que ningún statement de esta misma
-- migración los USE como dato — aquí solo se declaran, nunca se
-- referencian hasta una migración/transacción posterior).
ALTER TYPE "InventoryMovementOrigin" ADD VALUE 'PURCHASE_RECEIPT';
ALTER TYPE "InventoryMovementOrigin" ADD VALUE 'PURCHASE_RECEIPT_CANCELLATION';

-- AlterTable
ALTER TABLE "chart_of_accounts" ADD COLUMN     "receipt_reclassification_target_account_id" UUID;

-- CreateTable
CREATE TABLE "purchase_receipts" (
    "id" UUID NOT NULL,
    "purchase_invoice_id" UUID NOT NULL,
    "received_date" DATE NOT NULL,
    "status" "PurchaseReceiptStatus" NOT NULL DEFAULT 'ACTIVE',
    "idempotency_key" VARCHAR(100),
    "notes" VARCHAR(500),
    "created_by_user_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(300),
    "reclassification_entry_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_receipts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_receipt_lines" (
    "id" UUID NOT NULL,
    "purchase_receipt_id" UUID NOT NULL,
    "purchase_invoice_line_id" UUID NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "reclassified_amount" DECIMAL(14,2),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_receipt_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_reclassification_entry_id_key" ON "purchase_receipts"("reclassification_entry_id");

-- CreateIndex
CREATE INDEX "purchase_receipts_purchase_invoice_id_created_at_idx" ON "purchase_receipts"("purchase_invoice_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_receipts_status_created_at_idx" ON "purchase_receipts"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipts_purchase_invoice_id_idempotency_key_key" ON "purchase_receipts"("purchase_invoice_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "purchase_receipt_lines_purchase_receipt_id_idx" ON "purchase_receipt_lines"("purchase_receipt_id");

-- CreateIndex
CREATE INDEX "purchase_receipt_lines_purchase_invoice_line_id_idx" ON "purchase_receipt_lines"("purchase_invoice_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "purchase_receipt_lines_purchase_receipt_id_purchase_invoice_key" ON "purchase_receipt_lines"("purchase_receipt_id", "purchase_invoice_line_id");

-- CreateIndex
CREATE INDEX "chart_of_accounts_receipt_reclassification_target_account_i_idx" ON "chart_of_accounts"("receipt_reclassification_target_account_id");

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_purchase_invoice_id_fkey" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipts" ADD CONSTRAINT "purchase_receipts_reclassification_entry_id_fkey" FOREIGN KEY ("reclassification_entry_id") REFERENCES "accounting_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_purchase_receipt_id_fkey" FOREIGN KEY ("purchase_receipt_id") REFERENCES "purchase_receipts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_receipt_lines" ADD CONSTRAINT "purchase_receipt_lines_purchase_invoice_line_id_fkey" FOREIGN KEY ("purchase_invoice_line_id") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "chart_of_accounts" ADD CONSTRAINT "chart_of_accounts_receipt_reclassification_target_account__fkey" FOREIGN KEY ("receipt_reclassification_target_account_id") REFERENCES "chart_of_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================================
-- CHECK constraints a mano (el DSL de Prisma no los expresa).
-- =========================================================================

-- 1. idempotency_key, si se provee, nunca en blanco.
ALTER TABLE "purchase_receipts"
  ADD CONSTRAINT "purchase_receipts_idempotency_key_not_blank"
  CHECK ("idempotency_key" IS NULL OR BTRIM("idempotency_key") != '');

-- 2. Consistencia de campos de anulación: CANCELLED siempre tiene los
--    tres; ACTIVE nunca los tiene. Mismo criterio exacto que
--    purchase_invoices_cancellation_consistency (A5.2a).
ALTER TABLE "purchase_receipts"
  ADD CONSTRAINT "purchase_receipts_cancellation_consistency"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
    OR
    ("status" = 'ACTIVE' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
  );

-- 3. Cantidad recibida siempre positiva.
ALTER TABLE "purchase_receipt_lines"
  ADD CONSTRAINT "purchase_receipt_lines_quantity_positive"
  CHECK ("quantity" > 0);

-- 4. Monto de reclasificación, si está presente, nunca negativo (puede ser
--    NULL = sin reclasificación; nunca puede ser exactamente 0, porque
--    PurchaseInvoicesService solo lo persiste cuando efectivamente postea
--    un AccountingEntry, y assertLinesBalanced ya exige montos > 0).
ALTER TABLE "purchase_receipt_lines"
  ADD CONSTRAINT "purchase_receipt_lines_reclassified_amount_positive"
  CHECK ("reclassified_amount" IS NULL OR "reclassified_amount" > 0);

-- 5. Una cuenta nunca se designa su propio objetivo de reclasificación
--    (self-relation de un solo nivel; una cadena de 2+ niveles no se
--    puede expresar con un CHECK de fila y se valida en el servicio).
ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_no_self_reclassification"
  CHECK ("receipt_reclassification_target_account_id" IS NULL OR "receipt_reclassification_target_account_id" != "id");
