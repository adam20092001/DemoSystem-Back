-- Fase 11, Bloque B: fundacion fiscal (KAN-18 ya esta en main).
--
-- Esta migracion:
--   1. Agrega el snapshot de contexto de moneda/impuesto (currencyCode,
--      taxEnabled, taxRate) a quotes/sales, con backfill de las filas
--      historicas existentes (mejor esfuerzo: no existe una fuente
--      historica mejor que la fila vigente de company_settings).
--   2. Crea los 2 enums fiscales (FiscalDocumentType, ElectronicDocumentStatus).
--   3. Crea fiscal_series, electronic_documents, electronic_document_items.
--   4. Agrega los CHECK/indices propios de cada tabla nueva y de las 3
--      columnas nuevas de quotes/sales.
--
-- No se implementa emision fiscal en esta migracion: las tablas nuevas
-- quedan vacias salvo las 2 filas semilla que prisma/seed.ts crea aparte
-- (fuera de esta migracion).

-- ============================================================================
-- 1. Enums fiscales
-- ============================================================================

-- CreateEnum
CREATE TYPE "FiscalDocumentType" AS ENUM ('FACTURA', 'BOLETA');

-- CreateEnum
CREATE TYPE "ElectronicDocumentStatus" AS ENUM ('CREATED', 'SUBMITTED', 'SUBMISSION_FAILED', 'ACCEPTED', 'REJECTED');

-- ============================================================================
-- 2. Snapshot de contexto de moneda/impuesto en quotes/sales
--
-- Las 3 columnas se agregan NULLABLE primero a proposito: Postgres no
-- permite agregar una columna NOT NULL sin default sobre una tabla con
-- filas existentes. Se backfillean explicitamente y solo DESPUES se fuerza
-- NOT NULL, con una asercion de integridad en medio (mismo patron ya usado
-- en 20260825230114_add_user_roles para el backfill de UserRole).
-- ============================================================================

-- AlterTable
ALTER TABLE "quotes"
  ADD COLUMN "currency_code" VARCHAR(3),
  ADD COLUMN "tax_enabled" BOOLEAN,
  ADD COLUMN "tax_rate" DECIMAL(5,2);

-- AlterTable
ALTER TABLE "sales"
  ADD COLUMN "currency_code" VARCHAR(3),
  ADD COLUMN "tax_enabled" BOOLEAN,
  ADD COLUMN "tax_rate" DECIMAL(5,2);

-- Backfill de mejor esfuerzo (documentado explicitamente, sin fuente
-- historica real disponible): si existe la fila singleton de
-- company_settings, se usa su valor VIGENTE (unica fuente disponible,
-- aunque no sea necesariamente el valor real con el que se calculo cada
-- fila historica). Si no existe ninguna fila de company_settings (base de
-- datos recien migrada y sin sembrar todavia), se usan los defaults
-- genericos del repositorio: currency_code = 'PEN', tax_enabled = false,
-- tax_rate = 18.00 (mismo valor semilla que CompanySettings.taxRate).
-- Ningun valor monetario existente (subtotal/discountAmount/taxAmount/
-- total) se modifica: esta migracion nunca reescribe montos historicos.
UPDATE "quotes"
SET
  "currency_code" = COALESCE((SELECT "currency_code" FROM "company_settings" LIMIT 1), 'PEN'),
  "tax_enabled"   = COALESCE((SELECT "tax_enabled" FROM "company_settings" LIMIT 1), false),
  "tax_rate"      = COALESCE((SELECT "tax_rate" FROM "company_settings" LIMIT 1), 18.00)
WHERE "currency_code" IS NULL;

UPDATE "sales"
SET
  "currency_code" = COALESCE((SELECT "currency_code" FROM "company_settings" LIMIT 1), 'PEN'),
  "tax_enabled"   = COALESCE((SELECT "tax_enabled" FROM "company_settings" LIMIT 1), false),
  "tax_rate"      = COALESCE((SELECT "tax_rate" FROM "company_settings" LIMIT 1), 18.00)
WHERE "currency_code" IS NULL;

-- Asercion de integridad: si alguna fila quedara sin backfillear (no
-- deberia ser posible dado el COALESCE de arriba), la migracion completa
-- se revierte ANTES de forzar NOT NULL, en vez de dejar una columna NOT
-- NULL con datos inconsistentes.
DO $$
DECLARE
  missing_quotes INTEGER;
  missing_sales INTEGER;
