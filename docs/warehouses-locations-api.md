# Almacenes y ubicaciones (R2-A1, solo EXPAND) — contrato REST para el frontend (Angular)

Primera etapa de **R2** (stock por ubicación): catálogo administrativo de **almacenes** y **ubicaciones** y la
estructura de base de datos que prepara el stock por ubicación. El cuerpo exacto de cada request/response está en
Swagger (`/api/docs`, etiqueta **Warehouses**).

Base: `/api/v1`. Autenticación: cookie HttpOnly de sesión. Fechas ISO 8601. Cantidades (cuando existan) como **string**.

> **IMPORTANTE — esta etapa es INERTE respecto al inventario.** Nada de lo descrito aquí cambia cómo se calcula,
> aprueba o registra el stock. `Product.stockCurrent` sigue siendo la **única** cantidad operativa (consolidada).
> Crear, editar, activar o desactivar almacenes/ubicaciones **no mueve ni valida existencias**.

---

## 1. Qué debe y qué NO debe consumir todavía el frontend

**Puede consumir ahora:** los 12 endpoints de catálogo de la sección 3 (administración y consulta de almacenes y
ubicaciones).

**NO debe consumir todavía** (reservado a R2-ACT, no existe en la API):

- Selector de ubicación en entradas, salidas, ajustes, recepciones de compra o ventas (`locationId` **no** se acepta
  en esos endpoints; enviarlo produce 400 por la validación estricta).
- Saldos por ubicación (`stock_balances` está vacía y ninguna API la expone).
- Transferencias entre ubicaciones.
- `isDefault` como "almacén/ubicación de destino por defecto de operaciones": hoy es solo informativo.
- Cualquier cálculo de disponibilidad por almacén. La disponibilidad sigue siendo el stock consolidado.

## 2. Roles

| Acción | ADMIN | WAREHOUSE | MANAGEMENT | SELLER | PURCHASING | ACCOUNTANT |
|---|---|---|---|---|---|---|
| Listar / ver almacenes y ubicaciones | ✔ | ✔ | ✔ | ✔ | ✘ (403) | ✘ (403) |
| Crear / editar almacenes y ubicaciones | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| Activar / desactivar | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |

La autorización real vive en el backend (el rol **activo** de la sesión); ocultar botones no es un control de acceso.
Sin sesión: 401. Rol sin permiso: 403.

## 3. Endpoints

Las ubicaciones **siempre viven bajo su almacén**: una ubicación de otro almacén responde **404**, igual que una
inexistente.

### Almacenes

| Método y ruta | Rol | Descripción |
|---|---|---|
| `GET /warehouses` | lectura | Paginado. Filtros `status`, `search` (código/nombre), `page`, `limit` (máx. 100). Orden fijo: principal primero, luego por código. |
| `GET /warehouses/:id` | lectura | Detalle. 404 si no existe. |
| `POST /warehouses` | ADMIN | Crea (nace `ACTIVE`, `isDefault=false`) **y** su ubicación técnica `DEFAULT`, en una transacción. |
| `PATCH /warehouses/:id` | ADMIN | Solo `name` y `description` (`null`/vacío limpia la descripción). |
| `POST /warehouses/:id/activate` | ADMIN | `INACTIVE → ACTIVE`. 409 si ya estaba activo. |
| `POST /warehouses/:id/deactivate` | ADMIN | `ACTIVE → INACTIVE`. Ver reglas (sección 5). |

### Ubicaciones

| Método y ruta | Rol | Descripción |
|---|---|---|
| `GET /warehouses/:warehouseId/locations` | lectura | Paginado. Mismos filtros. 404 si el almacén no existe. |
| `GET /warehouses/:warehouseId/locations/:locationId` | lectura | Detalle. 404 si no existe **o es de otro almacén**. |
| `POST /warehouses/:warehouseId/locations` | ADMIN | Crea (nace `ACTIVE`, `isDefault=false`). |
| `PATCH /warehouses/:warehouseId/locations/:locationId` | ADMIN | Solo `name` y `description`. |
| `POST .../:locationId/activate` | ADMIN | Requiere almacén `ACTIVE`. |
| `POST .../:locationId/deactivate` | ADMIN | Ver reglas (sección 5). |

No existe `DELETE` (ni de almacenes ni de ubicaciones): se desactivan.

### Formas de respuesta

