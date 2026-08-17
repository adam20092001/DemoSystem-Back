-- CreateEnum
CREATE TYPE "AccountType" AS ENUM ('ASSET', 'LIABILITY', 'REVENUE', 'CONTRA_REVENUE');

-- CreateEnum
CREATE TYPE "AccountingSystemKey" AS ENUM ('CASH', 'BANK', 'ACCOUNTS_RECEIVABLE', 'VAT_PAYABLE', 'SALES_REVENUE', 'DISCOUNTS');

-- CreateEnum
CREATE TYPE "AccountingSourceType" AS ENUM ('SALE', 'PAYMENT');

-- CreateEnum
CREATE TYPE "AccountingEventType" AS ENUM ('ORIGINAL', 'REVERSAL');

-- CreateTable
CREATE TABLE "chart_of_accounts" (
    "id" UUID NOT NULL,
    "code" VARCHAR(20) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "type" "AccountType" NOT NULL,
    "system_key" "AccountingSystemKey" NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "chart_of_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_entries" (
    "id" UUID NOT NULL,
    "source_type" "AccountingSourceType" NOT NULL,
    "source_id" UUID NOT NULL,
    "event_type" "AccountingEventType" NOT NULL,
    "reverses_entry_id" UUID,
    "description" VARCHAR(200) NOT NULL,
    "posted_at" TIMESTAMP(3) NOT NULL,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "accounting_entry_lines" (
    "id" UUID NOT NULL,
    "entry_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "debit_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_entry_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_accounts_code_key" ON "chart_of_accounts"("code");

-- CreateIndex
CREATE UNIQUE INDEX "chart_of_accounts_system_key_key" ON "chart_of_accounts"("system_key");

-- CreateIndex
CREATE UNIQUE INDEX "accounting_entries_reverses_entry_id_key" ON "accounting_entries"("reverses_entry_id");

-- CreateIndex
CREATE INDEX "accounting_entries_posted_at_id_idx" ON "accounting_entries"("posted_at", "id");

-- CreateIndex
CREATE INDEX "accounting_entries_source_type_source_id_idx" ON "accounting_entries"("source_type", "source_id");

-- CreateIndex
CREATE INDEX "accounting_entries_event_type_posted_at_idx" ON "accounting_entries"("event_type", "posted_at");

-- CreateIndex
CREATE INDEX "accounting_entry_lines_entry_id_idx" ON "accounting_entry_lines"("entry_id");

-- CreateIndex
CREATE INDEX "accounting_entry_lines_account_id_entry_id_idx" ON "accounting_entry_lines"("account_id", "entry_id");

-- AddForeignKey
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_reverses_entry_id_fkey" FOREIGN KEY ("reverses_entry_id") REFERENCES "accounting_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_entry_lines" ADD CONSTRAINT "accounting_entry_lines_entry_id_fkey" FOREIGN KEY ("entry_id") REFERENCES "accounting_entries"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_entry_lines" ADD CONSTRAINT "accounting_entry_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "chart_of_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Fase 8, Bloque A) --------------------------------
-- El DSL de Prisma no expresa CHECK ni índices únicos parciales; se agregan
-- a mano, igual que en las Fases 2-7. Conteo final: 6 CHECK + 1 índice
-- único parcial. Puramente aditivo: ningún CHECK/índice previo se modifica
-- en esta migración.

-- 1. chart_of_accounts.code nunca en blanco.
ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_code_not_blank"
  CHECK (BTRIM("code") <> '');

-- 2. chart_of_accounts.name nunca en blanco.
ALTER TABLE "chart_of_accounts"
  ADD CONSTRAINT "chart_of_accounts_name_not_blank"
  CHECK (BTRIM("name") <> '');

-- 3. accounting_entries.description nunca en blanco.
ALTER TABLE "accounting_entries"
  ADD CONSTRAINT "accounting_entries_description_not_blank"
  CHECK (BTRIM("description") <> '');

-- 4. Consistencia ORIGINAL/REVERSAL: un asiento ORIGINAL nunca lleva
--    reverses_entry_id; un asiento REVERSAL siempre lo lleva.
ALTER TABLE "accounting_entries"
  ADD CONSTRAINT "accounting_entries_reversal_consistency"
  CHECK (
    ("event_type" = 'ORIGINAL' AND "reverses_entry_id" IS NULL)
    OR
    ("event_type" = 'REVERSAL' AND "reverses_entry_id" IS NOT NULL)
  );

-- 5. Un asiento nunca puede reversarse a sí mismo.
ALTER TABLE "accounting_entries"
  ADD CONSTRAINT "accounting_entries_not_self_reversal"
  CHECK ("reverses_entry_id" IS NULL OR "reverses_entry_id" <> "id");

-- 6. Exactamente un lado (debit o credit) positivo por línea: sin negativos,
--    sin fila 0/0, sin ambos lados positivos a la vez. Defensa de última
--    línea; el cuadre cruzado SUM(debit)=SUM(credit) de todo el asiento es
--    responsabilidad de AccountingEngine (Bloque B), nunca de un CHECK
--    fila-a-fila ni de un trigger.
ALTER TABLE "accounting_entry_lines"
  ADD CONSTRAINT "accounting_entry_lines_debit_credit_exclusive"
  CHECK (
    ("debit_amount" > 0 AND "credit_amount" = 0)
    OR
    ("credit_amount" > 0 AND "debit_amount" = 0)
  );

-- Índice único parcial: protección de duplicidad de asiento ORIGINAL a
-- nivel de base de datos, autoritativa bajo concurrencia (Block B la
-- refuerza con una verificación de aplicación, pero esta es la última
-- línea de defensa real). No se modela como @@unique de Prisma porque un
-- asiento REVERSAL reutiliza deliberadamente el mismo (source_type,
-- source_id) que su ORIGINAL.
CREATE UNIQUE INDEX "accounting_entries_one_original_per_source"
ON "accounting_entries" ("source_type", "source_id")
WHERE "event_type" = 'ORIGINAL';
