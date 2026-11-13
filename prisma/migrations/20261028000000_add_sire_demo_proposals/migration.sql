-- SIRE DEMO (S2): propuestas importadas. 100% aditiva: no modifica ninguna tabla existente.

-- CreateEnum
CREATE TYPE "SireDemoSource" AS ENUM ('POS', 'DEMO_FIXTURES');

-- CreateEnum
CREATE TYPE "SireDemoRegister" AS ENUM ('RVIE', 'RCE');

-- CreateEnum
CREATE TYPE "SireDemoProposalStatus" AS ENUM ('IMPORTED', 'DISCARDED');

-- CreateTable
CREATE TABLE "sire_demo_proposals" (
    "id" UUID NOT NULL,
    "source" "SireDemoSource" NOT NULL,
    "register" "SireDemoRegister" NOT NULL,
    "period" VARCHAR(6) NOT NULL,
    "fixture_set_version" VARCHAR(40),
    "file_name" VARCHAR(255) NOT NULL,
    "file_size_bytes" INTEGER NOT NULL,
    "file_hash" VARCHAR(64) NOT NULL,
    "row_count" INTEGER NOT NULL,
    "status" "SireDemoProposalStatus" NOT NULL DEFAULT 'IMPORTED',
    "created_by_user_id" UUID NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "discarded_at" TIMESTAMP(3),
    "discarded_by_user_id" UUID,

    CONSTRAINT "sire_demo_proposals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sire_demo_proposal_lines" (
    "id" UUID NOT NULL,
    "proposal_id" UUID NOT NULL,
    "line_number" INTEGER NOT NULL,
    "doc_type_code" VARCHAR(2) NOT NULL,
    "series" VARCHAR(20) NOT NULL,
    "number" VARCHAR(20) NOT NULL,
    "issue_date" DATE NOT NULL,
    "cp_doc_type_code" VARCHAR(1),
    "cp_doc_number" VARCHAR(20),
    "cp_name" VARCHAR(150),
    "currency_code" VARCHAR(3) NOT NULL,
    "taxable_base" DECIMAL(14,2) NOT NULL,
    "igv" DECIMAL(14,2) NOT NULL,
    "total" DECIMAL(14,2) NOT NULL,

    CONSTRAINT "sire_demo_proposal_lines_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "sire_demo_proposals_source_register_period_status_idx" ON "sire_demo_proposals"("source", "register", "period", "status");

-- CreateIndex
CREATE INDEX "sire_demo_proposals_created_at_idx" ON "sire_demo_proposals"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "sire_demo_proposal_lines_proposal_id_line_number_key" ON "sire_demo_proposal_lines"("proposal_id", "line_number");

-- AddForeignKey
ALTER TABLE "sire_demo_proposals" ADD CONSTRAINT "sire_demo_proposals_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sire_demo_proposals" ADD CONSTRAINT "sire_demo_proposals_discarded_by_user_id_fkey" FOREIGN KEY ("discarded_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sire_demo_proposal_lines" ADD CONSTRAINT "sire_demo_proposal_lines_proposal_id_fkey" FOREIGN KEY ("proposal_id") REFERENCES "sire_demo_proposals"("id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- Índice único PARCIAL (editado a mano): idempotencia de carga. Un mismo
-- archivo (SHA-256) no puede estar IMPORTED dos veces para el mismo
-- origen/registro/periodo; una propuesta DISCARDED no bloquea recargarlo.
CREATE UNIQUE INDEX "sire_demo_proposals_one_active_per_file"
  ON "sire_demo_proposals" ("source", "register", "period", "file_hash")
  WHERE "status" = 'IMPORTED';

-- CHECK constraints (editados a mano — el DSL de Prisma no los expresa)
ALTER TABLE "sire_demo_proposals"
  ADD CONSTRAINT "sire_demo_proposals_period_format"
  CHECK ("period" ~ '^[0-9]{4}(0[1-9]|1[0-2])$');

ALTER TABLE "sire_demo_proposals"
  ADD CONSTRAINT "sire_demo_proposals_file_hash_format"
  CHECK ("file_hash" ~ '^[0-9a-f]{64}$');

ALTER TABLE "sire_demo_proposals"
  ADD CONSTRAINT "sire_demo_proposals_file_size_range"
  CHECK ("file_size_bytes" BETWEEN 1 AND 2097152);

ALTER TABLE "sire_demo_proposals"
  ADD CONSTRAINT "sire_demo_proposals_row_count_range"
  CHECK ("row_count" BETWEEN 1 AND 5000);

-- La versión de fixtures existe si y solo si el origen es DEMO_FIXTURES.
ALTER TABLE "sire_demo_proposals"
  ADD CONSTRAINT "sire_demo_proposals_fixture_version_consistency"
  CHECK (
    ("source" = 'DEMO_FIXTURES' AND "fixture_set_version" IS NOT NULL AND BTRIM("fixture_set_version") <> '')
    OR
    ("source" = 'POS' AND "fixture_set_version" IS NULL)
  );

-- DISCARDED siempre trae fecha y usuario de descarte; IMPORTED nunca.
ALTER TABLE "sire_demo_proposals"
  ADD CONSTRAINT "sire_demo_proposals_discard_consistency"
  CHECK (
    ("status" = 'DISCARDED' AND "discarded_at" IS NOT NULL AND "discarded_by_user_id" IS NOT NULL)
    OR
    ("status" = 'IMPORTED' AND "discarded_at" IS NULL AND "discarded_by_user_id" IS NULL)
  );

ALTER TABLE "sire_demo_proposal_lines"
  ADD CONSTRAINT "sire_demo_proposal_lines_line_number_positive"
  CHECK ("line_number" >= 1);

ALTER TABLE "sire_demo_proposal_lines"
  ADD CONSTRAINT "sire_demo_proposal_lines_amounts_non_negative"
  CHECK ("taxable_base" >= 0 AND "igv" >= 0 AND "total" >= 0);

-- El par tipo+número de la contraparte viaja completo o no viaja.
ALTER TABLE "sire_demo_proposal_lines"
  ADD CONSTRAINT "sire_demo_proposal_lines_counterparty_pair"
  CHECK (("cp_doc_type_code" IS NULL) = ("cp_doc_number" IS NULL));
