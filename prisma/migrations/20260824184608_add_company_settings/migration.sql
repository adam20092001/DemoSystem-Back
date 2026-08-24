-- CreateTable
CREATE TABLE "company_settings" (
    "id" UUID NOT NULL,
    "singleton" BOOLEAN NOT NULL DEFAULT true,
    "business_name" VARCHAR(150) NOT NULL,
    "trade_name" VARCHAR(150),
    "tax_id" VARCHAR(20),
    "address" VARCHAR(300),
    "phone" VARCHAR(30),
    "email" VARCHAR(150),
    "currency_code" VARCHAR(3) NOT NULL DEFAULT 'PEN',
    "currency_symbol" VARCHAR(5) NOT NULL DEFAULT 'S/',
    "tax_enabled" BOOLEAN NOT NULL DEFAULT false,
    "tax_rate" DECIMAL(5,2) NOT NULL DEFAULT 18.00,
    "quote_validity_days" INTEGER NOT NULL DEFAULT 15,
    "max_discount_percent" DECIMAL(5,2) NOT NULL DEFAULT 100.00,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "company_settings_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "company_settings_singleton_key" ON "company_settings"("singleton");

-- Restricciones manuales (Fase 10, Bloque A) --------------------------------
-- El DSL de Prisma no expresa CHECK de forma declarativa; se agregan a
-- mano, igual que en las Fases 2-8. Conteo final: 7 CHECK, sin índices
-- únicos parciales adicionales (la UNIQUE de arriba + el CHECK #1 ya hacen
-- físicamente imposible una segunda fila).

-- 1. singleton siempre TRUE: combinado con la UNIQUE de arriba, impide una
--    segunda fila sin importar su valor (una fila FALSE y otra TRUE ya no
--    son posibles a la vez).
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_singleton_true"
  CHECK ("singleton" = TRUE);

-- 2. business_name nunca en blanco (BTRIM: consistente con el trim de
--    aplicación, no solo con cadena vacía literal).
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_business_name_not_blank"
  CHECK (BTRIM("business_name") <> '');

-- 3. tax_rate: porcentaje válido 0-100 (Bloque C la integra con IGV; el
--    valor semilla ya debe cumplir el rango desde el Bloque A).
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_tax_rate_range"
  CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);

-- 4. quote_validity_days siempre positivo (Bloque B la integra con
--    Cotizaciones).
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_quote_validity_positive"
  CHECK ("quote_validity_days" > 0);

-- 5. max_discount_percent: porcentaje válido 0-100 (Bloque B la integra con
--    Cotizaciones/Ventas).
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_max_discount_range"
  CHECK ("max_discount_percent" >= 0 AND "max_discount_percent" <= 100);

-- 6. currency_code: formato ISO de 3 letras mayúsculas.
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_currency_code_format"
  CHECK ("currency_code" ~ '^[A-Z]{3}$');

-- 7. currency_symbol nunca en blanco tras BTRIM, ni siquiera un valor
--    compuesto solo por espacios.
ALTER TABLE "company_settings"
  ADD CONSTRAINT "company_settings_currency_symbol_not_blank"
  CHECK (char_length(BTRIM("currency_symbol")) BETWEEN 1 AND 5);
