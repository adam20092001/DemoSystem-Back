-- Ticket C post-MVP, Bloque C1 (EXPAND) -------------------------------------
--
-- Migración puramente ADITIVA: la aplicación actualmente publicada (v1.0.0-mvp
-- + Ticket A) depende de PaymentMethod (enum) y de Payment.method, y sigue
-- dependiendo de ellos exactamente igual después de esta migración. Nada de
-- lo existente se elimina, renombra ni se vuelve NOT NULL en este bloque.
--
-- Orden de esta migración:
--   1. Enum PaymentMethodAccountingDestination (nuevo, sin relación con el
--      enum PaymentMethod existente).
--   2. Columnas de compatibilidad NULLABLE en payments (payment_method_id/
--      code/name/affects_cash_drawer) — la aplicación publicada nunca las
--      escribe; por eso deben admitir NULL.
--   3. Tabla payment_methods (modelo Prisma temporal PaymentMethodDefinition,
--      ver comentario en schema.prisma) + sus 3 CHECK.
--   4. FK payments.payment_method_id -> payment_methods.id (ON DELETE
--      RESTRICT: un método nunca se borra físicamente).
--   5. Filas baseline (9): 5 activas + 4 legacy inactivas, mapeo 1:1 no
--      destructivo con los 6 valores del enum PaymentMethod existente
--      (BANK_TRANSFER/BANK_DEPOSIT/DIGITAL_WALLET/OTHER se preservan tal
--      cual, nunca consolidados en TRANSFER/YAPE/PLIN). UUIDs fijos y
--      explícitos (sin pgcrypto/uuid-ossp): la aplicación/seed normal
--      SIEMPRE resuelve estas filas por `code`, nunca por este UUID literal.
--   6. Backfill determinista de TODO Payment ya existente al momento de
--      aplicar esta migración, por code = method::text. Los 3 primeros
--      pasos garantizan que el mapeo 1:1 exista para los 6 valores posibles
--      del enum antes de este UPDATE.
--
-- Las columnas de compatibilidad de payments permanecen NULLABLE al cerrar
-- este bloque: una fila creada por la aplicación publicada DURANTE la
-- ventana de compatibilidad (después de esta migración, antes del bloque de
-- implementación que active PaymentEngine dinámico) queda con estas 4
-- columnas en NULL, exactamente como antes de esta migración. El futuro
-- Bloque de CONTRACT repetirá el backfill para esas filas y solo entonces
-- las volverá NOT NULL.

-- CreateEnum
CREATE TYPE "PaymentMethodAccountingDestination" AS ENUM ('CASH', 'BANK');

-- AlterTable: columnas de compatibilidad NULLABLE (Bloque C1, EXPAND).
ALTER TABLE "payments" ADD COLUMN     "payment_method_affects_cash_drawer" BOOLEAN,
ADD COLUMN     "payment_method_code" VARCHAR(30),
ADD COLUMN     "payment_method_id" UUID,
ADD COLUMN     "payment_method_name" VARCHAR(60);

