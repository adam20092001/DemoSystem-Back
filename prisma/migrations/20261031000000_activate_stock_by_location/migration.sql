-- R2-ACT: activación del inventario por ubicación.
--
-- Qué hace (en UNA transacción explícita):
--   1. Verifica precondiciones (falla cerrada con RAISE EXCEPTION).
--   2. Bloquea las tablas de stock (SHARE ROW EXCLUSIVE) mientras migra, para
--      que un backend antiguo en ejecución espere y luego falle cerrado.
--   3. Backfill: un saldo MAIN/DEFAULT por cada producto con stock_current > 0
--      (cantidad idéntica, Decimal(14,3)). Productos con stock 0 NO reciben
--      fila: "sin fila" equivale a saldo 0.
--   4. Verifica la conciliación (por producto y global) ANTES del COMMIT.
--   5. Instala la protección PERMANENTE de la invariante
--      products.stock_current = SUM(stock_balances.quantity): una función y
--      cinco CONSTRAINT TRIGGER diferidos al COMMIT.
--   6. Agrega CHECK (location_id IS NOT NULL) NOT VALID en inventory_movements:
--      los movimientos NUEVOS siempre llevan ubicación; los históricos (NULL)
--      no se validan ni se modifican.
--
-- Qué NO hace: no cambia products.stock_current, costos, valorización ni
-- COGS; no reescribe movimientos históricos; no cambia ninguna tabla salvo
-- stock_balances (datos) y la restricción de inventory_movements.
--
-- ORDEN DE DESPLIEGUE: aplicar ESTA migración ANTES de poner en marcha el
-- backend R2-ACT. Un backend anterior que escriba stock después de aplicada
-- falla cerrado (el trigger rechaza el COMMIT y el CHECK rechaza el
-- movimiento sin ubicación); un backend R2-ACT contra una base sin migrar
-- rechazaría salidas por falta de saldo por ubicación. Ver docs/r2-migration-plan.md.
--
-- LÍMITES CONOCIDOS de los triggers (se mitigan con privilegios, no aquí):
-- session_replication_role = replica, ALTER TABLE ... DISABLE TRIGGER y
-- TRUNCATE los eluden; requieren privilegios elevados.
--
-- No hay migración "down": revertir una base ya migrada es restaurar el
-- respaldo previo (mismo criterio que el resto del repositorio).
BEGIN;

-- 1. Precondiciones
DO $$
DECLARE
  v_loc uuid;
BEGIN
  SELECT l.id INTO v_loc
  FROM warehouses w
  JOIN warehouse_locations l ON l.warehouse_id = w.id
  WHERE w.code = 'MAIN' AND w.is_default AND w.status = 'ACTIVE'
    AND l.code = 'DEFAULT' AND l.is_default AND l.status = 'ACTIVE';
  IF v_loc IS NULL THEN
    RAISE EXCEPTION 'R2-ACT: MAIN/DEFAULT ausente, inactivo o mal marcado';
  END IF;
  IF EXISTS (SELECT 1 FROM stock_balances) THEN
    RAISE EXCEPTION 'R2-ACT: stock_balances no esta vacia';
  END IF;
  IF EXISTS (SELECT 1 FROM products WHERE stock_current < 0) THEN
    RAISE EXCEPTION 'R2-ACT: hay productos con stock negativo';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE location_id IS NOT NULL) THEN
    RAISE EXCEPTION 'R2-ACT: ya existen movimientos con ubicacion';
  END IF;
  IF EXISTS (SELECT 1 FROM sale_items WHERE location_id IS NOT NULL)
     OR EXISTS (SELECT 1 FROM purchase_receipt_lines WHERE location_id IS NOT NULL) THEN
    RAISE EXCEPTION 'R2-ACT: ya existen lineas de venta o recepcion con ubicacion';
  END IF;
END $$;

-- 2. Bloqueo de escritores durante la migración (defensa en profundidad)
LOCK TABLE products, stock_balances, inventory_movements IN SHARE ROW EXCLUSIVE MODE;

-- 3. Foto previa para la conciliación
CREATE TEMP TABLE r2act_before ON COMMIT DROP AS
SELECT
  (SELECT count(*) FROM products)                                 AS products_n,
  (SELECT COALESCE(sum(stock_current), 0) FROM products)          AS stock_sum,
  (SELECT count(*) FROM inventory_movements)                      AS movements_n,
  (SELECT COALESCE(sum(total_cost), 0) FROM inventory_valuations) AS valuation_sum;

-- 4. Backfill: productos con stock > 0 -> MAIN/DEFAULT (ausente = 0)
INSERT INTO stock_balances (id, product_id, location_id, quantity, updated_at)
SELECT gen_random_uuid(), p.id, d.id, p.stock_current, now()
FROM products p
CROSS JOIN (
  SELECT l.id
  FROM warehouses w
  JOIN warehouse_locations l ON l.warehouse_id = w.id
  WHERE w.code = 'MAIN' AND w.is_default AND l.code = 'DEFAULT' AND l.is_default
) d
WHERE p.stock_current > 0;

-- 5. Conciliación del backfill (aborta si algo no cuadra)
DO $$
DECLARE
  b record;
  v_bal numeric;
  v_prod numeric;
