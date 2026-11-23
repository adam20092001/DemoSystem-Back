-- R4: importación vinculada a una factura de compra principal. Aditiva.
-- Las operaciones EXISTENTES quedan como históricas (is_legacy_unlinked=true):
-- no se les asigna ninguna factura (pueden abarcar varias a través de sus líneas).

ALTER TABLE "import_operations"
  ADD COLUMN "purchase_invoice_id" UUID,
  ADD COLUMN "is_legacy_unlinked" BOOLEAN NOT NULL DEFAULT false;

UPDATE "import_operations" SET "is_legacy_unlinked" = true;

ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_purchase_invoice_id_fkey"
  FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE INDEX "import_operations_purchase_invoice_id_idx"
  ON "import_operations"("purchase_invoice_id");

-- Toda operación tiene factura principal o está identificada como histórica.
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_invoice_or_legacy"
  CHECK ("purchase_invoice_id" IS NOT NULL OR "is_legacy_unlinked");

-- Una operación histórica nunca tiene factura principal asignada por este vínculo
-- (la regularización, si ocurre, es un acto explícito futuro y fuera de R4).
ALTER TABLE "import_operations"
  ADD CONSTRAINT "import_operations_legacy_without_invoice"
  CHECK (NOT "is_legacy_unlinked" OR "purchase_invoice_id" IS NULL);

-- Correlativo anual IMP-AAAA-NNNNNN.
CREATE TABLE "import_operation_sequences" (
    "year" INTEGER NOT NULL,
    "last_number" INTEGER NOT NULL DEFAULT 0,

    CONSTRAINT "import_operation_sequences_pkey" PRIMARY KEY ("year")
);
ALTER TABLE "import_operation_sequences"
  ADD CONSTRAINT "import_operation_sequences_last_number_nonneg" CHECK ("last_number" >= 0);
ALTER TABLE "import_operation_sequences"
  ADD CONSTRAINT "import_operation_sequences_year_range" CHECK ("year" BETWEEN 2000 AND 9999);
