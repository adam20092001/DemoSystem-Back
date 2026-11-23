# R2 — Stock por almacén y ubicación: plan de migración

Estado: **R2-A1 (EXPAND) integrada en `main`** (PR #53). **R2-ACT implementado en código en la rama
`feat/r2-act-stock-location-activation`, sin commit/push/PR y NO aplicado a `pos_db` ni a `pos_db_test`** (ver §5).
R2-B y R2-C **no están iniciadas** ni autorizadas.
Contrato de API de lo ya implementado: [warehouses-locations-api.md](warehouses-locations-api.md).

## 1. Estrategia: EXPAND → ACTIVAR

R2 cambia la fuente de verdad del stock (de `Product.stockCurrent` consolidado a saldos por ubicación). Para poder
revisar y revertir cada paso, se separa en etapas:

| Etapa | Contenido | Estado |
|---|---|---|
| **R2-A1 — EXPAND** | Estructura aditiva (tablas y columnas nullable), catálogo de almacenes/ubicaciones, `MAIN`/`DEFAULT`. **Inerte** para el inventario. | **Integrado en `main` (PR #53)** |
| **R2-ACT** | Backfill de existencias a `MAIN/DEFAULT`, invariante `stockCurrent = Σ saldos` (triggers diferidos), motor por ubicación (`StockMovementEngine`), orden global de bloqueos, fixtures E2E. | **Implementado en la rama `feat/r2-act-stock-location-activation` (sin commit; no aplicado a bases existentes)** |
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

## 5. R2-ACT — activación del inventario por ubicación (implementado en código; NO aplicado a ninguna base existente)

Rama `feat/r2-act-stock-location-activation`, base `main` en `1b54c61` (R2-A1 ya integrada, PR #53). **Sin commit,
push ni PR.** La migración `20261031000000_activate_stock_by_location` **no se ha aplicado** en `pos_db` ni en
`pos_db_test`; solo se probó en PostgreSQL 16 descartables. Decisiones aprobadas: D1 (orden por `productId` en
recepciones y anulaciones), D2 (CHECK `NOT VALID` + triggers diferidos), D3 (contrato de respuesta de movimientos
intacto), D4 (reglas de desactivación de A1 intactas; se revisan en R2-B).

### 5.1 Qué cambia

- **Estructura activada:** `stock_balances` deja de estar vacía y pasa a ser la fuente por ubicación; `Product.stockCurrent`
  sigue siendo la cantidad **consolidada** y la única que leen los reportes, el dashboard y la validación de ventas.
- **Invariante:** `products.stock_current = Σ stock_balances.quantity` para cada producto, verificada **en el COMMIT** por
  triggers (§5.3). `StockMovementEngine` sigue siendo el **único escritor** de stock.
- **Ubicación predeterminada:** ningún endpoint permite todavía elegir ubicación. Toda operación usa `MAIN/DEFAULT`
  (resuelta como "la ubicación `DEFAULT` del almacén predeterminado"). La selección explícita es R2-B.
- **Movimientos nuevos** persisten `location_id`, `location_previous_stock` y `location_new_stock`. Las líneas de venta
  inventariables y las líneas de recepción persisten `location_id`; las líneas de servicio, no.
- **Contrato público intacto (D3):** `SafeInventoryMovement` y las respuestas de ventas/recepciones no exponen campos de
  ubicación. La auditoría de inventario añade `locationId` a su lista blanca de metadatos.

### 5.2 Orden global de bloqueos (verificado en PostgreSQL 16.15 y con HTTP real)

```
1. documento (venta / cotización / factura y sus líneas / recepción), cuando la operación lo bloquea
2. Warehouse   FOR SHARE   (ids ascendentes)
3. WarehouseLocation FOR SHARE   (ids ascendentes)
4. Product     FOR UPDATE  (ascendente por productId; lo toma el motor, y la venta antes de aplicar)
5. fila de StockBalance FOR UPDATE + INSERT … ON CONFLICT DO UPDATE
6. capas posteriores (valorización, contabilidad)
```

- Nadie adquiere por primera vez un lock de almacén/ubicación **después** de uno de producto: `SalesService`
  (venta directa, conversión de cotización y anulación), `PurchaseReceiptsService` (recepción y anulación) llaman a
  `StockMovementEngine.lockLocationsShared()` **antes** de bloquear productos; el motor repite el bloqueo (idempotente).
- El catálogo (A1) toma el lock **exclusivo** de almacén/ubicación al desactivar, al inicio de su transacción y sin tomar
  nada de nivel inferior. El motor **nunca** usa `FOR UPDATE` sobre almacén o ubicación (con `FOR UPDATE` el spike produjo
  deadlock real).
- D1: recepciones y anulaciones de recepción procesan los productos en orden ascendente de `productId` (desempate por id
  de línea). Antes, el orden dependía del id de la línea de factura: dos recepciones con los mismos productos en orden
  inverso podían producir un **deadlock** (hallazgo C4, preexistente e intermitente; medido en §5.7).
- Una ubicación o un almacén inactivo responde 409 a **cualquier** movimiento, incluidas las reversas históricas.

### 5.3 Migración `20261031000000_activate_stock_by_location`

Una sola transacción explícita (`BEGIN`/`COMMIT`):

1. **Precondiciones** (falla cerrada, `RAISE EXCEPTION`): `MAIN` existe, está activo y es predeterminado; su `DEFAULT` existe
   y está activa; `stock_balances` vacía; ningún stock negativo; ningún movimiento, línea de venta ni línea de recepción
   con ubicación.
2. `LOCK TABLE products, stock_balances, inventory_movements IN SHARE ROW EXCLUSIVE MODE`: un backend antiguo que escriba
   durante la migración espera y, después, **falla cerrado** (el trigger rechaza el COMMIT y el CHECK rechaza el movimiento
   sin ubicación).
3. **Backfill:** una fila por producto con `stock_current > 0` hacia `MAIN/DEFAULT`, cantidad idéntica (Decimal(14,3)).
   Productos con stock 0: **sin fila** ("sin fila" = 0). No se toca `products`, costos, valorización ni movimientos.
4. **Conciliación antes del COMMIT:** por producto (`stock_current = Σ saldos`), suma global, conteo de productos y de
   movimientos, suma de `inventory_valuations.total_cost`, ningún movimiento con ubicación y ningún saldo fuera de
   `MAIN/DEFAULT`.
5. **Triggers diferidos** (`CREATE CONSTRAINT TRIGGER … DEFERRABLE INITIALLY DEFERRED`, `FOR EACH ROW`), función
   `r2_assert_product_stock_matches_balances()`: productos (`INSERT` con stock ≠ 0, `UPDATE OF stock_current`) y saldos
   (`INSERT`, `UPDATE` de cantidad o producto —se revisan `OLD` y `NEW`—, `DELETE`). Dentro de la transacción el estado
   puede ser incoherente; al COMMIT debe cuadrar. Coste medido ≈ 65 µs por disparo (una venta de 20 líneas ≈ 40 disparos
   ≈ 2,6 ms). No hay deduplicación (evita un hueco con `SET CONSTRAINTS … IMMEDIATE`).
6. `CHECK (location_id IS NOT NULL) NOT VALID` en `inventory_movements`: los movimientos **nuevos** exigen ubicación; los
   históricos (NULL) no se validan ni se modifican. `VALIDATE CONSTRAINT` fallará mientras existan históricos con NULL.

**Reversa de operaciones históricas:** una venta o recepción previa a ACT no tiene ubicación; su anulación crea un
movimiento **nuevo** con ubicación `MAIN/DEFAULT` (nunca modifica el movimiento histórico). Una operación nueva se revierte
a la ubicación del movimiento original.

### 5.4 Restricciones y límites conocidos

- `session_replication_role = replica`, `ALTER TABLE … DISABLE TRIGGER` y `TRUNCATE` eluden los triggers; requieren
  privilegios elevados y se mitigan con roles de base de datos, no con el trigger. Ninguna prueba los usa.
- El trigger **no puede detectar una pérdida de actualización**: la protección frente a ella es el `FOR UPDATE` del
  producto en el motor.
- Como consecuencia del `CHECK NOT VALID`, cualquier `UPDATE` de un movimiento histórico (location_id NULL) es rechazado
  (ningún código actual actualiza movimientos).
- El límite de 5 s de las transacciones interactivas de Prisma **no interrumpe una consulta bloqueada por un lock**
  (medido: una venta bloqueada 7 s por otra sesión responde 500 "Transaction already closed" solo cuando el lock se libera,
  sin efectos parciales). Preexistente; no se introdujeron `lock_timeout` ni reintentos.
- Una ubicación que ya tiene movimientos no puede desactivarse (D4, sin cambios): como todo movimiento nuevo lleva
  ubicación, `MAIN/DEFAULT` quedan permanentemente activas.
- Mensaje de error de Prisma Migrate: ante un fallo, Prisma muestra "current transaction is aborted" en lugar de la
  excepción original; la causa (`R2-ACT: …`) está en el log del servidor PostgreSQL.

### 5.5 Procedimiento de activación coordinada (no ejecutado)

1. Verificaciones de solo lectura en la base destino (§4) y **respaldo `pg_dump`**; ensayo sobre un **clon restaurado**.
2. Ventana sin escritura de inventario: detener el backend actual.
3. Aplicar `prisma migrate deploy` (esta migración) **antes** de iniciar el backend nuevo. Un backend R2-ACT contra una base
   sin migrar rechazaría salidas por falta de saldo por ubicación, y un backend anterior contra una base migrada falla
   cerrado: nunca arrancar un backend de versión distinta a la del esquema.
4. Comprobar: `SELECT count(*) FROM products p WHERE p.stock_current <> COALESCE((SELECT SUM(quantity) FROM stock_balances
   WHERE product_id = p.id),0)` debe ser 0; 5 triggers `r2_stock_check_*`; CHECK `inventory_movements_location_required_after_act`
   con `convalidated = false`.
5. Iniciar el backend R2-ACT y ejecutar la prueba de humo (venta, recepción y anulación sobre un producto de prueba).

**Plan de respaldo y recuperación:** si la migración falla, Prisma la deja registrada como fallida y revierte todo (no queda
ningún objeto parcial): corregir la causa, ejecutar `prisma migrate resolve --rolled-back 20261031000000_activate_stock_by_location`
y repetir `deploy` (probado). Si la migración tuvo éxito pero se decide volver atrás, **restaurar el respaldo previo** (Prisma
no tiene "down"); mientras no haya operaciones posteriores a la migración, el respaldo no pierde datos.

### 5.6 Decisiones abiertas

1. R2-B: ubicación explícita en inventario (**R2-B1b implementado en rama, ver §5.9**), recepciones (**R2-B2 implementado en rama, ver §5.10**) y ventas (**R2-B3 implementado en rama, ver §5.11**); revisar las reglas de desactivación (D4).
2. Endpoint para designar otro almacén predeterminado (hoy inexistente a propósito).
3. Si algún día se desea `VALIDATE CONSTRAINT`, hay que decidir qué hacer con los movimientos históricos sin ubicación
   (hoy no se reescriben).

### 5.7 Verificación realizada (solo PostgreSQL 16.15 descartables)

Alcance y límites: contenedores `postgres:16-alpine` propios y efímeros (`tmpfs`), con la guardia E2E del repositorio
(`.env.test.local`, marcador de base descartable). **Nunca** se conectó a `pos_db` ni `pos_db_test`, no se aplicó
ninguna migración ni seed a ellas y no se desplegó. Todo se verificó una sola vez por escenario salvo donde se indica.

**Migración (SQL real, también vía `prisma migrate deploy`):**

| Escenario | Resultado |
|---|---|
| Base limpia (33 migraciones + ACT) | Aplica; 0 saldos; 5 triggers; CHECK sin validar; segundo `deploy` sin pendientes |
| Base con datos de ejemplo (decimales, stock 0, producto no inventariable) | Saldos = stock por producto; productos con stock 0 sin fila; sin deriva (`migrate diff`, exit 0) |
| **Base poblada con el código anterior** (5 productos; 11 movimientos; 4 valorizaciones; 3 ventas, 1 anulada; 3 recepciones, 1 anulada) | Productos 5→5, Σ stock 23.875→23.875, movimientos 11→11 (todos NULL), valorización 75.00→75.00, 3 saldos (7.125 / 9.750 / 7.000) en `MAIN/DEFAULT`; sin deriva |
| Error inyectado al final y a mitad de la migración | Rollback total (sin saldos, función, triggers ni CHECK); migración registrada como no finalizada |
| Precondiciones incumplidas (MAIN inactivo; saldos preexistentes; movimiento con ubicación) | Abortan con la excepción propia y sin efectos |
| Recuperación | `migrate resolve --rolled-back` + `deploy` tras corregir la causa: éxito |
| Escritor del backend anterior durante la migración | Esperó el `LOCK TABLE`; después falló cerrado (trigger y CHECK) |

**Triggers y CHECK:** T01–T16 y C1–C8 (consistente en cualquier orden, solo consolidado, solo saldo, `INSERT`/`UPDATE`/`DELETE`
de saldo, cambio de `product_id` revisando `OLD` y `NEW`, varios movimientos por transacción, rollback, `SET CONSTRAINTS ALL
IMMEDIATE`; históricos NULL legibles, nuevos NULL rechazados, `VALIDATE CONSTRAINT` falla por diseño). Límites
comprobados: `session_replication_role = replica` y `TRUNCATE` los eluden.

**Concurrencia HTTP/Prisma real** (`test/stock-location-concurrency.e2e-spec.ts`, 13 pruebas; mismo archivo antes y
después del cambio, con `deadlock_timeout=200ms` y `log_lock_waits=on` en la base descartable):

| Escenario | Antes (código de `main`) | Después |
|---|---|---|
| 1a venta vs. desactivar MAIN y DEFAULT | venta 201; desactivaciones 409 | igual |
| 1b/2b motor real vs. desactivar ubicación/almacén (orden de llegada alternado, 12 y 10 rondas) | no aplica (sin ubicaciones) | exclusión mutua en todas las rondas: o se mueve el stock (y la desactivación recibe 409) o se desactiva (y el movimiento recibe 409); nunca ambos |
| 2a recepción vs. desactivar MAIN | recepción 201; desactivación 409 | igual |
| 3 / 3b dos salidas de 7 sobre stock 10 (venta y manual) | 201 + 409; stock 3 | igual |
| **4 recepciones con los mismos 2 productos en orden inverso** | **2 de 6 ejecuciones (×80 recepciones): 39 respondieron 500 por `deadlock detected` (78 deadlocks en el log)**; 4 ejecuciones sin fallos | **6 ejecuciones × 80 recepciones: 0 fallos y 0 deadlocks en el log** |
| 5 venta + recepción sobre el mismo producto (12 rondas) | todas 201; stock exacto | igual |
| 6a anular venta + otra venta + salida manual | 200/201/201; stock exacto | igual |
| 6b anular recepción vs. venta que consume ese stock | exactamente una prospera | igual |
| 7 venta de dos productos con el segundo insuficiente | 409; sin escrituras parciales; locks liberados | igual |
| 8 lock de producto retenido 7 s (> 5 s de la transacción de Prisma) | 500 tras ~6,7 s (al liberarse el lock); sin efectos parciales; el sistema se recupera | igual |

El deadlock del escenario 4 es **preexistente e intermitente** (no se reprodujo en 4 de 6 ejecuciones del comportamiento
anterior); D1 lo elimina por construcción (orden determinista), no por reintentos. No se agregaron reintentos ni
`lock_timeout`. Las pruebas 1b/2b y 9 solo se ejecutan con R2-ACT aplicada (se saltan solas con un aviso en caso contrario).

**Datos históricos reales** (`test/manual-r2-act/`; **no forman parte de `npm run test:e2e`**: su extensión es
`.manual-spec.ts` y el `testRegex` ordinario es `.e2e-spec.ts$`). Se comprobó: anular una **venta histórica** reingresa a
`MAIN/DEFAULT` con movimientos nuevos con ubicación sin tocar los históricos; anular una **recepción histórica** retira de
`MAIN/DEFAULT`; una venta nueva persiste la ubicación en la línea inventariable (no en el servicio); stock insuficiente sigue
respondiendo 409 sin efectos parciales; la conciliación global se mantiene. No pueden ser pruebas E2E normales porque el
`CHECK NOT VALID` impide insertar movimientos históricos (sin ubicación) en una base ya activada, y desactivarlo sería un
bypass. El procedimiento completo y reproducible está en §5.8.

**Regresión:** unitarias 143 suites / 4234 pruebas; E2E completa 55 suites / 1862 pruebas sin fallos (en una base
descartable nueva, la línea base de `main` fue 54 suites / 1848 pruebas sin fallos); scripts 86 + 11 de integración; `build`
correcto. Las "13 pruebas fallando" que se registraron antes en `pos_db_test` compartida no aparecen en una base descartable
limpia (dependían del estado acumulado de esa base).

### 5.8 Procedimiento reproducible: pruebas con datos históricos reales (manual, solo base descartable)

Reproduce **33 migraciones → datos históricos creados con el código anterior → migración 34 (R2-ACT) → operaciones con el
código nuevo**. Verificado de punta a punta (ver el resultado esperado de cada etapa). Los specs de `test/manual-r2-act/`
**no existen en `main`**: el código anterior se obtiene con un **worktree aislado** del commit base
`1b54c615b983bd5e3fcf644edea753be9dfba8bf` (no se usa `git stash`, no se toca `main` ni la rama actual) y solo se le copia el
spec del paso 1.

**Seguridad.** Todos los comandos de base de datos pasan por la guardia E2E (`scripts/lib/test-db-guard.js`): rechazan
cualquier destino que no sea una base **local, con nombre `pos_db_test_<sufijo>`, usuario `pos_test_user`, puerto distinto de
5432 y con marcador de base descartable**. `pos_db` y `pos_db_test` nunca son destinos válidos de este procedimiento. No
ejecutes `prisma migrate` ni `psql` directamente con una URL que no sea la de la base descartable de esta guía.

Los comandos son de Git Bash (Windows); en Linux/macOS cambia solo el enlace de `node_modules` (`ln -s`).
`REPO` es la raíz de la rama `feat/r2-act-stock-location-activation`.

**0. Preparación (una vez)**

```bash
cd <REPO>
export REPO="$(pwd)"
export BASE="$REPO/../DemoSystem-Back-r2act-base"          # worktree del código anterior
export DB=pos_db_test_r2act_hist                            # patrón obligatorio pos_db_test_<sufijo>
export PW=<clave-local-cualquiera>
export TOKEN=$(node -e "console.log(require('crypto').randomBytes(16).toString('hex'))")

# PostgreSQL 16 descartable propio (puerto alto; 5432 está prohibido y 5433 es el de pos_db_test)
MSYS_NO_PATHCONV=1 docker run -d --name r2act_hist_pg --label demosystem.r2act.hist=1 \
  -e POSTGRES_USER=pos_test_user -e POSTGRES_PASSWORD=$PW -e POSTGRES_DB=$DB \
  -p 55443:5432 --tmpfs /var/lib/postgresql/data postgres:16-alpine

# Worktree del commit base (33 migraciones) y enlace al node_modules de la rama
git worktree add --detach "$BASE" 1b54c615b983bd5e3fcf644edea753be9dfba8bf
powershell -NoProfile -Command "New-Item -ItemType Junction -Path '$(cygpath -w "$BASE")\node_modules' -Target '$(cygpath -w "$REPO")\node_modules'"
cp "$REPO/.env.test" "$BASE/.env.test"

# Autorización EXACTA de la base descartable, idéntica en ambos directorios (archivo no versionado)
for d in "$REPO" "$BASE"; do
  printf 'DATABASE_URL=postgresql://pos_test_user:%s@localhost:55443/%s?schema=public\nE2E_DISPOSABLE_TARGET=localhost:55443/%s\nE2E_DISPOSABLE_TOKEN=%s\n' \
    "$PW" "$DB" "$DB" "$TOKEN" > "$d/.env.test.local"
done
```

**Etapa A — base histórica (código anterior, 33 migraciones, sin R2-ACT)**

```bash
cd "$BASE"
npm run db:test:mark-disposable     # valida el destino y marca la base (solo si está vacía)
npm run prisma:test:deploy          # debe decir "33 migrations found" (la guardia valida el destino antes)
npm run prisma:test:seed
mkdir -p test/manual-r2-act && cp "$REPO/test/manual-r2-act/populate-historical.manual-spec.ts" test/manual-r2-act/
npx jest --config ./test/jest-e2e.json --testRegex '.*\.manual-spec\.ts$' --runInBand populate-historical
cp test/manual-r2-act/.state.json "$REPO/test/manual-r2-act/.state.json"
```

La salida debe incluir `[e2e-db-guard] destino verificado: DISPOSABLE localhost:55443/pos_db_test_r2act_hist` y `Tests: 1 passed`.
Evidencia a guardar (solo lectura, **solo** contra el contenedor descartable):

```bash
Q(){ docker exec r2act_hist_pg psql -U pos_test_user -d "$DB" -At -c "$1"; }
Q "select 'productos='||count(*)||' stock='||sum(stock_current) from products"
Q "select 'movs='||count(*)||' sin_ubicacion='||count(*) filter (where location_id is null) from inventory_movements"
Q "select 'valoriz='||count(*)||' costo='||sum(total_cost) from inventory_valuations"
Q "select 'saldos='||count(*) from stock_balances"
```

Resultado esperado: `productos=5 stock=23.875`, `movs=11 sin_ubicacion=11`, `valoriz=4 costo=75.00`, `saldos=0`.
`.state.json` contiene solo ids de esta base (sin credenciales) y está **ignorado por git**
(`test/manual-r2-act/.state.json`); los pasos B y C lo leen desde `REPO`.

**Etapa B — activación (código R2-ACT, migración 34)**

```bash
cd "$REPO"
npm run prisma:test:deploy          # debe decir "34 migrations found" y aplicar SOLO 20261031000000_activate_stock_by_location
# repetir las consultas Q(): ahora saldos=3 suma=23.875 (7.125 / 9.750 / 7.000, todos en MAIN/DEFAULT) y
# productos, stock, movimientos (11, todos sin ubicación) y valorización (4, 75.00) idénticos a la Etapa A.
Q "select 'descuadres='||count(*) from products p where p.stock_current <> coalesce((select sum(quantity) from stock_balances b where b.product_id=p.id),0)"   # 0

# Deriva: la URL es la de la base descartable; revisa que el destino impreso sea ...:55443/pos_db_test_r2act_hist
U="$(grep ^DATABASE_URL .env.test.local | cut -d= -f2-)"; echo "destino: ${U#*@}"
DATABASE_URL="$U" npx prisma migrate diff --from-url "$U" --to-schema-datamodel prisma/schema.prisma --exit-code   # "No difference detected."
```

**Etapa C — verificación con el backend nuevo**

```bash
cd "$REPO"
npx jest --config ./test/jest-e2e.json --testRegex '.*\.manual-spec\.ts$' --runInBand verify-historical
```

Esperado: `Tests: 7 passed` (estado migrado; anulación de venta histórica; anulación de recepción histórica; venta nueva;
409 por stock insuficiente; anulación de venta solo de servicios; conciliación global). Comprueba que los movimientos y
valorizaciones históricos no se reescriben.

**Limpieza (obligatoria; el orden importa)**

```bash
cd "$REPO"
# 1) Primero el enlace: NUNCA dejar que `git worktree remove` recorra la junction y borre node_modules
powershell -NoProfile -Command "(Get-Item '$(cygpath -w "$BASE")\node_modules').Delete()"
git worktree remove --force "$BASE" && git worktree prune
docker rm -f r2act_hist_pg
rm -f "$REPO/.env.test.local" "$REPO/test/manual-r2-act/.state.json"   # solo estos dos archivos
```

`.state.json` solo se necesita entre las Etapas A–C; es seguro borrarlo, y se regenera ejecutando de nuevo la Etapa A.
Limitación: el paso A debe ejecutarse una sola vez por base; para repetir el escenario se crea otra base descartable
(`DB` y contenedor nuevos) porque la migración 34 es irreversible sin restaurar un respaldo.

## 5.9 R2-B1b — inventario manual por ubicación (rama `feat/r2-b1b-manual-inventory-locations`; NO integrada ni desplegada)

Primera entrega de R2-B, sobre R2-ACT (que debe estar aplicado antes de desplegar). **Sin migraciones nuevas** y sin
cambios en `StockMovementEngine` (ya soportaba `locationId` desde R2-ACT): es cableado de contrato.

- **Movimientos manuales:** `locationId` opcional en saldo inicial, entrada, salida y ajustes ±; propagado
  DTO → controller → `RegisterMovementInput` → `InventoryService.run()` → `StockMovementCommand`. Sin él, `MAIN/DEFAULT`
  (comportamiento previo intacto). Las validaciones (existe → 404, almacén y ubicación activos → 409, insuficiencia por
  **ubicación** → 409, UUID → 400) y los bloqueos son los del motor, sin cambios.
- **Cantidades:** todas las operaciones son deltas; no hay ajustes absolutos. El saldo inicial sigue siendo único por
  producto (consolidado 0 y sin movimientos previos), colocado en la ubicación indicada; una segunda carga es una entrada.
- **Excepción aprobada a D3:** las respuestas de movimientos exponen `location: { id, code, name, warehouse: { id, code } } | null`
  (`null` en históricos) y `GET /inventory/movements` + kardex por producto aceptan el filtro `locationId`. Aditivo.
- **`GET /inventory/products/:productId/stock-by-location`:** consolidado + desglose, leídos en una transacción
  `REPEATABLE READ`; solo ubicaciones con cantidad > 0 (las demás se omiten); solo lectura; mismos roles que `…/stock`.
- **Sin cambios:** permisos, reglas de desactivación (D4), costos, valorización y COGS. Ventas y recepciones siguen en
  `MAIN/DEFAULT`; no hay transferencias.
- **Pruebas:** unitarias (DTOs, controller, servicio) y `test/inventory-locations.e2e-spec.ts` (37 pruebas contra
  PostgreSQL descartable, incluida concurrencia real). Contrato para Angular: `docs/inventory-locations-api.md`.

## 5.10 R2-B2 — recepciones de compra por ubicación (rama `feat/r2-b2-purchase-receipts-locations`; NO integrada ni desplegada)

Segunda entrega de R2-B, sobre R2-ACT y R2-B1b. **Sin migraciones nuevas** y sin cambios en `StockMovementEngine`.

- **`locationId` opcional por línea** en `POST /purchase-invoices/:id/receipts`; sin él, `MAIN/DEFAULT`. `create()` resuelve y bloquea
  las ubicaciones de todas las líneas con `lockLocationsShared()` (Warehouse/Location `FOR SHARE`, antes de los productos), las asocia a
  cada línea de factura **por id** (nunca por índice tras reordenar), las persiste en `PurchaseReceiptLine.locationId` y usa la misma en el
  ENTRY. Errores del motor: UUID inválido 400, inexistente 404, ubicación/almacén inactivos 409.
- **Una ubicación por línea.** El índice único `(purchaseReceiptId, purchaseInvoiceLineId)` y el rechazo de líneas repetidas (400) se
  conservan; repartir una línea exige recepciones sucesivas, cada una con su ubicación.
- **Anulación:** sin cambios de código (ya leía `locationId` de cada línea; histórica NULL → `MAIN/DEFAULT`; saldo insuficiente de la
  ubicación original → 409, sin sustituir por otra).
- **Respuesta aditiva:** `location { id, code, name, warehouse { id, code } } | null` por línea (sin importes; visible para WAREHOUSE).
- **Sin cambios:** permisos, cantidades, costos, valorización, contabilidad, facturas, cuentas por pagar, D4. Ventas siguen en
  `MAIN/DEFAULT`; sin transferencias.
- **Pruebas:** unitarias (DTO, mapper, servicio) y E2E en `test/purchase-receipts.e2e-spec.ts` (bloque «R2-B2», PostgreSQL descartable,
  incluida concurrencia con productos y ubicaciones cruzadas). El caso histórico NULL se cubre con prueba unitaria y el procedimiento manual
  de R2-ACT (sin bypass de restricciones en E2E). Contrato para Angular: `docs/purchase-receipts-locations-api.md`.

## 5.11 R2-B3 — ventas por ubicación de origen (rama `feat/r2-b3-sales-locations`; NO integrada ni desplegada)

Tercera entrega de R2-B, sobre R2-ACT, R2-B1b y R2-B2. **Sin migraciones nuevas** y sin cambios en `StockMovementEngine`.

- **`locationId` opcional por ítem** de `POST /sales` y **`locations` opcional** (`[{productId, locationId}]`) en
  `POST /sales/from-quote/:quoteId`. Sin ellos, `MAIN/DEFAULT`. `createDirect()` y `createFromQuote()` resuelven y bloquean las ubicaciones de
  **todas** las líneas en una sola llamada a `lockLocationsShared()` (Warehouse/Location `FOR SHARE`, antes de los productos) y las asocian por
  `productId` (nunca por índice tras ordenar); la ubicación se persiste en `SaleItem.locationId` y se usa en el EXIT.
- **Un producto por venta** (D21, índice único y 400 sin cambios) y **una ubicación por producto**. Los servicios no tienen ubicación: un
  `locationId` para un servicio (o para un producto no inventariable) responde 400. En la conversión, `locations` con producto ajeno a la
  cotización, repetido o no inventariable responde 400. `Quote`/`QuoteItem` no cambian.
- **Stock:** el motor sigue siendo la validación autoritativa (insuficiencia por ubicación → 409). Solo se enriquece su mensaje con producto y
  ubicación (consulta únicamente en el camino de error). Nunca se sustituye por otra ubicación.
- **Anulación:** sin cambios de código (ya reingresa a la ubicación del movimiento original; histórico NULL → `MAIN/DEFAULT`).
- **Respuesta aditiva:** `location { id, code, name, warehouse { id, code } } | null` por ítem (servicios e históricos: `null`). El impreso no cambia.
- **Sin cambios:** permisos, precios, descuentos, IGV, pagos, comprobantes, contabilidad, costos, valorización, COGS y D4. Las transferencias
  (R2-C) siguen pendientes.
- **Pruebas:** unitarias (DTOs, mapper, servicio) y `test/sales-locations.e2e-spec.ts` (PostgreSQL descartable, incluida concurrencia). El caso
  histórico NULL se cubre con prueba unitaria y el procedimiento manual de R2-ACT (sin bypass de restricciones en E2E). Contrato para Angular:
  `docs/sales-locations-api.md`.

## 5.12 R2-C — transferencias de stock entre ubicaciones (rama `feat/r2-c-stock-transfers`; NO integrada ni desplegada)

Cuarta entrega de R2-B/R2-C, sobre R2-ACT, R2-B1b, R2-B2 y R2-B3. **Incluye la migración 35** (`20261123011758_add_stock_transfers`), aplicada
únicamente en PostgreSQL 16 descartables; **no** en `pos_db` ni `pos_db_test`.

- **Migración 35 (100% aditiva):** valor `TRANSFER` en `InventoryMovementOrigin`; tabla `stock_transfers` (producto, ubicación origen y destino,
  cantidad, motivo, notas, `idempotency_key`, usuario, `exit_movement_id` y `entry_movement_id` únicos, `created_at`) con FK `RESTRICT`; índice único
  `(created_by_user_id, idempotency_key)` (admite varios NULL); CHECK `quantity > 0`, `source <> destination`, clave no vacía; y un CHECK nuevo
  `inventory_movements_transfer_consistency` (un movimiento `TRANSFER` es ENTRY/EXIT, referencia `StockTransfer` y lleva ubicación; se compara
  `origin::text` porque PostgreSQL no permite usar un valor de enum recién agregado en la misma transacción). Ninguna tabla ni migración anterior se modifica.
- **Motor:** único cambio en `StockMovementEngine`: `TRANSFER` admite ENTRY y EXIT (`ALLOWED_ORIGIN_MOVEMENT_TYPES`). No se agrega a
  `AUTHORITATIVE_HISTORICAL_ORIGINS` (el producto debe ser inventariable y activo). Reglas de stock, bloqueo, conciliación y valorización intactas.
- **Servicio (`src/inventory/transfers/`):** una transacción: advisory lock de idempotencia (si hay clave) → `lockLocationsShared([origen, destino])` en una sola
  llamada (antes de bloquear el producto) → EXIT(origen) → ENTRY(destino) → documento → auditoría `INVENTORY_TRANSFER_CREATED`. No inyecta los motores de
  valorización ni de contabilidad. `Product.stockCurrent` no cambia.
- **Inmutabilidad:** sin anulación ni eliminación; la corrección es una transferencia inversa.
- **Idempotencia:** clave opcional por usuario; mismo contenido (comparación canónica) → la original; contenido distinto → 409; concurrente → una sola.
- **API:** `POST/GET /inventory/transfers`, `GET /inventory/transfers/:id`; ADMIN/WAREHOUSE crean, ADMIN/WAREHOUSE/MANAGEMENT consultan. Kardex: campo
  aditivo `transferId`. Contrato para Angular: `docs/stock-transfers-api.md`.
- **Pruebas:** unitarias (servicio, DTOs, controller, mapper, motor) y `test/stock-transfers.e2e-spec.ts` (PostgreSQL descartable; concurrencia real y
  CHECK probados intentando violarlos, sin desactivarlos).

## 6. Riesgos y límites conocidos de R2-A1 (los puntos sobre inercia quedan superados por R2-ACT, §5)

- **El invariante "todo almacén tiene su `DEFAULT`" lo garantiza el servicio**, no un trigger (los triggers no están
  aprobados). Un `INSERT` manual en `warehouses` sin ubicación la deja sin `DEFAULT`; la API no lo permite.
- **Sin evidencia de stock por ubicación** durante EXPAND, la desactivación se bloquea ante cualquier rastro; un
  almacén `MAIN` nunca puede desactivarse. Es deliberado y se revisará en R2-ACT.
- Los saldos por ubicación no se leen para decidir nada. Una fila inventada en `stock_balances` no cambia ninguna
  operación (verificado por E2E).
- La migración introduce una dependencia nueva en el esquema: R2-ACT asumirá que `MAIN/DEFAULT` existen (los crea la
  migración; si un operador los borrara a mano, R2-ACT debe fallar cerrado).
