-- NR-02A (crédito opcional configurable por cliente) ------------------------
--
-- Migración puramente ADITIVA: agrega `credit_enabled` a customers para que
-- ADMIN pueda habilitar/deshabilitar, por cliente identificado, si una venta
-- puede quedar con saldo pendiente (SalesService.assertCustomerDebtRules()).
-- Sin límite monetario ni vencimiento/plazo de pago: fuera de alcance de
-- NR-02A.
--
-- Ningún importe, estado, saldo, asiento contable, CHECK, FK, índice ni
-- columna existente se modifica. Ninguna deuda histórica se recalcula ni se
-- reinterpreta.
--
-- Patrón (mismo criterio que R2-B1, 20261012020000_add_prices_include_tax_
-- snapshot, salvo que aquí el DEFAULT SÍ se conserva al final — ver punto 3):
--   1. ADD COLUMN ... NOT NULL DEFAULT false: toda fila existente (incluido
--      el cliente genérico "Público general") recibe false en la misma
--      sentencia.
--   2. UPDATE explícito: todo cliente NO genérico ya existente pasa a true,
--      para preservar exactamente el comportamiento de crédito ya vigente
--      hoy (cualquier cliente identificado ACTIVE ya podía generar saldo
--      pendiente sin ninguna restricción de este tipo) — el cliente
--      genérico se queda en false (irrelevante en la práctica:
--      assertCustomerDebtRules ya lo bloquea de forma incondicional por
--      `is_generic`, nunca por este campo).
--   3. Verificación explícita del backfill.
--   4. El DEFAULT false se CONSERVA (nunca DROP DEFAULT): a diferencia de
--      R2-B1, aquí sí queremos que todo cliente NUEVO creado después de
--      esta migración nazca con crédito deshabilitado por defecto —
--      CustomersService.create() no fija este campo explícitamente, así
--      que el DEFAULT de PostgreSQL decide, sin depender de que ningún
--      código de aplicación lo recuerde.

-- 1. Columna con relleno inicial false para toda fila existente.
ALTER TABLE "customers"
  ADD COLUMN "credit_enabled" BOOLEAN NOT NULL DEFAULT false;

-- 2. Backfill explícito: preserva el crédito ya vigente para todo cliente
--    identificado (no genérico) que ya existía antes de esta migración.
UPDATE "customers"
  SET "credit_enabled" = true
  WHERE "is_generic" = false;

-- 3. Verificación: ningún cliente no genérico debe quedar sin crédito tras
--    el backfill, y el genérico debe permanecer en false.
DO $$
DECLARE
  non_generic_without_credit INTEGER;
  generic_with_credit INTEGER;
BEGIN
  SELECT COUNT(*) INTO non_generic_without_credit
    FROM "customers" WHERE "is_generic" = false AND "credit_enabled" = false;
  SELECT COUNT(*) INTO generic_with_credit
    FROM "customers" WHERE "is_generic" = true AND "credit_enabled" = true;

  IF non_generic_without_credit > 0 OR generic_with_credit > 0 THEN
    RAISE EXCEPTION
      'NR-02A: backfill de credit_enabled incompleto (no_genericos_sin_credito=%, genericos_con_credito=%)',
      non_generic_without_credit, generic_with_credit;
  END IF;
END $$;

-- 4. El DEFAULT false se conserva deliberadamente: ver nota en el
--    encabezado. Ningún ALTER COLUMN ... DROP DEFAULT en esta migración.