BEGIN
  SELECT COUNT(*) INTO missing_quotes FROM "quotes" WHERE "currency_code" IS NULL OR "tax_enabled" IS NULL OR "tax_rate" IS NULL;
  SELECT COUNT(*) INTO missing_sales FROM "sales" WHERE "currency_code" IS NULL OR "tax_enabled" IS NULL OR "tax_rate" IS NULL;

  IF missing_quotes > 0 THEN
    RAISE EXCEPTION 'Fase 11B: backfill de contexto fiscal incompleto en quotes: % fila(s) sin currency_code/tax_enabled/tax_rate', missing_quotes;
  END IF;

  IF missing_sales > 0 THEN
    RAISE EXCEPTION 'Fase 11B: backfill de contexto fiscal incompleto en sales: % fila(s) sin currency_code/tax_enabled/tax_rate', missing_sales;
  END IF;
END $$;

-- AlterTable: ahora que todas las filas tienen valor, se fuerza NOT NULL.
ALTER TABLE "quotes"
  ALTER COLUMN "currency_code" SET NOT NULL,
  ALTER COLUMN "tax_enabled" SET NOT NULL,
  ALTER COLUMN "tax_rate" SET NOT NULL;

ALTER TABLE "sales"
  ALTER COLUMN "currency_code" SET NOT NULL,
  ALTER COLUMN "tax_enabled" SET NOT NULL,
  ALTER COLUMN "tax_rate" SET NOT NULL;

-- CHECK: mismo formato/rango que company_settings (Bloque 11B #6: "usar
-- tipos/constraints exactos consistentes con CompanySettings").
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_currency_code_format" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_tax_rate_range" CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);

ALTER TABLE "sales" ADD CONSTRAINT "sales_currency_code_format" CHECK ("currency_code" ~ '^[A-Z]{3}$');
ALTER TABLE "sales" ADD CONSTRAINT "sales_tax_rate_range" CHECK ("tax_rate" >= 0 AND "tax_rate" <= 100);

-- ============================================================================
-- 3. Tablas fiscales nuevas
-- ============================================================================

