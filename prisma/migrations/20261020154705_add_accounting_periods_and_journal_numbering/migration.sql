-- Fase A2.1/A2.2/A2.3 (periodos contables, fecha contable y numeración
-- secuencial de asientos). Migración 100% aditiva, editada a mano (mismo
-- criterio que la migración de la Fase A1): ninguna columna/tabla
-- existente se elimina ni se reescribe. accounting_date/period_id/
-- journal_number nacen NULLABLE, se completan mediante un backfill
-- determinista (pasos 1-5 abajo) y solo entonces se vuelven NOT NULL —
-- nunca se asume que una base con 0 asientos históricos (como esta base de
-- desarrollo/pruebas en este momento) representa el caso general de una
-- base ya poblada con historial financiero real.

-- CreateEnum
CREATE TYPE "AccountingPeriodStatus" AS ENUM ('OPEN', 'CLOSED');

-- CreateTable
CREATE TABLE "accounting_periods" (
    "id" UUID NOT NULL,
    "year" INTEGER NOT NULL,
    "month" INTEGER NOT NULL,
    "status" "AccountingPeriodStatus" NOT NULL DEFAULT 'OPEN',
    "last_journal_number" INTEGER NOT NULL DEFAULT 0,
    "closed_at" TIMESTAMP(3),
    "closed_by_user_id" UUID,
    "reopened_at" TIMESTAMP(3),
    "reopened_by_user_id" UUID,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "accounting_periods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "accounting_periods_status_idx" ON "accounting_periods"("status");

-- CreateIndex (necesario ANTES del backfill: el INSERT de abajo usa
-- ON CONFLICT ("year", "month"))
CREATE UNIQUE INDEX "accounting_periods_year_month_key" ON "accounting_periods"("year", "month");

-- Nota manual (Fase A2): el DSL de Prisma no expresa CHECK de forma
-- declarativa (mismo criterio que accounting_entries/chart_of_accounts en
-- migraciones previas).
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_month_valid" CHECK ("month" >= 1 AND "month" <= 12);

-- AlterTable: columnas nuevas NULLABLE por ahora; el backfill de abajo las
-- completa antes de que se vuelvan NOT NULL (paso 6).
ALTER TABLE "accounting_entries" ADD COLUMN "accounting_date" DATE,
ADD COLUMN "journal_number" INTEGER,
ADD COLUMN "period_id" UUID;

-- ============================================================
-- Backfill determinista (Fase A2.5) — corre UNA SOLA VEZ, dentro de esta
-- migración. No-op exacto si "accounting_entries" está vacía (caso actual
-- de pos_db/pos_db_test), pero escrito para ser correcto también contra
-- historial real: no es idempotente y no debe reejecutarse fuera del
-- flujo normal de `prisma migrate deploy`.
-- ============================================================

-- 1) Fecha contable de cada asiento histórico, derivada de su posted_at ya
--    persistido (nunca inventada): posted_at se almacena como instante UTC
--    (TIMESTAMP(3) sin zona, convención de toda la aplicación), así que se
--    reinterpreta explícitamente como UTC y se convierte a la fecha
--    calendario en America/Lima (zona de negocio única del MVP, UTC-5 fijo
--    todo el año, sin horario de verano — mismo criterio exacto que
--    common/date/business-date.ts). Un asiento REVERSAL histórico recibe
--    la fecha contable de SU PROPIO posted_at, nunca la del ORIGINAL que
--    revierte: esta misma expresión ya respeta esa regla porque corre fila
--    por fila sobre posted_at, no sobre reverses_entry_id.
UPDATE "accounting_entries"
SET "accounting_date" = (("posted_at" AT TIME ZONE 'UTC') AT TIME ZONE 'America/Lima')::date;

-- 2) Un periodo OPEN por cada (year, month) distinto ya presente en el
--    historial, si todavía no existe. OPEN (nunca CLOSED automáticamente):
--    cerrar un periodo histórico es una decisión de negocio explícita de
--    ADMIN, no algo que esta migración deba asumir por sí misma (ver
--    reporte final, decisiones pendientes de contador/negocio).
INSERT INTO "accounting_periods" ("id", "year", "month", "status", "last_journal_number", "created_at", "updated_at")
SELECT
  gen_random_uuid(),
  EXTRACT(YEAR FROM "accounting_date")::int,
  EXTRACT(MONTH FROM "accounting_date")::int,
  'OPEN',
  0,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "accounting_entries"
WHERE "accounting_date" IS NOT NULL
GROUP BY EXTRACT(YEAR FROM "accounting_date"), EXTRACT(MONTH FROM "accounting_date")
ON CONFLICT ("year", "month") DO NOTHING;

-- 3) Vincular cada asiento histórico a su periodo ya creado en el paso 2.
UPDATE "accounting_entries" e
SET "period_id" = p."id"
FROM "accounting_periods" p
WHERE e."accounting_date" IS NOT NULL
  AND p."year" = EXTRACT(YEAR FROM e."accounting_date")::int
  AND p."month" = EXTRACT(MONTH FROM e."accounting_date")::int;

-- 4) Numeración secuencial determinista POR periodo: mismo criterio de
--    desempate ya usado en el resto del dominio para ordenar eventos
--    financieros del mismo instante (posted_at ASC, id ASC — ver
--    PaymentEngine.cancelAllActiveForSale). Un asiento ORIGINAL y su
--    REVERSAL nunca comparten period_id si cayeron en meses distintos, así
--    que cada uno recibe su propio número dentro de su propio periodo sin
--    ambigüedad.
WITH numbered AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "period_id"
      ORDER BY "posted_at" ASC, "id" ASC
    ) AS "rn"
  FROM "accounting_entries"
  WHERE "period_id" IS NOT NULL
)
UPDATE "accounting_entries" e
SET "journal_number" = numbered."rn"
FROM numbered
WHERE e."id" = numbered."id";

-- 5) Avanzar el contador de cada periodo hasta el último número asignado
--    por el backfill, para que AccountingEngine (nuevos asientos, a partir
--    de ahora) continúe la secuencia sin colisionar nunca con un número ya
--    asignado por este backfill.
UPDATE "accounting_periods" p
SET "last_journal_number" = sub."max_number"
FROM (
  SELECT "period_id", MAX("journal_number") AS "max_number"
  FROM "accounting_entries"
  WHERE "period_id" IS NOT NULL
  GROUP BY "period_id"
) sub
WHERE p."id" = sub."period_id";

-- 6) Todo asiento histórico (si existía alguno) ya tiene sus tres columnas
--    completas: se vuelven obligatorias.
ALTER TABLE "accounting_entries" ALTER COLUMN "accounting_date" SET NOT NULL;
ALTER TABLE "accounting_entries" ALTER COLUMN "period_id" SET NOT NULL;
ALTER TABLE "accounting_entries" ALTER COLUMN "journal_number" SET NOT NULL;

-- CreateIndex
CREATE INDEX "accounting_entries_accounting_date_idx" ON "accounting_entries"("accounting_date");

-- CreateIndex (journal_number único POR periodo, nunca global)
CREATE UNIQUE INDEX "accounting_entries_period_id_journal_number_key" ON "accounting_entries"("period_id", "journal_number");

-- AddForeignKey
ALTER TABLE "accounting_entries" ADD CONSTRAINT "accounting_entries_period_id_fkey" FOREIGN KEY ("period_id") REFERENCES "accounting_periods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_closed_by_user_id_fkey" FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "accounting_periods" ADD CONSTRAINT "accounting_periods_reopened_by_user_id_fkey" FOREIGN KEY ("reopened_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
