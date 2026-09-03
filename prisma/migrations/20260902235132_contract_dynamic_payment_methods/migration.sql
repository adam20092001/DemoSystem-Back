-- Ticket C post-MVP, Bloque C3 (CONTRACT) ------------------------------------
--
-- Migración DESTRUCTIVA respecto de la aplicación publicada anterior: elimina
-- payments.method y el enum PaymentMethod. NO es compatible con el código
-- previo al Bloque C3 (a diferencia de la migración EXPAND del Bloque C1).
-- Modelo de despliegue aprobado: detener la aplicación anterior -> aplicar
-- esta migración -> desplegar/arrancar la aplicación del Bloque C3 -> validar
-- -> reanudar tráfico. Un despliegue de cero-downtime requeriría una etapa
-- expand/contract adicional, fuera de alcance de este MVP/demo.
--
-- Orden seguro de esta migración (mismo patrón que
-- 20260825230114_add_user_roles/migration.sql: backfill -> aserción DO $$ ...
-- RAISE EXCEPTION dentro de la propia transacción de migración -> recién
-- entonces los DROP/NOT NULL destructivos):
--   1. Backfill DETERMINISTA #2: cualquier Payment creado por la aplicación
--      ANTERIOR durante la ventana de compatibilidad EXPAND (después de la
--      migración 12, antes de esta) pudo quedar con payment_method_id/code/
--      name/affects_cash_drawer en NULL — ese código antiguo no sabía que
--      esas columnas existían. Mismo mapeo 1:1 method::text = code que el
--      backfill original del Bloque C1: NUNCA se remapea un valor legado a
--      otro distinto.
--   2. Aserción de integridad DENTRO de la propia migración: si CUALQUIER
--      Payment queda sin las 4 columnas pobladas tras el backfill #2, la
--      migración completa aborta (ROLLBACK automático) ANTES de llegar a
--      cualquier DROP/NOT NULL. Nunca se mapea a OTHER, nunca se inventa un
--      valor de emergencia.
--   3. Solo tras la aserción: las 4 columnas de snapshot/FK pasan a
--      NOT NULL.
--   4. Se elimina el CHECK histórico basado en el enum
--      (payments_reference_required_by_method): la regla ya es dinámica y
--      cross-table (PaymentMethod.requiresReference), y no puede expresarse
--      de forma veraz como CHECK de una sola tabla — se valida en
--      PaymentEngine, dentro de la misma transacción de creación del pago.
--   5. Se elimina payments.method (columna) y luego el tipo enum
--      PaymentMethod (Postgres exige que ninguna columna lo use ya).
--   6. Índice nuevo, evidenciado por dos sitios de consulta reales ya
--      existentes que filtran por método + ordenan por paid_at
--      (PaymentsService.list, ReportsService.paymentsByMethod/R9): mismo
--      criterio que los índices (status, paid_at) y
--      (created_by_user_id, paid_at) ya existentes en esta tabla desde la
--      Fase 7.
--
-- Los 9 valores baseline de payment_methods (Bloque C1) y cualquier
-- personalización de ADMIN ya aplicada (Bloque C2) NO se tocan: esta
-- migración nunca hace INSERT/UPDATE/DELETE sobre payment_methods, solo LEE
-- de ella para el backfill #2.

-- Backfill determinista #2 (ventana de compatibilidad EXPAND, Bloques C1/C2).
-- Guard "payment_method_id IS NULL": nunca sobrescribe una fila que ya
-- tuviera su snapshot poblado (p. ej. por el backfill original del Bloque
-- C1, o por una futura escritura dinámica real si esta migración se
-- reejecutara sobre una base ya parcialmente migrada).
UPDATE "payments" AS p
SET
  "payment_method_id" = pm."id",
  "payment_method_code" = pm."code",
  "payment_method_name" = pm."name",
  "payment_method_affects_cash_drawer" = pm."affects_cash_drawer"
FROM "payment_methods" AS pm
WHERE pm."code" = p."method"::text
  AND p."payment_method_id" IS NULL;

-- Aserción de integridad DENTRO de la propia migración (no una consulta
-- manual posterior entre pasos de despliegue): si algún Payment existente
-- queda con cualquiera de las 4 columnas en NULL tras los dos backfills
-- (el original del Bloque C1 + el de arriba), la migración entera aborta
-- ANTES de llegar a los DROP/NOT NULL destructivos de más abajo. Nunca se
-- mapea a OTHER, nunca se elige un valor de emergencia, nunca se continúa
-- de todos modos.
DO $$
DECLARE
  unmapped_count INTEGER;
BEGIN
  SELECT COUNT(*) INTO unmapped_count
  FROM "payments"
  WHERE "payment_method_id" IS NULL
     OR "payment_method_code" IS NULL
     OR "payment_method_name" IS NULL
     OR "payment_method_affects_cash_drawer" IS NULL;

  IF unmapped_count > 0 THEN
    RAISE EXCEPTION 'Ticket C, Bloque C3: backfill de payment_method_* incompleto: % Payment(s) sin mapeo dinámico tras los dos backfills. Migración abortada; ningún dato existente fue alterado.', unmapped_count;
  END IF;
END $$;

-- Solo tras la aserción anterior: las 4 columnas de snapshot/FK son
-- obligatorias para todo Payment desde este momento en adelante.
ALTER TABLE "payments"
  ALTER COLUMN "payment_method_id" SET NOT NULL,
  ALTER COLUMN "payment_method_code" SET NOT NULL,
  ALTER COLUMN "payment_method_name" SET NOT NULL,
  ALTER COLUMN "payment_method_affects_cash_drawer" SET NOT NULL;

-- CHECK histórico basado en el enum: la regla de referencia obligatoria ya
-- es dinámica (PaymentMethod.requiresReference), nunca expresable como
-- CHECK de una sola tabla. Los otros 3 CHECK de payments (monto positivo,
-- referencia no vacía, consistencia de anulación) NO se tocan.
ALTER TABLE "payments" DROP CONSTRAINT "payments_reference_required_by_method";

-- Columna/enum heredados: ya no queda ninguna dependencia (el CHECK que lo
-- usaba se eliminó arriba).
ALTER TABLE "payments" DROP COLUMN "method";

DROP TYPE "PaymentMethod";

-- Índice nuevo, evidenciado (ver comentario de cabecera).
CREATE INDEX "payments_payment_method_code_paid_at_id_idx" ON "payments"("payment_method_code", "paid_at", "id");
