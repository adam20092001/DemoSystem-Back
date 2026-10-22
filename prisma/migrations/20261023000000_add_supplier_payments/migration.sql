-- Fase A5.3 — Pagos a proveedores (supplier_payments/
-- supplier_payment_allocations). 100% aditiva: ninguna tabla/columna
-- existente se modifica. Generada con `prisma migrate diff --script` y
-- editada a mano para agregar los CHECK que el DSL de Prisma no expresa
-- (mismo criterio que A5.2a/A5.2b).

-- CreateEnum
CREATE TYPE "SupplierPaymentStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- AlterEnum
ALTER TYPE "AccountingSourceType" ADD VALUE 'SUPPLIER_PAYMENT';

-- CreateTable
CREATE TABLE "supplier_payments" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "payment_date" DATE NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "payment_method_code" VARCHAR(30) NOT NULL,
    "payment_method_name" VARCHAR(60) NOT NULL,
    "reference" VARCHAR(100),
    "idempotency_key" VARCHAR(100),
    "status" "SupplierPaymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "posted_entry_id" UUID NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "supplier_payments_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "supplier_payment_allocations" (
    "id" UUID NOT NULL,
    "supplier_payment_id" UUID NOT NULL,
    "purchase_invoice_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "supplier_payment_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_posted_entry_id_key" ON "supplier_payments"("posted_entry_id");

-- CreateIndex
CREATE INDEX "supplier_payments_supplier_id_created_at_idx" ON "supplier_payments"("supplier_id", "created_at");

-- CreateIndex
CREATE INDEX "supplier_payments_status_created_at_idx" ON "supplier_payments"("status", "created_at");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payments_supplier_id_idempotency_key_key" ON "supplier_payments"("supplier_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_supplier_payment_id_idx" ON "supplier_payment_allocations"("supplier_payment_id");

-- CreateIndex
CREATE INDEX "supplier_payment_allocations_purchase_invoice_id_idx" ON "supplier_payment_allocations"("purchase_invoice_id");

-- CreateIndex
CREATE UNIQUE INDEX "supplier_payment_allocations_supplier_payment_id_purchase_i_key" ON "supplier_payment_allocations"("supplier_payment_id", "purchase_invoice_id");

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_posted_entry_id_fkey" FOREIGN KEY ("posted_entry_id") REFERENCES "accounting_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payments" ADD CONSTRAINT "supplier_payments_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_supplier_payment_id_fkey" FOREIGN KEY ("supplier_payment_id") REFERENCES "supplier_payments"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "supplier_payment_allocations" ADD CONSTRAINT "supplier_payment_allocations_purchase_invoice_id_fkey" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- =========================================================================
-- CHECK constraints a mano (el DSL de Prisma no los expresa).
-- =========================================================================

-- 1. Monto del pago siempre positivo.
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_amount_positive"
  CHECK ("amount" > 0);

-- 2. idempotency_key, si se provee, nunca en blanco.
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_idempotency_key_not_blank"
  CHECK ("idempotency_key" IS NULL OR BTRIM("idempotency_key") != '');

-- 3. Consistencia de campos de anulación: CANCELLED siempre tiene los
--    tres; ACTIVE nunca los tiene. Mismo criterio exacto que
--    purchase_receipts_cancellation_consistency (A5.2b).
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_cancellation_consistency"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
    OR
    ("status" = 'ACTIVE' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
  );

-- 4. Monto de cada asignación siempre positivo.
ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_amount_positive"
  CHECK ("amount" > 0);
