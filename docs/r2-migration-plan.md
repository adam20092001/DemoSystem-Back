# R2 — Stock por almacén y ubicación: plan de migración

Estado: **R2-A1 (EXPAND) implementado**, sin commit. Las etapas siguientes **no están iniciadas** ni autorizadas.
Contrato de API de lo ya implementado: [warehouses-locations-api.md](warehouses-locations-api.md).

## 1. Estrategia: EXPAND → ACTIVAR

R2 cambia la fuente de verdad del stock (de `Product.stockCurrent` consolidado a saldos por ubicación). Para poder
revisar y revertir cada paso, se separa en etapas:

| Etapa | Contenido | Estado |
|---|---|---|
| **R2-A1 — EXPAND** | Estructura aditiva (tablas y columnas nullable), catálogo de almacenes/ubicaciones, `MAIN`/`DEFAULT`. **Inerte** para el inventario. | **Implementado (esta rama)** |
| **R2-ACT** | Backfill de existencias a `MAIN/DEFAULT`, invariante `stockCurrent = Σ saldos`, motor por ubicación (`StockMovementEngine`), fixtures E2E. | No iniciado |
| **R2-B** | `locationId` opcional en inventario, recepciones y ventas; anulaciones; ubicaciones inactivas. | No iniciado |
| **R2-C** | Transferencias, consultas por ubicación, reconciliación. | No iniciado |

Cada etapa exige su propia autorización. R2-A1 no prepara ni activa nada de las siguientes más allá de la estructura.

## 2. Qué hizo R2-A1 (migración `20261030000000_add_warehouses_locations_expand`)

100 % aditiva; ninguna tabla/columna/tipo existente se modifica o elimina.

- Enum `WarehouseStatus` (`ACTIVE`/`INACTIVE`).
- Tablas `warehouses`, `warehouse_locations`, `stock_balances` (esta última **vacía**).
- Columnas **nullable** sin DEFAULT: `inventory_movements.location_id`, `location_previous_stock`,
  `location_new_stock`; `sale_items.location_id`; `purchase_receipt_lines.location_id` (FK `RESTRICT`, con índice).
- Restricciones manuales: códigos normalizados (`UPPER(BTRIM)`), nombres no vacíos, un solo almacén predeterminado
  (índice único parcial), una ubicación `DEFAULT` por almacén (índice único parcial + `(code='DEFAULT') = is_default`),
  `stock_balances.quantity >= 0`, y CHECK todo-o-nada sobre las columnas de ubicación del movimiento (inerte: todas NULL).
- Datos de **catálogo** (nunca cantidades): almacén `MAIN` ("Almacén principal", predeterminado) y su ubicación
  `DEFAULT`. Idempotente.

**Qué NO hace (deliberadamente):** no hay backfill ni filas en `stock_balances`; no hay triggers ni funciones; no hay
restricción que relacione `products.stock_current` con la suma de saldos; `StockMovementEngine`, ventas, recepciones,
valorización y COGS no cambian; ningún movimiento recibe ubicación.

### Atomicidad
El archivo `migration.sql` va envuelto en **una transacción explícita** (`BEGIN;` … `COMMIT;`). Todas sus sentencias son
compatibles con una transacción de PostgreSQL 16 (no hay `ALTER TYPE … ADD VALUE` usado en la misma transacción, ni
`CREATE INDEX CONCURRENTLY`, ni nada que PostgreSQL prohíba dentro de una transacción). Un error en cualquier punto
revierte todo el DDL y el catálogo `MAIN/DEFAULT`; Prisma registra la migración como fallida en `_prisma_migrations`
y, hasta resolverla con `prisma migrate resolve --rolled-back 20261030000000_add_warehouses_locations_expand`, bloquea
nuevos despliegues (P3009). Qué se verificó y qué no: ver §3, puntos 6 a 9.

### Reversión
Prisma no tiene migraciones "down". Una base ya migrada se recupera restaurando el respaldo previo. Como R2-A1 solo
agrega, el esquema anterior sigue siendo plenamente compatible con el código anterior (las columnas nuevas son
opcionales y ningún código previo las referencia).

## 3. Verificación realizada de R2-A1 (solo contra PostgreSQL 16 descartable)

1. Base **nueva**: las 33 migraciones se aplican; existen `MAIN` y su `DEFAULT`; `stock_balances` vacía; sin deriva
   (`prisma migrate diff` → "No difference detected").
2. Base **con datos**: se aplicó la migración sobre una base que ya tenía las 32 migraciones anteriores y datos de
   ejemplo. **Alcance real de esa prueba:** solo tenían filas **7 productos y 6 movimientos de inventario** (seed y datos
   demo; en la repetición de esta revisión, 2 productos y 3 movimientos insertados por SQL, más las filas que ya
   siembran las migraciones). Las tablas `inventory_valuations`, `sale_items` y `purchase_receipt_lines` tenían
   **0 filas**, por lo que **no se verificó la conservación de valorizaciones, líneas de venta ni líneas de recepción
   con datos existentes**. En la repetición se comparó además, tabla por tabla (47 tablas previas, conteo y hash del
   contenido, sin contar las columnas nuevas), el estado antes y después: idéntico, pero las tablas vacías solo
   prueban que siguen vacías. Como la migración únicamente agrega columnas nulas y tablas, no puede alterar esos
   datos; es una inferencia del diseño, no una cobertura ejecutada.
3. **Reaplicación** por el flujo normal: segundo `prisma migrate deploy` → "No pending migrations"; `migrate status` →
   "Database schema is up to date".
4. CHECK/índices verificados a nivel SQL: segundo almacén predeterminado, código sin normalizar o duplicado, segunda
   `DEFAULT`, `DEFAULT` mal marcada, ubicación huérfana, borrado en cascada, saldo negativo → todos rechazados.