```json
// Warehouse
{ "id": "uuid", "code": "MAIN", "name": "Almacén principal", "description": null,
  "status": "ACTIVE", "isDefault": true, "createdAt": "…", "updatedAt": "…" }

// WarehouseLocation
{ "id": "uuid", "warehouseId": "uuid", "code": "DEFAULT", "name": "Ubicación predeterminada",
  "description": null, "status": "ACTIVE", "isDefault": true, "createdAt": "…", "updatedAt": "…" }

// Listados
{ "data": [ … ], "page": 1, "limit": 20, "total": 1, "totalPages": 1 }
```

`status`: `ACTIVE` | `INACTIVE`.

## 4. Validación y códigos

- `code` se normaliza a **mayúsculas sin espacios** antes de validar. Almacén: 1–20 caracteres; ubicación: 1–30;
  letras, números, guion o guion bajo; debe empezar por letra o número. Es **inmutable** tras crearse.
- `code` de almacén: único global. `code` de ubicación: único **dentro de su almacén** (puede repetirse en otro).
  La comparación es insensible a mayúsculas y espacios (`sur`, `SUR` y ` sur ` son el mismo código → 409).
- `name` obligatorio (máx. 100, no solo espacios). `description` opcional (máx. 300).
- El payload es estricto: cualquier campo no declarado (`status`, `isDefault`, `id`, `code` en `PATCH`, `warehouseId`…)
  produce **400**.
- `DEFAULT` es un código **reservado** a la ubicación técnica de cada almacén: crear otra con ese código → 409.

## 5. Estados, reglas y errores

Códigos: 400 payload inválido · 401 sin sesión · 403 rol sin permiso · 404 no existe (o ubicación de otro almacén) ·
409 conflicto de estado/unicidad.

| Situación | Resultado |
|---|---|
| Código duplicado (almacén, o ubicación en el mismo almacén) | 409 |
| Crear ubicación en almacén **inactivo** | 409 |
| Activar una ubicación de un almacén inactivo | 409 |
| Activar algo ya activo / desactivar algo ya inactivo | 409 |
| Desactivar el **almacén principal** (`MAIN`) | 409 |
| Desactivar la ubicación **`DEFAULT`** (siempre se desactiva solo con su almacén; nunca por separado) | 409 |
| Desactivar un almacén/ubicación con **saldos ≠ 0, movimientos o líneas de venta/recepción asociadas** | 409 |
| Operar sobre un almacén inexistente | 404 |

**Desactivación en EXPAND (conservadora):** como los saldos por ubicación aún no son la fuente de verdad del stock,
no puede *demostrarse* que una ubicación carezca de existencias. Por eso se bloquea ante **cualquier** rastro
(saldo ≠ 0, movimiento, línea de venta o de recepción que la referencie). Nunca se asume "stock cero". En la práctica,
en esta etapa solo se pueden desactivar almacenes/ubicaciones creados después de la migración y sin ninguna referencia.
Desactivar un almacén **no** desactiva automáticamente sus ubicaciones.

## 6. Invariantes de la estructura

1. Cada ubicación pertenece a exactamente un almacén (sin ubicaciones huérfanas; FK `RESTRICT`).
2. Un único almacén predeterminado (`MAIN`, `isDefault=true`); no hay endpoint para cambiarlo (reservado a R2-ACT).
3. Cada almacén tiene exactamente una ubicación `DEFAULT` (`isDefault=true`, código `DEFAULT`), creada en la misma
   transacción que el almacén. La garantiza el servicio; la base de datos asegura su unicidad y su forma
   (índice único parcial + CHECK), pero **no** impide por sí sola un almacén sin `DEFAULT` insertado a mano.
4. Códigos normalizados (mayúsculas, sin espacios) garantizados también por CHECK en la base de datos.
5. Nada se elimina físicamente.
6. Las columnas nuevas `locationId` en movimientos de inventario, líneas de venta y líneas de recepción son
   **nulas en todo registro** y ninguna lógica las lee ni las escribe todavía.

## 7. Limitaciones de R2-A1 (EXPAND) y qué queda para R2-ACT

Incluido: tablas `warehouses`, `warehouse_locations`, `stock_balances` (vacía), columnas nullable de ubicación, el
almacén `MAIN` con su ubicación `DEFAULT`, y el catálogo administrativo.

**Reservado a R2-ACT (no implementado):** motor de stock por ubicación (`StockMovementEngine` sin cambios), backfill
de las existencias actuales a `MAIN/DEFAULT`, la invariante `stockCurrent = Σ saldos` (y su verificación), `locationId`
opcional en inventario/recepciones/ventas, reglas de ubicaciones inactivas para movimientos, cambiar el almacén
predeterminado, transferencias y reportes por ubicación. Hasta entonces, los datos de ubicación (`isDefault`,
saldos) **no tienen significado operativo**.