-- CreateTable
CREATE TABLE "payment_methods" (
    "id" UUID NOT NULL,
    "code" VARCHAR(30) NOT NULL,
    "name" VARCHAR(60) NOT NULL,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "requires_reference" BOOLEAN NOT NULL,
    "affects_cash_drawer" BOOLEAN NOT NULL,
    "accounting_destination" "PaymentMethodAccountingDestination" NOT NULL,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "payment_methods_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "payment_methods_code_key" ON "payment_methods"("code");

-- AddForeignKey
ALTER TABLE "payments" ADD CONSTRAINT "payments_payment_method_id_fkey" FOREIGN KEY ("payment_method_id") REFERENCES "payment_methods"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- Restricciones manuales (Bloque C1) -----------------------------------------
-- El DSL de Prisma no expresa CHECK; se agregan a mano, mismo criterio que
-- el resto del dominio (Category/Unit/Product/Sale/Payment/...). Conteo: 3.

-- 1. Identidad estable: 2-30 caracteres, primer carácter A-Z, resto
--    A-Z/0-9/guion bajo. Nunca se deriva de `name` (política aprobada,
--    Ticket C §14 del audit): se valida aquí igual que en la aplicación
--    futura (Bloque C2), nunca solo en la capa HTTP.
ALTER TABLE "payment_methods"
  ADD CONSTRAINT "payment_methods_code_format"
  CHECK ("code" ~ '^[A-Z][A-Z0-9_]{1,29}$');

-- 2. Nombre visible nunca en blanco.
ALTER TABLE "payment_methods"
  ADD CONSTRAINT "payment_methods_name_not_blank"
  CHECK (BTRIM("name") <> '');

-- 3. Orden de presentación nunca negativo.
ALTER TABLE "payment_methods"
  ADD CONSTRAINT "payment_methods_sort_order_non_negative"
  CHECK ("sort_order" >= 0);

-- Filas baseline (Bloque C1, §8/§9 del plan aprobado) ------------------------
-- UUID fijos y explícitos, nunca generados (sin pgcrypto/uuid-ossp): la
-- aplicación/seed normal resuelve SIEMPRE por `code`, jamás por este literal.
-- ON CONFLICT (code) DO NOTHING: reejecutar esta migración (p. ej. en un
-- entorno donde `prisma migrate resolve` la marcara aplicada dos veces por
-- error operativo) nunca duplica ni resetea filas ya existentes.
--
-- 5 ACTIVAS (Ticket C §11/§16/§17/§18 del audit, defaults aprobados):
INSERT INTO "payment_methods"
  ("id", "code", "name", "active", "requires_reference", "affects_cash_drawer", "accounting_destination", "sort_order", "updated_at")
VALUES
  ('a0000000-0000-4000-8000-000000000001', 'CASH',     'Efectivo',      true,  false, true,  'CASH', 10, CURRENT_TIMESTAMP),
  ('a0000000-0000-4000-8000-000000000002', 'CARD',     'Tarjeta',       true,  true,  false, 'BANK', 20, CURRENT_TIMESTAMP),
  ('a0000000-0000-4000-8000-000000000003', 'TRANSFER', 'Transferencia', true,  true,  false, 'BANK', 30, CURRENT_TIMESTAMP),
  ('a0000000-0000-4000-8000-000000000004', 'YAPE',     'Yape',          true,  true,  false, 'BANK', 40, CURRENT_TIMESTAMP),
  ('a0000000-0000-4000-8000-000000000005', 'PLIN',     'Plin',          true,  true,  false, 'BANK', 50, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- 4 LEGACY INACTIVAS: mapeo 1:1 no destructivo con los 4 valores del enum
-- PaymentMethod existente que NO se conservan como método activo hoy mismo
-- (CASH/CARD sí se conservan arriba, con el MISMO code). Nunca se
-- consolidan entre sí ni se renombran a TRANSFER/YAPE/PLIN (Ticket C §9 del
-- audit, decisión cerrada de no-pérdida histórica).
INSERT INTO "payment_methods"
  ("id", "code", "name", "active", "requires_reference", "affects_cash_drawer", "accounting_destination", "sort_order", "updated_at")
VALUES
  ('a0000000-0000-4000-8000-000000000006', 'BANK_TRANSFER',  'Transferencia bancaria (legacy)', false, true,  false, 'BANK', 900, CURRENT_TIMESTAMP),
  ('a0000000-0000-4000-8000-000000000007', 'BANK_DEPOSIT',   'Depósito bancario (legacy)',      false, true,  false, 'BANK', 901, CURRENT_TIMESTAMP),
  ('a0000000-0000-4000-8000-000000000008', 'DIGITAL_WALLET', 'Billetera digital (legacy)',       false, false, false, 'BANK', 902, CURRENT_TIMESTAMP),
  ('a0000000-0000-4000-8000-000000000009', 'OTHER',          'Otro (legacy)',                    false, false, false, 'BANK', 903, CURRENT_TIMESTAMP)
ON CONFLICT ("code") DO NOTHING;

-- Backfill determinista de Payment existente (Bloque C1 §14 del audit) ------
-- Mapeo 1:1 method::text = payment_methods.code, garantizado por las 9 filas
-- baseline insertadas arriba (los 6 valores posibles del enum PaymentMethod
-- tienen, cada uno, una fila baseline con code idéntico). Guard
-- "payment_method_id IS NULL" defensivo (toda fila preexistente a esta
-- migración cumple esa condición por definición); nunca sobrescribe una
-- fila que ya tuviera estas columnas pobladas.
UPDATE "payments" AS p
SET
  "payment_method_id" = pm."id",
  "payment_method_code" = pm."code",
  "payment_method_name" = pm."name",
  "payment_method_affects_cash_drawer" = pm."affects_cash_drawer"
FROM "payment_methods" AS pm
WHERE pm."code" = p."method"::text
  AND p."payment_method_id" IS NULL;