-- CreateTable
CREATE TABLE "fiscal_series" (
    "id" UUID NOT NULL,
    "document_type" "FiscalDocumentType" NOT NULL,
    "series" VARCHAR(4) NOT NULL,
    "current_number" INTEGER NOT NULL DEFAULT 0,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "fiscal_series_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "electronic_documents" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "fiscal_series_id" UUID NOT NULL,
    "document_type" "FiscalDocumentType" NOT NULL,
    "series" VARCHAR(4) NOT NULL,
    "number" INTEGER NOT NULL,
    "status" "ElectronicDocumentStatus" NOT NULL DEFAULT 'CREATED',
    "provider_code" VARCHAR(20) NOT NULL,
    "currency_code" VARCHAR(3) NOT NULL,
    "issuer_tax_id" VARCHAR(20) NOT NULL,
    "issuer_business_name" VARCHAR(150) NOT NULL,
    "issuer_address" VARCHAR(300),
    "customer_document_type" "CustomerDocumentType",
    "customer_document_number" VARCHAR(32),
    "customer_name" VARCHAR(150) NOT NULL,
    "customer_address" VARCHAR(300),
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount_amount" DECIMAL(14,2) NOT NULL,
    "taxable_base" DECIMAL(14,2) NOT NULL,
    "tax_amount" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,
    "provider_external_id" VARCHAR(100),
    "provider_status" VARCHAR(50),
    "provider_message" VARCHAR(500),
    "submission_count" INTEGER NOT NULL DEFAULT 0,
    "issued_at" TIMESTAMP(3) NOT NULL,
    "last_submitted_at" TIMESTAMP(3),
    "accepted_at" TIMESTAMP(3),
    "rejected_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "electronic_documents_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "electronic_document_items" (
    "id" UUID NOT NULL,
    "electronic_document_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "product_sku" VARCHAR(40) NOT NULL,
    "description" VARCHAR(150) NOT NULL,
    "unit_code" VARCHAR(15) NOT NULL,
    "unit_name" VARCHAR(60) NOT NULL,
    "unit_abbreviation" VARCHAR(10) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "electronic_document_items_pkey" PRIMARY KEY ("id")
);

-- ============================================================================
-- 4. Indices
-- ============================================================================

-- CreateIndex
CREATE UNIQUE INDEX "fiscal_series_document_type_series_key" ON "fiscal_series"("document_type", "series");

-- CreateIndex
CREATE INDEX "electronic_documents_sale_id_idx" ON "electronic_documents"("sale_id");

-- CreateIndex
CREATE INDEX "electronic_documents_status_idx" ON "electronic_documents"("status");

-- CreateIndex
CREATE INDEX "electronic_documents_created_at_idx" ON "electronic_documents"("created_at");

-- CreateIndex
CREATE INDEX "electronic_documents_customer_document_number_idx" ON "electronic_documents"("customer_document_number");

-- CreateIndex: identidad fiscal unica (Bloque 11B #18).
CREATE UNIQUE INDEX "electronic_documents_document_type_series_number_key" ON "electronic_documents"("document_type", "series", "number");

-- CreateIndex: a lo sumo UN documento fiscal PRIMARIO por venta (Bloque 11B
-- #17). Indice unico PARCIAL (no representable en el DSL de Prisma, se
-- agrega a mano, mismo criterio que el resto del dominio para constraints
-- que Prisma no puede expresar declarativamente): el filtro por
-- document_type deja espacio para que una futura NOTA_CREDITO/NOTA_DEBITO
-- coexista con el documento original sin rediseñar Sale ni este indice.
-- Hoy FACTURA/BOLETA son los unicos valores del enum, asi que el filtro
-- cubre el 100% de las filas actuales, pero la expresion ya es la version
-- final prevista para cuando el enum crezca.
CREATE UNIQUE INDEX "electronic_documents_one_primary_per_sale" ON "electronic_documents"("sale_id") WHERE "document_type" IN ('FACTURA', 'BOLETA');

-- CreateIndex
CREATE UNIQUE INDEX "electronic_document_items_electronic_document_id_line_numbe_key" ON "electronic_document_items"("electronic_document_id", "line_number");

-- ============================================================================
-- 5. Claves foraneas
-- ============================================================================

-- AddForeignKey
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_fiscal_series_id_fkey" FOREIGN KEY ("fiscal_series_id") REFERENCES "fiscal_series"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "electronic_document_items" ADD CONSTRAINT "electronic_document_items_electronic_document_id_fkey" FOREIGN KEY ("electronic_document_id") REFERENCES "electronic_documents"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- ============================================================================
-- 6. CHECK constraints
-- ============================================================================

-- fiscal_series: formato de serie por tipo de documento (Bloque 11B #12/
-- #23: reglas de Peru aprobadas -- 4 caracteres alfanumericos en mayuscula,
-- primer caracter fijo por tipo). No se normaliza silenciosamente una
-- serie invalida ya almacenada: el INSERT/UPDATE simplemente falla.
ALTER TABLE "fiscal_series" ADD CONSTRAINT "fiscal_series_series_format_by_type" CHECK (
  ("document_type" = 'FACTURA' AND "series" ~ '^F[A-Z0-9]{3}$')
  OR ("document_type" = 'BOLETA' AND "series" ~ '^B[A-Z0-9]{3}$')
);

-- fiscal_series: current_number es el ULTIMO numero emitido; 0 = ninguno
-- todavia; tope 99,999,999 (Bloque 11B #12/#23).
ALTER TABLE "fiscal_series" ADD CONSTRAINT "fiscal_series_current_number_range" CHECK ("current_number" >= 0 AND "current_number" <= 99999999);

-- electronic_documents: mismo criterio de moneda que quotes/sales/company_settings.
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_currency_code_format" CHECK ("currency_code" ~ '^[A-Z]{3}$');

-- electronic_documents: montos nunca negativos (Bloque 11B #16).
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_subtotal_non_negative" CHECK ("subtotal" >= 0);
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_discount_non_negative" CHECK ("discount_amount" >= 0);
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_taxable_base_non_negative" CHECK ("taxable_base" >= 0);
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_tax_non_negative" CHECK ("tax_amount" >= 0);
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_total_non_negative" CHECK ("total" >= 0);

-- electronic_documents: el descuento nunca puede exceder el subtotal.
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_discount_within_subtotal" CHECK ("discount_amount" <= "subtotal");

-- electronic_documents: aritmetica exacta de cabecera (NUMERIC de Postgres,
-- sin punto flotante -- mismo criterio que sales_total_arithmetic). A
-- diferencia de Sale (que no persiste taxable_base), aqui se exige la
-- consistencia en dos pasos: base imponible y luego total.
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_taxable_base_arithmetic" CHECK ("taxable_base" = "subtotal" - "discount_amount");
ALTER TABLE "electronic_documents" ADD CONSTRAINT "electronic_documents_total_arithmetic" CHECK ("total" = "taxable_base" + "tax_amount");

-- electronic_document_items: mismos 4 CHECK que sale_items/quote_items.
ALTER TABLE "electronic_document_items" ADD CONSTRAINT "electronic_document_items_line_number_positive" CHECK ("line_number" >= 1);
ALTER TABLE "electronic_document_items" ADD CONSTRAINT "electronic_document_items_quantity_positive" CHECK ("quantity" > 0);
ALTER TABLE "electronic_document_items" ADD CONSTRAINT "electronic_document_items_unit_price_non_negative" CHECK ("unit_price" >= 0);
ALTER TABLE "electronic_document_items" ADD CONSTRAINT "electronic_document_items_line_total_non_negative" CHECK ("line_total" >= 0);

-- electronic_document_items: aritmetica exacta de linea (mismo criterio
-- ROUND/HALF_UP que sale_items_line_arithmetic).
ALTER TABLE "electronic_document_items" ADD CONSTRAINT "electronic_document_items_line_arithmetic" CHECK ("line_total" = ROUND("quantity" * "unit_price", 2));
