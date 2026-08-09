-- CreateEnum
CREATE TYPE "SaleStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "SalePaymentStatus" AS ENUM ('UNPAID', 'PARTIALLY_PAID', 'PAID');

-- CreateEnum
CREATE TYPE "SaleDeliveryStatus" AS ENUM ('NOT_APPLICABLE', 'PENDING', 'DELIVERED', 'OBSERVED');

-- CreateTable
CREATE TABLE "sales" (
    "id" UUID NOT NULL,
    "number" VARCHAR(30) NOT NULL,
    "status" "SaleStatus" NOT NULL DEFAULT 'ACTIVE',
    "payment_status" "SalePaymentStatus" NOT NULL,
    "delivery_status" "SaleDeliveryStatus" NOT NULL,
    "customer_id" UUID NOT NULL,
    "customer_is_generic" BOOLEAN NOT NULL,
    "customer_type" "CustomerType",
    "customer_document_type" "CustomerDocumentType",
    "customer_document_number" VARCHAR(32),
    "customer_name" VARCHAR(150) NOT NULL,
    "customer_address" VARCHAR(300),
    "seller_id" UUID NOT NULL,
    "quote_id" UUID,
    "subtotal" DECIMAL(14,2) NOT NULL,
    "discount_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "tax_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "total" DECIMAL(14,2) NOT NULL,
    "paid_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "balance_due" DECIMAL(14,2) NOT NULL,
    "confirmed_at" TIMESTAMP(3) NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" VARCHAR(200),
    "cancelled_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "sales_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sale_items" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
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

    CONSTRAINT "sale_items_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "sales_number_key" ON "sales"("number");

-- CreateIndex
CREATE UNIQUE INDEX "sales_quote_id_key" ON "sales"("quote_id");

-- CreateIndex
CREATE INDEX "sales_customer_id_confirmed_at_idx" ON "sales"("customer_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "sales_seller_id_confirmed_at_idx" ON "sales"("seller_id", "confirmed_at");

-- CreateIndex
CREATE INDEX "sales_status_confirmed_at_idx" ON "sales"("status", "confirmed_at");

-- CreateIndex
CREATE INDEX "sales_payment_status_confirmed_at_idx" ON "sales"("payment_status", "confirmed_at");

-- CreateIndex
CREATE INDEX "sales_delivery_status_confirmed_at_idx" ON "sales"("delivery_status", "confirmed_at");

-- CreateIndex
CREATE INDEX "sales_confirmed_at_id_idx" ON "sales"("confirmed_at", "id");

-- CreateIndex
CREATE INDEX "sale_items_product_id_idx" ON "sale_items"("product_id");

-- CreateIndex
CREATE UNIQUE INDEX "sale_items_sale_id_product_id_key" ON "sale_items"("sale_id", "product_id");

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_seller_id_fkey" FOREIGN KEY ("seller_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_quote_id_fkey" FOREIGN KEY ("quote_id") REFERENCES "quotes"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sales" ADD CONSTRAINT "sales_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sale_items" ADD CONSTRAINT "sale_items_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Fase 6, Bloque A) --------------------------------
-- El DSL de Prisma no expresa CHECK; se agregan a mano, igual que en las
-- Fases 2-5. Conteo final: 22 (18 sales + 4 sale_items). La equivalencia
-- ROUND(NUMERIC,2) = Prisma.Decimal.ROUND_HALF_UP ya se verificó
-- empíricamente en la Fase 5 (quote_items_line_arithmetic); no se repite el
-- experimento.

-- 1. number nunca en blanco.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_number_not_blank"
  CHECK (BTRIM("number") <> '');

-- 2. Todo cliente no genérico exige customerType; el genérico snapshot no lo
--    tiene (a diferencia de Quote, Sale sí admite genérico).
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_customer_type_generic_consistency"
  CHECK (
    ("customer_is_generic" = false AND "customer_type" IS NOT NULL)
    OR
    ("customer_is_generic" = true AND "customer_type" IS NULL)
  );

-- 3. Par de documento del snapshot de cliente: ambos nulos o ambos con
--    valor no vacío.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_customer_document_pair"
  CHECK (
    ("customer_document_type" IS NULL AND "customer_document_number" IS NULL)
    OR
    ("customer_document_type" IS NOT NULL
     AND "customer_document_number" IS NOT NULL
     AND BTRIM("customer_document_number") <> '')
  );

-- 4. El snapshot del cliente genérico nunca tiene documento.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_generic_no_document"
  CHECK (
    "customer_is_generic" = false
    OR ("customer_document_type" IS NULL AND "customer_document_number" IS NULL)
  );

-- 5. Público general nunca puede quedar con saldo pendiente (D4, D16 del
--    plan aprobado): en la Fase 6 esto hace estructuralmente imposible una
--    venta de total positivo a Público general.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_generic_no_debt"
  CHECK (
    "customer_is_generic" = false
    OR "balance_due" = 0
  );

-- 6. customer_name nunca en blanco (el documento NV impreso lo exige).
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_customer_name_not_blank"
  CHECK (BTRIM("customer_name") <> '');

-- 7. subtotal nunca negativo.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_subtotal_non_negative"
  CHECK ("subtotal" >= 0);

-- 8. discount_amount nunca negativo.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_discount_non_negative"
  CHECK ("discount_amount" >= 0);

-- 9. tax_amount nunca negativo.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_tax_non_negative"
  CHECK ("tax_amount" >= 0);

-- 10. total nunca negativo.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_total_non_negative"
  CHECK ("total" >= 0);

-- 11. El descuento nunca puede exceder el subtotal.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_discount_within_subtotal"
  CHECK ("discount_amount" <= "subtotal");

-- 12. Aritmética exacta de cabecera.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_total_arithmetic"
  CHECK ("total" = "subtotal" - "discount_amount" + "tax_amount");

-- 13. paid_amount nunca negativo.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_paid_amount_non_negative"
  CHECK ("paid_amount" >= 0);

-- 14. balance_due nunca negativo.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_balance_due_non_negative"
  CHECK ("balance_due" >= 0);

-- 15. Lo pagado nunca puede exceder el total.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_paid_within_total"
  CHECK ("paid_amount" <= "total");

-- 16. Aritmética exacta de pago.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_paid_balance_arithmetic"
  CHECK ("paid_amount" + "balance_due" = "total");

-- 17. Consistencia EXACTA de payment_status (disjunción mutuamente
--     excluyente). La Fase 6 solo produce UNPAID/PAID operativamente;
--     PARTIALLY_PAID queda habilitado a nivel de esquema para que la
--     Fase 7 no requiera migrar esta constraint.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_payment_status_consistency"
  CHECK (
    ("payment_status" = 'UNPAID' AND "total" > 0 AND "paid_amount" = 0)
    OR
    ("payment_status" = 'PARTIALLY_PAID'
     AND "total" > 0 AND "paid_amount" > 0 AND "paid_amount" < "total")
    OR
    ("payment_status" = 'PAID' AND "paid_amount" = "total")
  );

-- 18. Consistencia histórica de anulación: los tres campos de anulación
--     están completos si y solo si status = CANCELLED. Sin trigger: toda
--     escritura de ciclo de vida vive en la transacción de aplicación.
ALTER TABLE "sales"
  ADD CONSTRAINT "sales_cancellation_consistency"
  CHECK (
    (
      "status" <> 'CANCELLED'
      AND "cancelled_at" IS NULL
      AND "cancellation_reason" IS NULL
      AND "cancelled_by_user_id" IS NULL
    )
    OR
    (
      "status" = 'CANCELLED'
      AND "cancelled_at" IS NOT NULL
      AND "cancelled_by_user_id" IS NOT NULL
      AND "cancellation_reason" IS NOT NULL
      AND BTRIM("cancellation_reason") <> ''
    )
  );

-- 19. Cantidad siempre positiva.
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_quantity_positive"
  CHECK ("quantity" > 0);

-- 20. Precio unitario nunca negativo.
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_unit_price_non_negative"
  CHECK ("unit_price" >= 0);

-- 21. Total de línea nunca negativo.
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_line_total_non_negative"
  CHECK ("line_total" >= 0);

-- 22. Aritmética exacta de línea (equivalencia ROUND/HALF_UP ya probada en
--     la Fase 5).
ALTER TABLE "sale_items"
  ADD CONSTRAINT "sale_items_line_arithmetic"
  CHECK ("line_total" = ROUND("quantity" * "unit_price", 2));