5. Compatibilidad del backend con el esquema ampliado: suite E2E completa (54 suites) contra una base descartable
   nueva: **13 pruebas fallan en 6 suites** (`accounting-periods`, `configuration`, `electronic-invoicing`,
   `prices-include-tax-snapshot`, `sales-cogs`, `users-admin-concurrency`). Ejecutando `main` sin estos cambios, en las
   mismas condiciones (base nueva, caché de Jest limpia), fallan **las mismas 13** (mismos nombres y mensajes de
   error; una sola corrida por lado). Son una incidencia independiente, aún sin corregir; no se presenta la regresión
   como 100 % aprobada. Las 64 pruebas nuevas de `warehouses.e2e-spec.ts` pasan.
6. **Atomicidad (sin transacción explícita, archivo original):** copia temporal de la migración con un error inyectado
   al final y otra a mitad (tras crear tablas, índices y claves foráneas): en ambos casos PostgreSQL 16.15 con
   Prisma 6.19.3 revirtió **todo** (sin tablas, tipo, columnas, índices ni `MAIN/DEFAULT`); solo quedó la fila fallida
   en `_prisma_migrations`. Es decir, en esta versión Prisma ejecuta el archivo como una única transacción implícita.
   Es un comportamiento **observado**, no una garantía documentada de Prisma; por eso se agregó `BEGIN/COMMIT`.
7. **Atomicidad (con `BEGIN/COMMIT` explícito):** el mismo experimento con el archivo definitivo (fallo inyectado en
   copias temporales, antes del `COMMIT` y a mitad): rollback total, sin objetos ni datos de catálogo parciales y con
   las 47 tablas previas idénticas.
8. **Éxito con transacción explícita:** el archivo definitivo se aplica correctamente, queda `finished`, el segundo
   `migrate deploy` no tiene pendientes y `prisma migrate diff` no detecta deriva.
9. **Recuperación:** tras un fallo, `prisma migrate resolve --rolled-back` y un nuevo `migrate deploy` con el archivo
   correcto aplican la migración sin deriva.

Alcance de estas pruebas: una sola ejecución de cada escenario, sobre una instancia PostgreSQL 16.15 descartable con
una base de datos por escenario; no se probó con otras versiones de Prisma ni de PostgreSQL ni contra `pos_db`
o `pos_db_test` (intactas).

## 4. Verificaciones previas obligatorias antes de R2-ACT (sobre `pos_db`, solo lectura)

R2-ACT introducirá el backfill y la invariante; antes de aplicarlo en cualquier base con datos reales, el responsable
de despliegue debe ejecutar (solo lectura) y documentar:

1. Productos con `stock_current` ≠ `new_stock` del último movimiento (revisar uno por uno).
2. Productos con stock ≠ 0 **sin** ningún movimiento (legítimos solo en bases de prueba; en producción, explicarlos).
3. Cualquier `stock_current < 0`.
4. Conteo de `inventory_movements` y suma de `inventory_valuations.total_cost` (para compararlos al final).
5. Respaldo `pg_dump` previo y ensayo contra un **clon restaurado**, nunca directamente contra producción.

## 5. Diseño previsto de R2-ACT (pendiente de aprobación; sin implementar)

- Backfill: una fila de `stock_balances` por producto con `stock_current > 0`, `quantity = stock_current`, ubicación
  `DEFAULT` de `MAIN`, dentro de **una transacción explícita** (`BEGIN/COMMIT`, como R2-A1: la atomicidad de Prisma
  solo está observada, no garantizada por su documentación); verificaciones posteriores que abortan con
  `RAISE EXCEPTION` si algún producto no cuadra o cambian el conteo de movimientos / la suma de valorización.
- Invariante `stockCurrent = Σ StockBalance.quantity`, mantenida solo por `StockMovementEngine`; trigger diferido de
  verificación **(patrón nuevo en el repositorio: requiere aprobación explícita)**.
- Reglas de ubicaciones inactivas (propuesta I3): toda entrada o salida sobre ubicación/almacén inactivo responde 409.
- CHECK de corte opcional (`location_id IS NOT NULL OR created_at <= <instante de la migración>`) — requiere aprobación.
- Migrar los fixtures E2E que escriben `stockCurrent` directamente (≈ 19 archivos) a un helper común.
- Orden de bloqueo uniforme entre productos en recepciones (hallazgo C4 del plan original).

### Decisiones abiertas que condicionan R2-ACT
1. ¿Se aprueba el trigger diferido y el CHECK de corte?
2. ¿Se confirma la regla de ubicaciones inactivas (I3)?
3. Anulación de ventas/recepciones históricas (sin ubicación) → devuelven/retiran de `DEFAULT`.
4. Endpoint para designar otro almacén predeterminado (hoy inexistente a propósito: `MAIN` no puede desactivarse).

## 6. Riesgos y límites conocidos de R2-A1

- **El invariante "todo almacén tiene su `DEFAULT`" lo garantiza el servicio**, no un trigger (los triggers no están
  aprobados). Un `INSERT` manual en `warehouses` sin ubicación la deja sin `DEFAULT`; la API no lo permite.
- **Sin evidencia de stock por ubicación** durante EXPAND, la desactivación se bloquea ante cualquier rastro; un
  almacén `MAIN` nunca puede desactivarse. Es deliberado y se revisará en R2-ACT.
- Los saldos por ubicación no se leen para decidir nada. Una fila inventada en `stock_balances` no cambia ninguna
  operación (verificado por E2E).
- La migración introduce una dependencia nueva en el esquema: R2-ACT asumirá que `MAIN/DEFAULT` existen (los crea la
  migración; si un operador los borrara a mano, R2-ACT debe fallar cerrado).
