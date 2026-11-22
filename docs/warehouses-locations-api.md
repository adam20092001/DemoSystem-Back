# Almacenes y ubicaciones (R2-A1; R2-ACT sin cambios de contrato) — contrato REST para el frontend (Angular)

Primera etapa de **R2** (stock por ubicación): catálogo administrativo de **almacenes** y **ubicaciones** y la
estructura de base de datos que prepara el stock por ubicación. El cuerpo exacto de cada request/response está en
Swagger (`/api/docs`, etiqueta **Warehouses**).

Base: `/api/v1`. Autenticación: cookie HttpOnly de sesión. Fechas ISO 8601. Cantidades (cuando existan) como **string**.

> **IMPORTANTE — para el frontend, el contrato NO cambia con R2-ACT.** Crear, editar, activar o desactivar
> almacenes/ubicaciones **no mueve existencias**, y `Product.stockCurrent` sigue siendo la **única** cantidad que expone
> la API (consolidada). Internamente (R2-ACT, ver §7) el inventario ya se mantiene por ubicación sobre `MAIN/DEFAULT`, pero
> ningún endpoint de `main` lo expone ni acepta ubicaciones.

> **R2-B1b (rama `feat/r2-b1b-manual-inventory-locations`, NO integrada en `main` ni desplegada):** añade `locationId`
> opcional a los cinco movimientos manuales de inventario, `location` en las respuestas de movimientos, el filtro
> `locationId` del kardex y `GET /inventory/products/:productId/stock-by-location`. Ver
> [`inventory-locations-api.md`](inventory-locations-api.md). Las ventas y recepciones siguen usando `MAIN/DEFAULT`.

---

## 1. Qué debe y qué NO debe consumir todavía el frontend

**Puede consumir ahora:** los 12 endpoints de catálogo de la sección 3 (administración y consulta de almacenes y
ubicaciones).

**NO debe consumir todavía** (reservado a R2-B/R2-C, no existe en la API):

- Selector de ubicación en recepciones de compra o ventas (`locationId` **no** se acepta en esos endpoints; enviarlo
  produce 400 por la validación estricta). *(Entradas, salidas, ajustes y saldo inicial: ver R2-B1b, aún no integrado.)*
- Saldos por ubicación: en `main` ninguna API los expone; R2-B1b (no integrado) añade
  `GET /inventory/products/:productId/stock-by-location`.
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
2. Un único almacén predeterminado (`MAIN`, `isDefault=true`); no hay endpoint para cambiarlo (reservado a R2-B).
3. Cada almacén tiene exactamente una ubicación `DEFAULT` (`isDefault=true`, código `DEFAULT`), creada en la misma
   transacción que el almacén. La garantiza el servicio; la base de datos asegura su unicidad y su forma
   (índice único parcial + CHECK), pero **no** impide por sí sola un almacén sin `DEFAULT` insertado a mano.
4. Códigos normalizados (mayúsculas, sin espacios) garantizados también por CHECK en la base de datos.
5. Nada se elimina físicamente.
6. Las columnas nuevas `locationId` en movimientos de inventario, líneas de venta y líneas de recepción son
   **nulas en todo registro** y ninguna lógica las lee ni las escribe todavía.

## 7. R2-ACT: efecto sobre este contrato y qué queda para R2-B/R2-C

**Sin cambios de contrato.** Estas rutas y sus respuestas no cambian con R2-ACT (rama
`feat/r2-act-stock-location-activation`, aún no integrada ni aplicada a ninguna base): ningún endpoint de inventario, venta o
recepción acepta ni devuelve ubicaciones, y las respuestas de movimientos siguen sin campos de ubicación.

Qué cambia por dentro (relevante para entender los 409 de desactivación):

- Toda operación de stock usa `MAIN/DEFAULT`. Los movimientos nuevos y las líneas de venta/recepción inventariables
  persisten la ubicación; por ello `MAIN` y su `DEFAULT` quedan **permanentemente activos** (tienen movimientos).
- Una ubicación o un almacén **inactivo** responde 409 a cualquier movimiento sobre él (incluidas las reversas).
- Las reglas de desactivación de este catálogo no cambian (D4): se bloquea ante cualquier saldo ≠ 0, movimiento, línea de
  venta o línea de recepción asociados. Se revisarán en R2-B.
- Los saldos por ubicación son internos: ninguna API los expone todavía.

**Reservado a R2-B / R2-C (no implementado):** `locationId` opcional en inventario/recepciones/ventas, elegir otra
ubicación, designar otro almacén predeterminado, transferencias y consultas/reportes por ubicación.

### R2-B1b (no integrado en `main`)

La rama `feat/r2-b1b-manual-inventory-locations` revisa parte de lo anterior: los movimientos manuales de inventario
aceptan `locationId` y sus respuestas devuelven `location` (excepción expresa y aprobada a la decisión D3, limitada al
módulo de inventario y aditiva). Contrato completo en [`inventory-locations-api.md`](inventory-locations-api.md). Las reglas
de desactivación (D4) **no cambian**: una ubicación con movimientos sigue sin poder desactivarse. Recepciones, ventas y
transferencias siguen reservadas a R2-B posteriores y R2-C.
