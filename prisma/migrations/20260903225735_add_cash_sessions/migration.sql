-- Ticket B post-MVP, Bloque B1 (persistencia únicamente) ---------------------
--
-- Migración puramente ADITIVA: crea cash_sessions y
-- cash_session_payment_method_summaries desde cero, y agrega
-- payments.cash_session_id NULLABLE. Ningún dato existente se modifica, se
-- elimina ni se recalcula — sin backfill, porque todo Payment anterior a
-- este bloque es histórico legítimo y jamás recibe una CashSession
-- fabricada (cash_session_id queda NULL para siempre en esos registros).
-- Compatible con la aplicación de Ticket C ya publicada: ningún código
-- actual conoce estas tablas ni esta columna todavía.
--
-- Restricciones agregadas a mano más abajo (el DSL de Prisma no expresa
-- CHECK, WHERE parcial ni BTRIM()), mismo criterio que el resto del
-- dominio:
--   1. Índice único parcial `cash_sessions_one_unresolved_per_user`: como
--      máximo una fila OPEN o PENDING_APPROVAL por usuario — la protección
--      de concurrencia real contra aperturas simultáneas (un
--      findFirst()+insert() en la capa de aplicación nunca sería
--      suficiente contra una carrera real).
--   2. CHECK opening_amount >= 0.
--   3. CHECK counted_cash_amount IS NULL OR counted_cash_amount >= 0.
--   4. CHECK de aritmética exacta: difference_amount = counted_cash_amount
--      - expected_cash_amount (NUMERIC(14,2) es exacto, nunca punto
--      flotante). Sin CHECK de signo sobre difference_amount (puede ser
--      negativo, cero o positivo) y sin CHECK "expected_cash_amount >= 0"
--      (no es una invariante aprobada todavía).
--   5. CHECK de consistencia de estado (cash_sessions_status_consistency),
--      mismo patrón que payments_cancellation_consistency
--      (20260812234700_add_payments/migration.sql): exactamente un bloque
--      por valor de CashSessionStatus, con el estado CLOSED subdividido en
--      cierre limpio (sin revisor) vs. cierre con descuadre aprobado (con
--      revisor). Ninguno de estos CHECK calcula
--      "expected = opening + suma(payments)": esa aritmética es
--      cross-table y pertenece al futuro servicio de CashSession, nunca a
--      un CHECK de una sola tabla.

-- CreateEnum
CREATE TYPE "CashSessionStatus" AS ENUM ('OPEN', 'PENDING_APPROVAL', 'CLOSED');

-- AlterTable
ALTER TABLE "payments" ADD COLUMN     "cash_session_id" UUID;

-- CreateTable
CREATE TABLE "cash_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "status" "CashSessionStatus" NOT NULL DEFAULT 'OPEN',
    "opening_amount" DECIMAL(14,2) NOT NULL,
    "opened_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "close_requested_at" TIMESTAMP(3),
    "expected_cash_amount" DECIMAL(14,2),
    "counted_cash_amount" DECIMAL(14,2),
    "difference_amount" DECIMAL(14,2),
    "closing_observation" VARCHAR(500),
    "closed_at" TIMESTAMP(3),
    "approved_by_user_id" UUID,
    "approved_at" TIMESTAMP(3),
    "approval_comment" VARCHAR(500),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "cash_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "cash_session_payment_method_summaries" (
    "id" UUID NOT NULL,
    "cash_session_id" UUID NOT NULL,
    "payment_method_id" UUID NOT NULL,
    "payment_method_code" VARCHAR(30) NOT NULL,
    "payment_method_name" VARCHAR(60) NOT NULL,
    "total_amount" DECIMAL(14,2) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "cash_session_payment_method_summaries_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "cash_session_payment_method_summaries_cash_session_id_payme_key" ON "cash_session_payment_method_summaries"("cash_session_id", "payment_method_id");

-- CreateIndex
CREATE INDEX "payments_cash_session_id_status_idx" ON "payments"("cash_session_id", "status");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_cash_session_id_fkey" FOREIGN KEY ("cash_session_id") REFERENCES "cash_sessions"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_sessions" ADD CONSTRAINT "cash_sessions_approved_by_user_id_fkey" FOREIGN KEY ("approved_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_session_payment_method_summaries" ADD CONSTRAINT "cash_session_payment_method_summaries_cash_session_id_fkey" FOREIGN KEY ("cash_session_id") REFERENCES "cash_sessions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "cash_session_payment_method_summaries" ADD CONSTRAINT "cash_session_payment_method_summaries_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Bloque B1) -----------------------------------------
-- El DSL de Prisma no expresa CHECK, WHERE parcial ni BTRIM(); se agregan a
-- mano, mismo criterio que el resto del dominio (Category/Unit/Product/
-- Sale/Payment/PaymentMethod/FiscalSeries/ElectronicDocument/...).

