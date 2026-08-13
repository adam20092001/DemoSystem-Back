-- CreateEnum
CREATE TYPE "PaymentMethod" AS ENUM ('CASH', 'BANK_TRANSFER', 'BANK_DEPOSIT', 'CARD', 'DIGITAL_WALLET', 'OTHER');

-- CreateEnum
CREATE TYPE "PaymentStatus" AS ENUM ('ACTIVE', 'CANCELLED');

-- CreateEnum
CREATE TYPE "PaymentCancellationSource" AS ENUM ('MANUAL', 'SALE_CANCELLATION');

-- CreateTable
CREATE TABLE "payments" (
    "id" UUID NOT NULL,
    "sale_id" UUID NOT NULL,
    "method" "PaymentMethod" NOT NULL,
    "amount" DECIMAL(14,2) NOT NULL,
    "reference" VARCHAR(100),
    "status" "PaymentStatus" NOT NULL DEFAULT 'ACTIVE',
    "paid_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "cancelled_at" TIMESTAMP(3),
    "cancellation_reason" VARCHAR(200),
    "cancelled_by_user_id" UUID,
    "cancellation_source" "PaymentCancellationSource",
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "payments_sale_id_paid_at_idx" ON "payments"("sale_id", "paid_at");

-- CreateIndex
CREATE INDEX "payments_paid_at_id_idx" ON "payments"("paid_at", "id");

-- CreateIndex
CREATE INDEX "payments_status_paid_at_idx" ON "payments"("status", "paid_at");

-- CreateIndex
CREATE INDEX "payments_created_by_user_id_paid_at_idx" ON "payments"("created_by_user_id", "paid_at");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_sale_id_fkey" FOREIGN KEY ("sale_id") REFERENCES "sales"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_cancelled_by_user_id_fkey" FOREIGN KEY ("cancelled_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Fase 7, Bloque A) --------------------------------
-- El DSL de Prisma no expresa CHECK; se agregan a mano, igual que en las
-- Fases 2-6. Conteo final: 4. Puramente aditivo: ningún CHECK de sales
-- (Fase 6) se modifica en esta migración.

-- 1. Monto siempre positivo.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_amount_positive"
  CHECK ("amount" > 0);

-- 2. Referencia nunca en blanco cuando está presente.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reference_not_blank"
  CHECK ("reference" IS NULL OR BTRIM("reference") <> '');

-- 3. Referencia obligatoria a nivel de base de datos solo para
--    BANK_TRANSFER/BANK_DEPOSIT/CARD (Documento Maestro §16: "Referencia
--    obligatoria para transferencia, depósito y tarjeta"). Opcional para
--    CASH/DIGITAL_WALLET/OTHER.
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_reference_required_by_method"
  CHECK (
    "method" NOT IN ('BANK_TRANSFER', 'BANK_DEPOSIT', 'CARD')
    OR ("reference" IS NOT NULL AND BTRIM("reference") <> '')
  );

-- 4. Consistencia histórica de anulación (D2 aprobado): ACTIVE exige los
--    cuatro campos NULL; CANCELLED exige cancelledAt/cancelledBy/source no
--    nulos, con cancellationReason obligatorio y no vacío únicamente cuando
--    cancellationSource=MANUAL (NULL cuando es SALE_CANCELLATION, para no
--    duplicar el motivo de anulación de la venta).
ALTER TABLE "payments"
  ADD CONSTRAINT "payments_cancellation_consistency"
  CHECK (
    (
      "status" = 'ACTIVE'
      AND "cancelled_at" IS NULL
      AND "cancellation_reason" IS NULL
      AND "cancelled_by_user_id" IS NULL
      AND "cancellation_source" IS NULL
    )
    OR
    (
      "status" = 'CANCELLED'
      AND "cancelled_at" IS NOT NULL
      AND "cancelled_by_user_id" IS NOT NULL
      AND "cancellation_source" IS NOT NULL
      AND (
        "cancellation_source" <> 'MANUAL'
        OR ("cancellation_reason" IS NOT NULL AND BTRIM("cancellation_reason") <> '')
      )
      AND (
        "cancellation_source" <> 'SALE_CANCELLATION'
        OR "cancellation_reason" IS NULL
      )
    )
  );
