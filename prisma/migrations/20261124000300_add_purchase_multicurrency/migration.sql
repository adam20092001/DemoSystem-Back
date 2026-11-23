-- R4: compras multimoneda (política A de pagos, diferencia de cambio realizada).
-- Aditiva con backfill determinista: TODO documento y pago existente nace con
-- tasa 1, moneda del documento = moneda de la empresa e importes originales
-- iguales a los contables (la moneda de la empresa no ha podido cambiar con
-- historia financiera: regla A0.2). Ningún importe existente se modifica.

-- ---------------------------------------------------------------------------
-- 1. purchase_invoices
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_invoices"
  ADD COLUMN "base_currency_code" VARCHAR(3),
  ADD COLUMN "exchange_rate" DECIMAL(18,8),
  ADD COLUMN "exchange_rate_date" DATE,
  ADD COLUMN "subtotal_original" DECIMAL(14,2),
  ADD COLUMN "tax_amount_original" DECIMAL(14,2),
  ADD COLUMN "total_amount_original" DECIMAL(14,2);

UPDATE "purchase_invoices" SET
  "base_currency_code" = "currency_code",
  "exchange_rate" = 1,
  "exchange_rate_date" = "accounting_date",
  "subtotal_original" = "subtotal",
  "tax_amount_original" = "tax_amount",
  "total_amount_original" = "total_amount";

ALTER TABLE "purchase_invoices"
  ALTER COLUMN "base_currency_code" SET NOT NULL,
  ALTER COLUMN "exchange_rate" SET NOT NULL,
  ALTER COLUMN "exchange_rate_date" SET NOT NULL,
  ALTER COLUMN "subtotal_original" SET NOT NULL,
  ALTER COLUMN "tax_amount_original" SET NOT NULL,
  ALTER COLUMN "total_amount_original" SET NOT NULL;

ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_currency_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$' AND "base_currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_exchange_rate_positive"
  CHECK ("exchange_rate" > 0);
-- Misma moneda => tasa 1 (monedas distintas admiten cualquier tasa positiva).
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_same_currency_rate_one"
  CHECK ("currency_code" <> "base_currency_code" OR "exchange_rate" = 1);
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_totals_original_arithmetic"
  CHECK ("total_amount_original" = "subtotal_original" + "tax_amount_original");
ALTER TABLE "purchase_invoices"
  ADD CONSTRAINT "purchase_invoices_amounts_original_non_negative"
  CHECK ("subtotal_original" >= 0 AND "tax_amount_original" >= 0 AND "total_amount_original" >= 0);

-- ---------------------------------------------------------------------------
-- 2. purchase_invoice_lines
-- ---------------------------------------------------------------------------
ALTER TABLE "purchase_invoice_lines"
  ADD COLUMN "unit_cost_original" DECIMAL(18,6),
  ADD COLUMN "taxable_base_amount_original" DECIMAL(14,2),
  ADD COLUMN "tax_amount_original" DECIMAL(14,2),
  ADD COLUMN "creditable_tax_amount_original" DECIMAL(14,2),
  ADD COLUMN "line_total_original" DECIMAL(14,2);

UPDATE "purchase_invoice_lines" SET
  "unit_cost_original" = "unit_cost",
  "taxable_base_amount_original" = "taxable_base_amount",
  "tax_amount_original" = "tax_amount",
  "creditable_tax_amount_original" = "creditable_tax_amount",
  "line_total_original" = "line_total";

ALTER TABLE "purchase_invoice_lines"
  ALTER COLUMN "unit_cost_original" SET NOT NULL,
  ALTER COLUMN "taxable_base_amount_original" SET NOT NULL,
  ALTER COLUMN "tax_amount_original" SET NOT NULL,
  ALTER COLUMN "creditable_tax_amount_original" SET NOT NULL,
  ALTER COLUMN "line_total_original" SET NOT NULL;

ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_amounts_original_non_negative"
  CHECK (
    "unit_cost_original" >= 0 AND "taxable_base_amount_original" >= 0
    AND "tax_amount_original" >= 0 AND "creditable_tax_amount_original" >= 0
    AND "line_total_original" >= 0
  );
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_creditable_original_within_tax"
  CHECK ("creditable_tax_amount_original" <= "tax_amount_original");
ALTER TABLE "purchase_invoice_lines"
  ADD CONSTRAINT "purchase_invoice_lines_total_original_arithmetic"
  CHECK ("line_total_original" = "taxable_base_amount_original" + "tax_amount_original");

-- ---------------------------------------------------------------------------
-- 3. supplier_payments
-- ---------------------------------------------------------------------------
ALTER TABLE "supplier_payments"
  ADD COLUMN "base_currency_code" VARCHAR(3),
  ADD COLUMN "exchange_rate" DECIMAL(18,8),
  ADD COLUMN "exchange_rate_date" DATE,
  ADD COLUMN "base_amount" DECIMAL(14,2);

UPDATE "supplier_payments" SET
  "base_currency_code" = "currency_code",
  "exchange_rate" = 1,
  "exchange_rate_date" = "payment_date",
  "base_amount" = "amount";

ALTER TABLE "supplier_payments"
  ALTER COLUMN "base_currency_code" SET NOT NULL,
  ALTER COLUMN "exchange_rate" SET NOT NULL,
  ALTER COLUMN "exchange_rate_date" SET NOT NULL,
  ALTER COLUMN "base_amount" SET NOT NULL;

ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_currency_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$' AND "base_currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_exchange_rate_positive" CHECK ("exchange_rate" > 0);
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_same_currency_rate_one"
  CHECK ("currency_code" <> "base_currency_code" OR "exchange_rate" = 1);
ALTER TABLE "supplier_payments"
  ADD CONSTRAINT "supplier_payments_base_amount_positive" CHECK ("base_amount" > 0);

-- ---------------------------------------------------------------------------
-- 4. supplier_payment_allocations
-- ---------------------------------------------------------------------------
ALTER TABLE "supplier_payment_allocations"
  ADD COLUMN "carrying_base_amount" DECIMAL(14,2),
  ADD COLUMN "settled_base_amount" DECIMAL(14,2),
  ADD COLUMN "fx_difference_amount" DECIMAL(14,2);

UPDATE "supplier_payment_allocations" SET
  "carrying_base_amount" = "amount",
  "settled_base_amount" = "amount",
  "fx_difference_amount" = 0;

ALTER TABLE "supplier_payment_allocations"
  ALTER COLUMN "carrying_base_amount" SET NOT NULL,
  ALTER COLUMN "settled_base_amount" SET NOT NULL,
  ALTER COLUMN "fx_difference_amount" SET NOT NULL;

ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_base_non_negative"
  CHECK ("carrying_base_amount" >= 0 AND "settled_base_amount" >= 0);
-- diferencia realizada = pagado − valor en libros (>0 pérdida, <0 ganancia).
ALTER TABLE "supplier_payment_allocations"
  ADD CONSTRAINT "supplier_payment_allocations_fx_arithmetic"
  CHECK ("fx_difference_amount" = "settled_base_amount" - "carrying_base_amount");