-- 1. Como máximo una CashSession sin resolver (OPEN o PENDING_APPROVAL) por
--    usuario. Protección de concurrencia real contra aperturas simultáneas
--    del mismo cobrador — la aplicación NUNCA puede confiar solo en un
--    findFirst() previo al insert, porque eso no cierra la ventana de
--    carrera; la base de datos es la autoridad final. Mismo patrón exacto
--    que el índice único parcial ya existente
--    "electronic_documents_one_primary_per_sale"
--    (20260826190000_add_electronic_invoicing_foundation/migration.sql).
CREATE UNIQUE INDEX "cash_sessions_one_unresolved_per_user"
  ON "cash_sessions"("user_id")
  WHERE "status" IN ('OPEN', 'PENDING_APPROVAL');

-- 2. Monto de apertura: manual, obligatorio, puede ser 0, nunca negativo.
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_opening_amount_non_negative"
  CHECK ("opening_amount" >= 0);

-- 3. Efectivo contado físicamente: nunca negativo cuando está poblado.
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_counted_cash_non_negative"
  CHECK ("counted_cash_amount" IS NULL OR "counted_cash_amount" >= 0);

-- 4. Aritmética exacta del descuadre: los tres valores viven en la misma
--    fila y NUMERIC(14,2) es exacto (sin punto flotante), igual que
--    "electronic_documents_taxable_base_arithmetic"
--    (20260826190000_add_electronic_invoicing_foundation/migration.sql).
--    Guard IS NULL explícito por claridad (Postgres ya trata una
--    comparación con NULL como no-violación, pero se deja igual de
--    explícito que payments_reference_not_blank). Sin CHECK de signo: el
--    descuadre puede ser negativo, cero o positivo.
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_difference_arithmetic"
  CHECK (
    "difference_amount" IS NULL
    OR "difference_amount" = "counted_cash_amount" - "expected_cash_amount"
  );

-- 5. Consistencia de estado — un solo bloque por valor de
--    CashSessionStatus, mismo patrón exacto que
--    "payments_cancellation_consistency"
--    (20260812234700_add_payments/migration.sql). CLOSED se subdivide en
--    cierre limpio (sin descuadre, sin revisor: se exige que los 3 campos
--    de aprobación queden NULL; closing_observation puede quedar NULL) y
--    cierre con descuadre aprobado (revisor + fecha obligatorios;
--    approval_comment sigue sin restricción, siempre opcional —
--    closing_observation, en cambio, es OBLIGATORIA y no en blanco: la
--    regla de negocio aprobada exige la observación del operador desde el
--    momento en que difference_amount <> 0 entra a PENDING_APPROVAL, y esa
--    obligatoriedad debe sobrevivir intacta hasta el CLOSED histórico
--    final — un descuadre aprobado nunca puede terminar sin la
--    observación que lo motivó). Ningún branch calcula
--    "expected_cash_amount = opening_amount + suma(payments)": esa
--    aritmética es cross-table y pertenece al futuro servicio de
--    CashSession.
ALTER TABLE "cash_sessions"
  ADD CONSTRAINT "cash_sessions_status_consistency"
  CHECK (
    (
      "status" = 'OPEN'
      AND "close_requested_at" IS NULL
      AND "expected_cash_amount" IS NULL
      AND "counted_cash_amount" IS NULL
      AND "difference_amount" IS NULL
      AND "closing_observation" IS NULL
      AND "closed_at" IS NULL
      AND "approved_by_user_id" IS NULL
      AND "approved_at" IS NULL
      AND "approval_comment" IS NULL
    )
    OR
    (
      "status" = 'PENDING_APPROVAL'
      AND "close_requested_at" IS NOT NULL
      AND "expected_cash_amount" IS NOT NULL
      AND "counted_cash_amount" IS NOT NULL
      AND "difference_amount" IS NOT NULL
      AND "difference_amount" <> 0
      AND "closing_observation" IS NOT NULL
      AND BTRIM("closing_observation") <> ''
      AND "closed_at" IS NULL
      AND "approved_by_user_id" IS NULL
      AND "approved_at" IS NULL
      AND "approval_comment" IS NULL
    )
    OR
    (
      "status" = 'CLOSED'
      AND "close_requested_at" IS NOT NULL
      AND "expected_cash_amount" IS NOT NULL
      AND "counted_cash_amount" IS NOT NULL
      AND "difference_amount" IS NOT NULL
      AND "closed_at" IS NOT NULL
      AND (
        (
          "difference_amount" = 0
          AND "approved_by_user_id" IS NULL
          AND "approved_at" IS NULL
          AND "approval_comment" IS NULL
        )
        OR
        (
          "difference_amount" <> 0
          AND "approved_by_user_id" IS NOT NULL
          AND "approved_at" IS NOT NULL
          AND "closing_observation" IS NOT NULL
          AND BTRIM("closing_observation") <> ''
        )
      )
    )
  );