BEGIN
  IF EXISTS (
    SELECT 1 FROM products p
    WHERE p.stock_current <> COALESCE(
      (SELECT SUM(s.quantity) FROM stock_balances s WHERE s.product_id = p.id), 0)
  ) THEN
    RAISE EXCEPTION 'R2-ACT: algun producto no concilia con sus saldos';
  END IF;
  IF EXISTS (
    SELECT 1 FROM stock_balances s
    JOIN warehouse_locations l ON l.id = s.location_id
    JOIN warehouses w ON w.id = l.warehouse_id
    WHERE NOT (w.code = 'MAIN' AND l.code = 'DEFAULT')
  ) THEN
    RAISE EXCEPTION 'R2-ACT: un saldo inicial no pertenece a MAIN/DEFAULT';
  END IF;
  SELECT * INTO b FROM r2act_before;
  SELECT COALESCE(sum(quantity), 0) INTO v_bal FROM stock_balances;
  SELECT COALESCE(sum(stock_current), 0) INTO v_prod FROM products;
  IF v_bal <> b.stock_sum OR v_prod <> b.stock_sum THEN
    RAISE EXCEPTION 'R2-ACT: la suma total de stock cambio';
  END IF;
  IF (SELECT count(*) FROM products) <> b.products_n THEN
    RAISE EXCEPTION 'R2-ACT: cambio el conteo de productos';
  END IF;
  IF (SELECT count(*) FROM inventory_movements) <> b.movements_n THEN
    RAISE EXCEPTION 'R2-ACT: cambio el conteo de movimientos';
  END IF;
  IF (SELECT COALESCE(sum(total_cost), 0) FROM inventory_valuations) <> b.valuation_sum THEN
    RAISE EXCEPTION 'R2-ACT: cambio la suma de valorizacion';
  END IF;
  IF EXISTS (SELECT 1 FROM inventory_movements WHERE location_id IS NOT NULL) THEN
    RAISE EXCEPTION 'R2-ACT: un movimiento historico recibio ubicacion';
  END IF;
END $$;

-- 6. Función y triggers diferidos: protección PERMANENTE de la invariante.
-- Comprueba CADA producto afectado (en UPDATE de un saldo con cambio de
-- product_id, tanto OLD como NEW). Diferidos al COMMIT: dentro de la
-- transacción el estado intermedio puede ser incoherente.
CREATE FUNCTION r2_assert_product_stock_matches_balances() RETURNS trigger
LANGUAGE plpgsql AS $fn$
DECLARE
  pids    uuid[];
  pid     uuid;
  v_stock numeric;
  v_sum   numeric;
BEGIN
  IF TG_TABLE_NAME = 'products' THEN
    pids := ARRAY[NEW.id];
  ELSIF TG_OP = 'INSERT' THEN
    pids := ARRAY[NEW.product_id];
  ELSIF TG_OP = 'DELETE' THEN
    pids := ARRAY[OLD.product_id];
  ELSE
    pids := ARRAY[OLD.product_id, NEW.product_id];
  END IF;

  FOR pid IN SELECT DISTINCT unnest(pids) LOOP
    SELECT stock_current INTO v_stock FROM products WHERE id = pid;
    IF NOT FOUND THEN
      CONTINUE;
    END IF;
    SELECT COALESCE(SUM(quantity), 0) INTO v_sum FROM stock_balances WHERE product_id = pid;
    IF v_stock <> v_sum THEN
      RAISE EXCEPTION 'R2-ACT: stock consolidado (%) <> suma de saldos por ubicacion (%) del producto %',
        v_stock, v_sum, pid
        USING ERRCODE = 'check_violation';
    END IF;
  END LOOP;
  RETURN NULL;
END
$fn$;

CREATE CONSTRAINT TRIGGER r2_stock_check_products_ins
  AFTER INSERT ON products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (NEW.stock_current <> 0)
  EXECUTE FUNCTION r2_assert_product_stock_matches_balances();

CREATE CONSTRAINT TRIGGER r2_stock_check_products_upd
  AFTER UPDATE OF stock_current ON products
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.stock_current IS DISTINCT FROM NEW.stock_current)
  EXECUTE FUNCTION r2_assert_product_stock_matches_balances();

CREATE CONSTRAINT TRIGGER r2_stock_check_balances_ins
  AFTER INSERT ON stock_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION r2_assert_product_stock_matches_balances();

CREATE CONSTRAINT TRIGGER r2_stock_check_balances_upd
  AFTER UPDATE ON stock_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW WHEN (OLD.quantity IS DISTINCT FROM NEW.quantity OR OLD.product_id IS DISTINCT FROM NEW.product_id)
  EXECUTE FUNCTION r2_assert_product_stock_matches_balances();

CREATE CONSTRAINT TRIGGER r2_stock_check_balances_del
  AFTER DELETE ON stock_balances
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION r2_assert_product_stock_matches_balances();

-- 7. Movimientos NUEVOS siempre con ubicación; los históricos (NULL) no se
-- validan. VALIDATE CONSTRAINT fallará mientras existan históricos con NULL.
ALTER TABLE inventory_movements
  ADD CONSTRAINT inventory_movements_location_required_after_act
  CHECK (location_id IS NOT NULL) NOT VALID;

COMMIT;
