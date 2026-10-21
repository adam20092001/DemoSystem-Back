-- Fase A4 (asientos manuales + rol ACCOUNTANT). Migración 100% aditiva:
-- ningún tipo/tabla/columna existente se elimina ni se reescribe. Los
-- borradores viven en un modelo nuevo y separado (manual_journal_drafts/
-- manual_journal_draft_lines), nunca como filas de accounting_entries —
-- así los reportes de A3 (Diario/Mayor/Balance), que leen
-- accounting_entries/accounting_entry_lines directamente, jamás incluyen
-- un monto todavía no contabilizado.

-- AlterEnum
ALTER TYPE "RoleName" ADD VALUE 'ACCOUNTANT';

-- AlterEnum
ALTER TYPE "AccountingSourceType" ADD VALUE 'MANUAL';

-- CreateEnum
CREATE TYPE "ManualJournalDraftStatus" AS ENUM ('DRAFT', 'POSTED');

-- CreateTable
CREATE TABLE "manual_journal_drafts" (
    "id" UUID NOT NULL,
    "accounting_date" DATE NOT NULL,
    "description" VARCHAR(200) NOT NULL,
    "status" "ManualJournalDraftStatus" NOT NULL DEFAULT 'DRAFT',
    "posted_entry_id" UUID,
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_journal_drafts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "manual_journal_draft_lines" (
    "id" UUID NOT NULL,
    "draft_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "debit_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "credit_amount" DECIMAL(14,2) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "manual_journal_draft_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "manual_journal_drafts_posted_entry_id_key" ON "manual_journal_drafts"("posted_entry_id");

-- CreateIndex
CREATE INDEX "manual_journal_drafts_status_idx" ON "manual_journal_drafts"("status");

-- CreateIndex
CREATE INDEX "manual_journal_draft_lines_draft_id_idx" ON "manual_journal_draft_lines"("draft_id");

-- CreateIndex
CREATE INDEX "manual_journal_draft_lines_account_id_idx" ON "manual_journal_draft_lines"("account_id");

-- AddForeignKey
ALTER TABLE "manual_journal_drafts" ADD CONSTRAINT "manual_journal_drafts_posted_entry_id_fkey" FOREIGN KEY ("posted_entry_id") REFERENCES "accounting_entries"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_journal_drafts" ADD CONSTRAINT "manual_journal_drafts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_journal_draft_lines" ADD CONSTRAINT "manual_journal_draft_lines_draft_id_fkey" FOREIGN KEY ("draft_id") REFERENCES "manual_journal_drafts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "manual_journal_draft_lines" ADD CONSTRAINT "manual_journal_draft_lines_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "chart_of_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Nota manual (Fase A4): el DSL de Prisma no expresa CHECK de forma
-- declarativa (mismo criterio que accounting_entries/accounting_entry_lines/
-- chart_of_accounts/accounting_periods en migraciones previas).

-- 1. manual_journal_drafts.description nunca en blanco (mismo criterio
--    que accounting_entries_description_not_blank).
ALTER TABLE "manual_journal_drafts" ADD CONSTRAINT "manual_journal_drafts_description_not_blank" CHECK (BTRIM("description") <> '');

-- 2. Ningún monto negativo en una línea de borrador — nunca hay un caso
--    de negocio legítimo para esto, ni siquiera mientras se edita.
ALTER TABLE "manual_journal_draft_lines" ADD CONSTRAINT "manual_journal_draft_lines_no_negative_amounts" CHECK ("debit_amount" >= 0 AND "credit_amount" >= 0);

-- 3. Una línea de borrador NUNCA puede tener ambos lados positivos a la
--    vez (a diferencia de accounting_entry_lines, SÍ se permite 0/0:
--    representa una línea todavía sin llenar mientras el borrador se
--    edita — el cuadre cruzado exacto, "exactamente un lado positivo",
--    se exige recién al contabilizar, en AccountingEngine.postManualEntry(),
--    nunca antes).
ALTER TABLE "manual_journal_draft_lines" ADD CONSTRAINT "manual_journal_draft_lines_not_both_sides" CHECK (NOT ("debit_amount" > 0 AND "credit_amount" > 0));
