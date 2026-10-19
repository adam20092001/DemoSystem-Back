-- NR-03 (descuentos individuales por línea de cotización) ------------------
--
-- Migración puramente ADITIVA sobre quote_items, sale_items y
-- electronic_document_items: agrega discount_type/discount_value/
-- discount_amount a las tres (mismo criterio de snapshot ya usado para el
-- resto de columnas de estas tablas), y relaja el CHECK de aritmética
-- exacta de line_total en las tres para incorporar el descuento.
--
-- Ningún registro histórico cambia de significado: discount_amount nace
-- con DEFAULT 0 (todas las filas existentes lo reciben en la misma
-- sentencia), discount_type/discount_value nacen NULL (columnas nullable
-- sin DEFAULT). El nuevo CHECK de aritmética, con discount_amount=0, es
-- ALGEBRAICAMENTE IDÉNTICO al CHECK anterior (line_total =
-- ROUND(quantity*unit_price,2)), así que ninguna fila histórica -- que ya
-- satisfacía el CHECK anterior -- puede violar el nuevo. Sin backfill
-- adicional: NULL/NULL/0 ES la semántica de "sin descuento de línea".
--
-- No se modifican subtotal/discount_amount/tax_amount/total de Quote/Sale/
-- ElectronicDocument, ningún saldo, ningún asiento contable, ninguna
-- columna ajena a estas 3 tablas.

-- 1. Tipo compartido por las tres tablas (mismo criterio que
--    PaymentMethodAccountingDestination, reutilizado sin redeclararlo).
CREATE TYPE "LineDiscountType" AS ENUM ('FIXED', 'PERCENT');

-- =============================================================
-- 2. quote_items
-- =============================================================
ALTER TABLE "quote_items"
  ADD COLUMN "discount_type" "LineDiscountType",
  ADD COLUMN "discount_value" DECIMAL(14, 2),
  ADD COLUMN "discount_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE "quote_items" DROP CONSTRAINT "quote_items_line_arithmetic";
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_line_arithmetic"
  CHECK ("line_total" = ROUND("quantity" * "unit_price", 2) - "discount_amount");

ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_discount_amount_non_negative"
  CHECK ("discount_amount" >= 0);

ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_discount_amount_within_gross"
  CHECK ("discount_amount" <= ROUND("quantity" * "unit_price", 2));

ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_discount_consistency"
  CHECK (
    ("discount_type" IS NULL AND "discount_value" IS NULL AND "discount_amount" = 0)
    OR ("discount_type" IS NOT NULL AND "discount_value" IS NOT NULL)
  );

ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_discount_percent_range"
  CHECK (
    "discount_type" IS DISTINCT FROM 'PERCENT'
    OR ("discount_value" >= 0 AND "discount_value" <= 100)
  );

ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_discount_fixed_matches_amount"
  CHECK ("discount_type" IS DISTINCT FROM 'FIXED' OR "discount_value" = "discount_amount");

-- =============================================================
-- 3. sale_items
-- =============================================================
ALTER TABLE "sale_items"
  ADD COLUMN "discount_type" "LineDiscountType",
  ADD COLUMN "discount_value" DECIMAL(14, 2),
  ADD COLUMN "discount_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE "sale_items" DROP CONSTRAINT "sale_items_line_arithmetic";
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_line_arithmetic"
  CHECK ("line_total" = ROUND("quantity" * "unit_price", 2) - "discount_amount");

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_discount_amount_non_negative"
  CHECK ("discount_amount" >= 0);

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_discount_amount_within_gross"
  CHECK ("discount_amount" <= ROUND("quantity" * "unit_price", 2));

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_discount_consistency"
  CHECK (
    ("discount_type" IS NULL AND "discount_value" IS NULL AND "discount_amount" = 0)
    OR ("discount_type" IS NOT NULL AND "discount_value" IS NOT NULL)
  );

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_discount_percent_range"
  CHECK (
    "discount_type" IS DISTINCT FROM 'PERCENT'
    OR ("discount_value" >= 0 AND "discount_value" <= 100)
  );

ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_discount_fixed_matches_amount"
  CHECK ("discount_type" IS DISTINCT FROM 'FIXED' OR "discount_value" = "discount_amount");

-- =============================================================
-- 4. electronic_document_items
-- =============================================================
ALTER TABLE "electronic_document_items"
  ADD COLUMN "discount_type" "LineDiscountType",
  ADD COLUMN "discount_value" DECIMAL(14, 2),
  ADD COLUMN "discount_amount" DECIMAL(14, 2) NOT NULL DEFAULT 0;

ALTER TABLE "electronic_document_items" DROP CONSTRAINT "electronic_document_items_line_arithmetic";
ALTER TABLE "electronic_document_items"
  ADD CONSTRAINT "electronic_document_items_line_arithmetic"
  CHECK ("line_total" = ROUND("quantity" * "unit_price", 2) - "discount_amount");

ALTER TABLE "electronic_document_items"
  ADD CONSTRAINT "electronic_document_items_discount_amount_non_negative"
  CHECK ("discount_amount" >= 0);

ALTER TABLE "electronic_document_items"
  ADD CONSTRAINT "electronic_document_items_discount_amount_within_gross"
  CHECK ("discount_amount" <= ROUND("quantity" * "unit_price", 2));

ALTER TABLE "electronic_document_items"
  ADD CONSTRAINT "electronic_document_items_discount_consistency"
  CHECK (
    ("discount_type" IS NULL AND "discount_value" IS NULL AND "discount_amount" = 0)
    OR ("discount_type" IS NOT NULL AND "discount_value" IS NOT NULL)
  );

ALTER TABLE "electronic_document_items"
  ADD CONSTRAINT "electronic_document_items_discount_percent_range"
  CHECK (
    "discount_type" IS DISTINCT FROM 'PERCENT'
    OR ("discount_value" >= 0 AND "discount_value" <= 100)
  );

ALTER TABLE "electronic_document_items"
  ADD CONSTRAINT "electronic_document_items_discount_fixed_matches_amount"
  CHECK ("discount_type" IS DISTINCT FROM 'FIXED' OR "discount_value" = "discount_amount");
