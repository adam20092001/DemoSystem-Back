-- Fase B2 (gastos de importación y asignación de costo): 100% aditiva.
-- Ninguna tabla/columna existente se modifica; ImportOperation,
-- ImportShipmentLine, Supplier y PurchaseInvoiceLine solo ganan
-- relaciones inversas opcionales nuevas.

-- CreateEnum
CREATE TYPE "ImportExpenseCategory" AS ENUM ('FREIGHT', 'INSURANCE', 'CUSTOMS_DUTY', 'PORT_HANDLING', 'STORAGE', 'INLAND_TRANSPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportExpenseDocumentType" AS ENUM ('INVOICE', 'RECEIPT', 'DEBIT_NOTE', 'OTHER');

-- CreateEnum
CREATE TYPE "ImportExpenseStatus" AS ENUM ('DRAFT', 'FINALIZED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ImportExpenseAllocationMethod" AS ENUM ('QUANTITY', 'WEIGHT', 'VOLUME', 'MANUAL');

-- CreateTable
CREATE TABLE "import_expenses" (
    "id" UUID NOT NULL,
    "import_operation_id" UUID NOT NULL,
    "category" "ImportExpenseCategory" NOT NULL,
    "description" VARCHAR(300),
    "supplier_id" UUID,
    "purchase_invoice_line_id" UUID,
    "document_type" "ImportExpenseDocumentType",
    "document_reference" VARCHAR(100),
    "expense_date" DATE NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "remarks" VARCHAR(1000),
    "status" "ImportExpenseStatus" NOT NULL DEFAULT 'DRAFT',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "finalized_at" TIMESTAMP(3),
    "finalized_by_user_id" UUID,
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(300),

    CONSTRAINT "import_expenses_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_expense_allocation_batches" (
    "id" UUID NOT NULL,
    "import_expense_id" UUID NOT NULL,
    "method" "ImportExpenseAllocationMethod" NOT NULL,
    "requested_amount" DECIMAL(14,2) NOT NULL,
    "idempotency_key" VARCHAR(100),
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_expense_allocation_batches_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "import_expense_allocations" (
    "id" UUID NOT NULL,
    "batch_id" UUID NOT NULL,
    "import_shipment_line_id" UUID NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "import_expense_allocations_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "import_expenses_import_operation_id_idx" ON "import_expenses"("import_operation_id");

-- CreateIndex
CREATE INDEX "import_expenses_status_created_at_idx" ON "import_expenses"("status", "created_at");

-- CreateIndex
CREATE INDEX "import_expense_allocation_batches_import_expense_id_idx" ON "import_expense_allocation_batches"("import_expense_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_expense_allocation_batches_import_expense_id_idempot_key" ON "import_expense_allocation_batches"("import_expense_id", "idempotency_key");

-- CreateIndex
CREATE INDEX "import_expense_allocations_import_shipment_line_id_idx" ON "import_expense_allocations"("import_shipment_line_id");

-- CreateIndex
CREATE UNIQUE INDEX "import_expense_allocations_batch_id_import_shipment_line_id_key" ON "import_expense_allocations"("batch_id", "import_shipment_line_id");

-- AddForeignKey
ALTER TABLE "import_expenses" ADD CONSTRAINT "import_expenses_import_operation_id_fkey" FOREIGN KEY ("import_operation_id") REFERENCES "import_operations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expenses" ADD CONSTRAINT "import_expenses_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expenses" ADD CONSTRAINT "import_expenses_purchase_invoice_line_id_fkey" FOREIGN KEY ("purchase_invoice_line_id") REFERENCES "purchase_invoice_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expenses" ADD CONSTRAINT "import_expenses_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expenses" ADD CONSTRAINT "import_expenses_finalized_by_user_id_fkey" FOREIGN KEY ("finalized_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expenses" ADD CONSTRAINT "import_expenses_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expense_allocation_batches" ADD CONSTRAINT "import_expense_allocation_batches_import_expense_id_fkey" FOREIGN KEY ("import_expense_id") REFERENCES "import_expenses"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expense_allocation_batches" ADD CONSTRAINT "import_expense_allocation_batches_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expense_allocations" ADD CONSTRAINT "import_expense_allocations_batch_id_fkey" FOREIGN KEY ("batch_id") REFERENCES "import_expense_allocation_batches"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_expense_allocations" ADD CONSTRAINT "import_expense_allocations_import_shipment_line_id_fkey" FOREIGN KEY ("import_shipment_line_id") REFERENCES "import_shipment_lines"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CHECK constraints (editado a mano, Fase B2 — el DSL de Prisma no los expresa)

-- 1. amount siempre positivo.
ALTER TABLE "import_expenses"
  ADD CONSTRAINT "import_expenses_amount_positive"
  CHECK ("amount" > 0);

-- 2. currencyCode: ISO 4217, 3 letras mayúsculas (mismo criterio que
--    PurchaseInvoice.currencyCode, sin validación real contra una tabla
--    de monedas).
ALTER TABLE "import_expenses"
  ADD CONSTRAINT "import_expenses_currency_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');

-- 3. Consistencia de finalizado: FINALIZED siempre tiene ambos; cualquier
--    otro estado nunca los tiene.
ALTER TABLE "import_expenses"
  ADD CONSTRAINT "import_expenses_finalized_consistency"
  CHECK (
    ("status" = 'FINALIZED' AND "finalized_at" IS NOT NULL AND "finalized_by_user_id" IS NOT NULL)
    OR
    ("status" != 'FINALIZED' AND "finalized_at" IS NULL AND "finalized_by_user_id" IS NULL)
  );

-- 4. Consistencia de anulación: CANCELLED siempre tiene los tres;
--    cualquier otro estado nunca los tiene (mismo criterio exacto que
--    purchase_invoices_cancellation_consistency).
ALTER TABLE "import_expenses"
  ADD CONSTRAINT "import_expenses_cancellation_consistency"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
    OR
    ("status" != 'CANCELLED' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
  );

-- 5. requestedAmount del lote siempre positivo.
ALTER TABLE "import_expense_allocation_batches"
  ADD CONSTRAINT "import_expense_allocation_batches_requested_amount_positive"
  CHECK ("requested_amount" > 0);

-- 6. amount de cada línea de asignación siempre positivo.
ALTER TABLE "import_expense_allocations"
  ADD CONSTRAINT "import_expense_allocations_amount_positive"
  CHECK ("amount" > 0);
