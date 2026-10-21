-- Fase A5.2a (Compras Universales — Facturas). Migración 100% aditiva:
-- ningún tipo/tabla/columna existente se elimina ni se reescribe. Nunca
-- modifica inventario (StockMovementEngine/InventoryMovement sin cambios);
-- A5.2b (todavía no implementada) es responsable exclusiva de recepciones.
-- Ninguno de los 7 AccountingSystemKey nuevos tiene mapeo real activado
-- por esta migración (ver CLAUDE.md §11): existen solo como valores de
-- enum resolvibles por AccountingEngine.postPurchaseRecognition() — su
-- activación real exige una acción explícita de ADMIN vía
-- PATCH /chart-of-accounts/system-keys/:systemKey (A1, sin cambios aquí),
-- nunca un seed ni un valor por defecto de esta migración.

-- CreateEnum
CREATE TYPE "PurchaseInvoiceDocumentType" AS ENUM ('FACTURA', 'BOLETA', 'RECIBO', 'OTHER');

-- CreateEnum
CREATE TYPE "PurchaseInvoiceStatus" AS ENUM ('DRAFT', 'CONFIRMED', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PurchaseAcquisitionKind" AS ENUM ('GOOD', 'SERVICE', 'OTHER');

-- CreateEnum
CREATE TYPE "PurchasePurpose" AS ENUM ('RESALE_INVENTORY', 'INTERNAL_CONSUMPTION', 'FIXED_ASSET', 'OPERATING_EXPENSE', 'OTHER');

-- CreateEnum
CREATE TYPE "PurchaseLineTaxCategory" AS ENUM ('TAXED', 'EXEMPT', 'UNAFFECTED', 'OTHER');

-- CreateEnum
CREATE TYPE "PurchaseLineTaxBasis" AS ENUM ('TAX_INCLUDED', 'TAX_EXCLUDED');

-- AlterEnum
ALTER TYPE "AccountingSourceType" ADD VALUE 'PURCHASE';

-- AlterEnum (PostgreSQL 16: múltiples ADD VALUE sobre el mismo tipo en un
-- solo script son válidos; la advertencia genérica de Prisma aplica solo a
-- PostgreSQL 11 o anterior, no al motor real de este proyecto, Postgres 16).
ALTER TYPE "AccountingSystemKey" ADD VALUE 'ACCOUNTS_PAYABLE';
ALTER TYPE "AccountingSystemKey" ADD VALUE 'VAT_RECEIVABLE';
ALTER TYPE "AccountingSystemKey" ADD VALUE 'PURCHASE_RESALE_INVENTORY';
ALTER TYPE "AccountingSystemKey" ADD VALUE 'PURCHASE_INTERNAL_CONSUMPTION';
ALTER TYPE "AccountingSystemKey" ADD VALUE 'PURCHASE_FIXED_ASSET';
ALTER TYPE "AccountingSystemKey" ADD VALUE 'PURCHASE_OPERATING_EXPENSE';
ALTER TYPE "AccountingSystemKey" ADD VALUE 'PURCHASE_OTHER';

-- CreateTable
CREATE TABLE "purchase_invoices" (
    "id" UUID NOT NULL,
    "supplier_id" UUID NOT NULL,
    "document_type" "PurchaseInvoiceDocumentType" NOT NULL,
    "document_series" VARCHAR(20),
    "document_number" VARCHAR(32) NOT NULL,
    "issue_date" DATE NOT NULL,
    "registration_date" DATE NOT NULL,
    "accounting_date" DATE NOT NULL,
    "due_date" DATE,
    "payment_terms_days" INTEGER,
    "currency_code" VARCHAR(3) NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "status" "PurchaseInvoiceStatus" NOT NULL DEFAULT 'DRAFT',
    "posted_entry_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "confirmed_at" TIMESTAMP(3),
    "cancelled_at" TIMESTAMP(3),
    "cancelled_by_user_id" UUID,
    "cancellation_reason" VARCHAR(300),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "purchase_invoices_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "purchase_invoice_lines" (
    "id" UUID NOT NULL,
    "purchase_invoice_id" UUID NOT NULL,
    "product_id" UUID,
    "description_snapshot" VARCHAR(300) NOT NULL,
    "unit_code_snapshot" VARCHAR(15),
    "unit_name_snapshot" VARCHAR(60),
    "acquisition_kind" "PurchaseAcquisitionKind" NOT NULL,
    "purchase_purpose" "PurchasePurpose" NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_cost" DECIMAL(14,2) NOT NULL,
    "tax_category" "PurchaseLineTaxCategory" NOT NULL,
    "tax_basis" "PurchaseLineTaxBasis",
    "tax_rate_snapshot" DECIMAL(5,2),
    "taxable_base_amount" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,
    "creditable_tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "line_total" DECIMAL(14,2) NOT NULL,
    "is_receipt_eligible" BOOLEAN,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "purchase_invoice_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "purchase_invoices_posted_entry_id_key" ON "purchase_invoices"("posted_entry_id");

-- CreateIndex
CREATE INDEX "purchase_invoices_supplier_id_created_at_idx" ON "purchase_invoices"("supplier_id", "created_at");

-- CreateIndex
CREATE INDEX "purchase_invoices_status_created_at_idx" ON "purchase_invoices"("status", "created_at");

-- CreateIndex
CREATE INDEX "purchase_invoices_created_at_id_idx" ON "purchase_invoices"("created_at", "id");

-- CreateIndex
CREATE INDEX "purchase_invoice_lines_purchase_invoice_id_idx" ON "purchase_invoice_lines"("purchase_invoice_id");

-- CreateIndex
CREATE INDEX "purchase_invoice_lines_product_id_idx" ON "purchase_invoice_lines"("product_id");

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_supplier_id_fkey" FOREIGN KEY ("supplier_id") REFERENCES "suppliers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_posted_entry_id_fkey" FOREIGN KEY ("posted_entry_id") REFERENCES "accounting_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoices" ADD CONSTRAINT "purchase_invoices_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_purchase_invoice_id_fkey" FOREIGN KEY ("purchase_invoice_id") REFERENCES "purchase_invoices"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "purchase_invoice_lines" ADD CONSTRAINT "purchase_invoice_lines_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Fase A5.2a) --------------------------------------
-- El DSL de Prisma no expresa CHECK, UPPER(), BTRIM() ni COALESCE(); se
-- agregan a mano, mismo criterio que suppliers/customers/sale_items/
-- accounting_entries.

-- 1. document_number nunca vacío ni solo espacios.
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_document_number_not_blank"
  CHECK (BTRIM("document_number") <> '');

-- 2. document_series, si está presente, nunca vacío ni solo espacios
--    (NULL sigue siendo la forma correcta de "sin serie" — distinto de
--    una serie vacía, que no tiene sentido de negocio).
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_document_series_not_blank"
  CHECK ("document_series" IS NULL OR BTRIM("document_series") <> '');

-- 3. Aritmética de cabecera exacta (mismo criterio que sales/quotes):
--    total_amount = subtotal + tax_amount.
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_totals_arithmetic"
  CHECK ("total_amount" = "subtotal" + "tax_amount");

-- 4. Ningún monto de cabecera negativo.
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_amounts_non_negative"
  CHECK ("subtotal" >= 0 AND "tax_amount" >= 0 AND "total_amount" >= 0);

-- 5. Consistencia de campos de confirmación: DRAFT nunca tiene
--    confirmed_at/posted_entry_id; CONFIRMED/CANCELLED siempre los tienen
--    (CANCELLED los conserva: el histórico de contabilización nunca se
--    borra al anular).
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_confirmation_consistency"
  CHECK (
    ("status" = 'DRAFT' AND "confirmed_at" IS NULL AND "posted_entry_id" IS NULL)
    OR
    ("status" IN ('CONFIRMED', 'CANCELLED') AND "confirmed_at" IS NOT NULL AND "posted_entry_id" IS NOT NULL)
  );

-- 6. Consistencia de campos de anulación: CANCELLED siempre tiene los
--    tres; cualquier otro estado nunca los tiene.
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_cancellation_consistency"
  CHECK (
    ("status" = 'CANCELLED' AND "cancelled_at" IS NOT NULL AND "cancelled_by_user_id" IS NOT NULL AND "cancellation_reason" IS NOT NULL)
    OR
    ("status" != 'CANCELLED' AND "cancelled_at" IS NULL AND "cancelled_by_user_id" IS NULL AND "cancellation_reason" IS NULL)
  );

-- Unicidad de documento de proveedor insensible a mayúsculas/minúsculas y a
-- espacios perimetrales, mismo criterio que suppliers_document_unique.
-- COALESCE(document_series, '') normaliza la ausencia de serie a cadena
-- vacía ANTES de comparar: así dos documentos del mismo proveedor+tipo+
-- número sin serie colisionan correctamente entre sí (el comportamiento
-- nativo de NULL en un índice único de PostgreSQL nunca los consideraría
-- duplicados, porque NULL <> NULL para esa comparación).
CREATE UNIQUE INDEX "purchase_invoices_document_unique"
ON "purchase_invoices" (
  "supplier_id",
  "document_type",
  UPPER(BTRIM(COALESCE("document_series", ''))),
  UPPER(BTRIM("document_number"))
);

-- 7. description_snapshot nunca vacío ni solo espacios.
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_description_not_blank"
  CHECK (BTRIM("description_snapshot") <> '');

-- 8. quantity siempre positiva.
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_quantity_positive"
  CHECK ("quantity" > 0);

-- 9. Ningún monto de línea negativo (unit_cost puede ser 0 — p. ej. un
--    obsequio del proveedor documentado igual como línea).
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_amounts_non_negative"
  CHECK (
    "unit_cost" >= 0
    AND "taxable_base_amount" >= 0
    AND "tax_amount" >= 0
    AND "creditable_tax_amount" >= 0
    AND "line_total" >= 0
  );

-- 10. El crédito fiscal reconocido nunca puede superar el impuesto que
--     indica el propio documento (nunca inferido de tax_category — ver
--     columna creditable_tax_amount).
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_creditable_within_tax"
  CHECK ("creditable_tax_amount" <= "tax_amount");

-- 11. Aritmética de línea exacta: line_total = taxable_base_amount + tax_amount.
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_total_arithmetic"
  CHECK ("line_total" = "taxable_base_amount" + "tax_amount");

-- 12. Consistencia tax_category/tax_basis/tax_rate_snapshot: TAXED exige
--     los dos presentes; cualquier otra categoría los exige ausentes y
--     fuerza tax_amount=creditable_tax_amount=0 (nunca un impuesto
--     implícito en una línea exonerada/inafecta/otra).
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_tax_category_consistency"
  CHECK (
    ("tax_category" = 'TAXED' AND "tax_basis" IS NOT NULL AND "tax_rate_snapshot" IS NOT NULL)
    OR
    ("tax_category" != 'TAXED' AND "tax_basis" IS NULL AND "tax_rate_snapshot" IS NULL AND "tax_amount" = 0 AND "creditable_tax_amount" = 0)
  );

-- 13. is_receipt_eligible=true solo es posible en una línea GOOD con
--     producto de catálogo — defensa en profundidad adicional a la
--     validación de servicio (AccountingEngine/PurchaseInvoicesService
--     nunca debería intentar fijarlo en ningún otro caso, pero la base de
--     datos lo impide igual si algo más lo intentara).
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_receipt_eligibility_requires_good_product"
  CHECK (
    "is_receipt_eligible" IS NOT TRUE
    OR ("acquisition_kind" = 'GOOD' AND "product_id" IS NOT NULL)
  );
