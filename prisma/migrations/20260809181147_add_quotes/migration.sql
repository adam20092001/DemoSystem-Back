-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('QUOTE', 'SALE');

-- CreateEnum
CREATE TYPE "QuoteStatus" AS ENUM ('PENDING', 'ACCEPTED', 'REJECTED', 'EXPIRED', 'CONVERTED');

-- CreateTable
CREATE TABLE "document_sequences" (
    "id" UUID NOT NULL,
    "document_type" "DocumentType" NOT NULL,
    "prefix" VARCHAR(10) NOT NULL,
    "current_number" INTEGER NOT NULL DEFAULT 0,
    "padding" INTEGER NOT NULL DEFAULT 6,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "document_sequences_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quotes" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "status" "QuoteStatus" NOT NULL DEFAULT 'PENDING',
    "customer_id" UUID NOT NULL,
    "customer_type" "CustomerType" NOT NULL,
    "customer_document_type" "CustomerDocumentType",
    "customer_document_number" VARCHAR(32),
    "customer_name" VARCHAR(150) NOT NULL,
    "customer_address" VARCHAR(300),
    "seller_id" UUID NOT NULL,
    "issue_date" DATE NOT NULL,
    "expiration_date" DATE NOT NULL,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "notes" VARCHAR(1000),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "quotes_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "quote_items" (
    "id" UUID NOT NULL,
    "quote_id" UUID NOT NULL,
    "product_id" UUID NOT NULL,
    "product_sku" VARCHAR(40) NOT NULL,
    "product_name" VARCHAR(150) NOT NULL,
    "unit_code" VARCHAR(15) NOT NULL,
    "unit_name" VARCHAR(60) NOT NULL,
    "unit_abbreviation" VARCHAR(10) NOT NULL,
    "quantity" DECIMAL(14,3) NOT NULL,
    "unit_price" DECIMAL(14,2) NOT NULL,
    "line_total" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "quote_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "document_sequences_document_type_key" ON "document_sequences"("document_type");

-- CreateIndex
CREATE UNIQUE INDEX "quotes_number_key" ON "quotes"("number");

-- CreateIndex
CREATE INDEX "quotes_customer_id_created_at_idx" ON "quotes"("customer_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_seller_id_created_at_idx" ON "quotes"("seller_id", "created_at");

-- CreateIndex
CREATE INDEX "quotes_status_created_at_idx" ON "quotes"("status", "created_at");

-- CreateIndex
CREATE INDEX "quotes_created_at_id_idx" ON "quotes"("created_at", "id");

-- CreateIndex
CREATE INDEX "quotes_expiration_date_idx" ON "quotes"("expiration_date");

-- CreateIndex
CREATE INDEX "quotes_issue_date_idx" ON "quotes"("issue_date");

-- CreateIndex
CREATE INDEX "quote_items_product_id_idx" ON "quote_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "quote_items_quote_id_product_id_key" ON "quote_items"("quote_id", "product_id");

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quotes" ADD CONSTRAINT "quotes_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "quote_items" ADD CONSTRAINT "quote_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Fase 5, Bloque A) --------------------------------
-- El DSL de Prisma no expresa CHECK; se agregan a mano, igual que en las
-- Fases 2-4. Conteo final: 16 (9 quotes + 4 quote_items + 3 document_sequences),
-- incluyendo quote_items_line_arithmetic, retenida tras verificar
-- empíricamente que ROUND(NUMERIC,2) de PostgreSQL coincide con
-- Prisma.Decimal.toFixed(2, ROUND_HALF_UP) en los 15 casos de frontera de
-- medio centavo probados (incluidos 0.005, 1.005, 1.015, 24.875, 9.995).

-- 1. subtotal nunca negativo.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_subtotal_non_negative"
  CHECK ("subtotal" >= 0);

-- 2. discount_amount nunca negativo.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_discount_non_negative"
  CHECK ("discount_amount" >= 0);

-- 3. tax_amount nunca negativo.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_tax_non_negative"
  CHECK ("tax_amount" >= 0);

-- 4. total nunca negativo.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_total_non_negative"
  CHECK ("total" >= 0);

-- 5. El descuento nunca puede exceder el subtotal (evita total negativo).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_discount_within_subtotal"
  CHECK ("discount_amount" <= "subtotal");

-- 6. Aritmética exacta de cabecera (NUMERIC es decimal exacto en PostgreSQL).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_total_arithmetic"
  CHECK ("total" = "subtotal" - "discount_amount" + "tax_amount");

-- 7. La vigencia nunca es anterior a la emisión (igualdad permitida: un solo día de vigencia).
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_expiration_after_issue"
  CHECK ("expiration_date" >= "issue_date");

-- 8. El correlativo nunca queda en blanco.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_number_not_blank"
  CHECK (BTRIM("number") <> '');

-- 9. Par de documento del snapshot de cliente: ambos nulos o ambos con
--    valor no vacío. Protege la identidad histórica incluso ante una
--    escritura directa que no pase por el servicio.
ALTER TABLE "quotes"
  ADD CONSTRAINT "quotes_customer_document_pair"
  CHECK (
    ("customer_document_type" IS NULL AND "customer_document_number" IS NULL)
    OR
    ("customer_document_type" IS NOT NULL
     AND "customer_document_number" IS NOT NULL
     AND BTRIM("customer_document_number") <> '')
  );

-- 10. Cantidad siempre positiva.
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_quantity_positive"
  CHECK ("quantity" > 0);

-- 11. Precio unitario nunca negativo (0 admitido: Product.salePrice ya
--     permite 0 para productos/servicios de cortesía).
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_unit_price_non_negative"
  CHECK ("unit_price" >= 0);

-- 12. Total de línea nunca negativo.
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_line_total_non_negative"
  CHECK ("line_total" >= 0);

-- 13. Aritmética exacta de línea. Retenida tras verificación empírica
--     (ver comentario superior): ROUND(NUMERIC,2) coincide con
--     Prisma.Decimal.ROUND_HALF_UP en el dominio no negativo relevante.
ALTER TABLE "quote_items"
  ADD CONSTRAINT "quote_items_line_arithmetic"
  CHECK ("line_total" = ROUND("quantity" * "unit_price", 2));

-- 14. current_number nunca negativo.
ALTER TABLE "document_sequences"
  ADD CONSTRAINT "document_sequences_current_number_non_negative"
  CHECK ("current_number" >= 0);

-- 15. padding en un rango operativamente sensato.
ALTER TABLE "document_sequences"
  ADD CONSTRAINT "document_sequences_padding_range"
  CHECK ("padding" BETWEEN 1 AND 12);

-- 16. prefix nunca en blanco.
ALTER TABLE "document_sequences"
  ADD CONSTRAINT "document_sequences_prefix_not_blank"
  CHECK (BTRIM("prefix") <> '');
