# Inventario manual por ubicación (R2-B1b) — contrato REST para el frontend (Angular)

> **Estado: implementado en la rama `feat/r2-b1b-manual-inventory-locations`. NO está integrado en `main` ni desplegado.**
> Depende de **R2-ACT** (integrado en `main`, pero **no aplicado** a `pos_db`/`pos_db_test`): la migración
> `20261031000000_activate_stock_by_location` debe estar aplicada antes de desplegar este backend. R2-B1b **no agrega
> migraciones**.

Permite que los cinco movimientos manuales indiquen una **ubicación**, muestra la ubicación en el kardex, permite filtrar
por ella y expone el stock por ubicación. El cuerpo exacto de cada request/response está en Swagger (`/api/docs`,
etiqueta **Inventory**).

Base: `/api/v1`. Autenticación: cookie HttpOnly. Cantidades siempre como **string** con 3 decimales.

---

## 1. Qué cambia y qué NO

**Cambia (todo aditivo, compatible):**

- `locationId` **opcional** en `POST /inventory/{initial-balances|entries|exits|adjustments/in|adjustments/out}`.
- Las respuestas de movimientos incluyen `location` (objeto, o `null` en movimientos históricos).
- Filtro opcional `locationId` en `GET /inventory/movements` y `GET /inventory/products/:productId/movements`.
- Nuevo `GET /inventory/products/:productId/stock-by-location`.

**NO cambia:**

- Una solicitud **sin** `locationId` se comporta exactamente como antes (opera sobre `MAIN/DEFAULT`).
- Ningún campo existente cambia de nombre, tipo ni significado. `previousStock`/`newStock` siguen siendo **consolidados**
  (no de la ubicación). `GET /inventory/products/:productId/stock` sigue devolviendo solo el consolidado.
- Permisos: sin cambios (escriben `ADMIN` y `WAREHOUSE`; leen `ADMIN`, `WAREHOUSE`, `MANAGEMENT`; el stock lo leen además
  `SELLER`). `PURCHASING` y `ACCOUNTANT` siguen sin acceso.
- Costos, valorización y COGS: los movimientos manuales nunca los tocan.

**Limitaciones vigentes (importante para el diseño de pantallas):**

- **Las ventas siguen tomando stock de `MAIN/DEFAULT`** y **las recepciones de compra siguen ingresando a
  `MAIN/DEFAULT`**. No existe selección de ubicación en ventas ni en recepciones (R2-B3 y posteriores).
- Por tanto, **el stock cargado en otras ubicaciones no se puede vender directamente** hasta R2-B3; la validación de
  ventas sigue usando el consolidado, pero la salida física se descuenta de `MAIN/DEFAULT` y falla (409) si ese saldo no
  alcanza aunque el consolidado sí.
- **No hay transferencias** entre ubicaciones (R2-C). Para "mover" stock hay que registrar una salida y una entrada.
- **Una ubicación con movimientos queda sujeta a las reglas actuales de desactivación**: no se puede desactivar
  mientras tenga movimientos, saldo distinto de cero o líneas asociadas (D4, sin cambios). En la práctica, operar en una
  ubicación la deja activa de forma permanente.

---

## 2. Registrar movimientos con ubicación

Las cinco rutas aceptan el mismo campo adicional:

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `locationId` | UUID | No | Ubicación afectada. Si se omite → `MAIN/DEFAULT`. |

La ubicación se obtiene de `GET /warehouses/:warehouseId/locations` (ver `docs/warehouses-locations-api.md`). Para elegir
bien el origen de una salida o un ajuste negativo, consulte antes el stock por ubicación (sección 5).

Todas las operaciones son **incrementos o decrementos** (`quantity` es siempre un delta positivo). No existen ajustes
"absolutos" (dejar el saldo en X).

**Validaciones (todas antes de escribir; si fallan no queda ningún efecto):**

1. `locationId` bien formado (UUID) → si no, **400**.
2. La ubicación existe → si no, **404** `Ubicación no encontrada`.
3. Su almacén está `ACTIVE` → si no, **409** `El almacén debe estar activo`.
4. La ubicación está `ACTIVE` → si no, **409** `La ubicación debe estar activa`.
5. Salidas/ajustes negativos: el saldo **de esa ubicación** debe alcanzar → si no, **409** (aunque el consolidado alcance).
6. El resto de las reglas existentes (producto activo, cantidad válida, etc.).

### 2.1 Entrada

```http
POST /api/v1/inventory/entries
{ "productId": "…", "quantity": "6.000", "reason": "Entrada en estante A", "locationId": "…" }
```

### 2.2 Salida

```http
POST /api/v1/inventory/exits
{ "productId": "…", "quantity": "2.000", "reason": "Merma", "locationId": "…" }
```

### 2.3 Ajustes

```http
POST /api/v1/inventory/adjustments/in    { "productId": "…", "quantity": "1.250", "reason": "Conteo", "locationId": "…" }
POST /api/v1/inventory/adjustments/out   { "productId": "…", "quantity": "0.250", "reason": "Conteo", "locationId": "…" }
```

### 2.4 Saldo inicial

```http
POST /api/v1/inventory/initial-balances
{ "productId": "…", "quantity": "8.000", "reason": "Carga inicial", "locationId": "…" }
```

El saldo inicial **sigue siendo único por producto, no por ubicación**:

- Solo es válido si el producto tiene `stockCurrent = "0.000"` y **ningún movimiento previo**.
- Se registra en la ubicación indicada (o en `MAIN/DEFAULT`).
- Un segundo saldo inicial (en la misma u otra ubicación) responde **409**. Para cargar existencias en otra ubicación
  use una **entrada** (`POST /inventory/entries`).

### 2.5 Respuesta de movimiento (201)

```json
{
  "id": "…",
  "product": { "id": "…", "sku": "SKU-1", "name": "Producto uno" },
  "movementType": "ENTRY",
  "origin": "MANUAL",
  "quantity": "6.000",
  "previousStock": "10.000",
  "newStock": "16.000",
  "reason": "Entrada en estante A",
  "notes": null,
  "createdBy": { "id": "…", "username": "ana", "firstName": "Ana", "lastName": "Pérez" },
  "location": {
    "id": "…", "code": "A1", "name": "Estante A1",
    "warehouse": { "id": "…", "code": "MAIN" }
  },
  "createdAt": "2026-11-22T15:04:05.000Z"
}
```

- `previousStock`/`newStock` son del **producto consolidado**, igual que antes.
- `location` es `null` en movimientos **históricos** (anteriores a R2-ACT), que nunca se reescriben. Todo movimiento
  nuevo trae ubicación.
- Angular debe tratar `location` como **opcional/nullable**.

### 2.6 Errores

| HTTP | Cuándo |
|---|---|
| 400 | `locationId` mal formado; campos no permitidos (p. ej. `warehouseId`); cantidad inválida. |
| 401 | Sin sesión. |
| 403 | Rol sin permiso de escritura (`MANAGEMENT`, `SELLER`, `PURCHASING`, `ACCOUNTANT`). |
| 404 | Producto o ubicación inexistente. |
| 409 | Ubicación/almacén inactivo; stock insuficiente (de la ubicación o consolidado); saldo inicial repetido o con movimientos previos; producto inactivo. |

---

## 3. Kardex con ubicación y filtro

`GET /inventory/movements` y `GET /inventory/products/:productId/movements` aceptan además:

| Query | Tipo | Descripción |
|---|---|---|
| `locationId` | UUID | Solo movimientos de esa ubicación. Se combina con **AND** con los demás filtros. |

```http
GET /api/v1/inventory/products/{productId}/movements?locationId={locationId}&limit=20&page=1
```

- Paginación (`page`, `limit`, `total`, `totalPages`) y orden (`createdAt DESC, id DESC`) no cambian.
- **Sin** `locationId` se listan todos los movimientos, **incluidos los históricos sin ubicación** (`location: null`).
  Con el filtro, los históricos sin ubicación no aparecen.
- Se puede filtrar por una ubicación **inactiva** con movimientos.
- `locationId` malformado → 400. Una ubicación inexistente produce una lista vacía (200).
- Roles de lectura sin cambios (`ADMIN`, `WAREHOUSE`, `MANAGEMENT`).

---

## 4. Compatibilidad con clientes actuales

- Un cliente que no envía `locationId` sigue funcionando igual: el movimiento cae en `MAIN/DEFAULT`.
- Un cliente que ignora el nuevo campo `location` de las respuestas sigue funcionando.
- Un cliente que valida estrictamente la forma de la respuesta debe admitir `location` (objeto o `null`).

---

## 5. Stock por ubicación

```http
GET /api/v1/inventory/products/{productId}/stock-by-location
```

Roles: `ADMIN`, `WAREHOUSE`, `MANAGEMENT`, `SELLER` (mismos que `GET …/stock`). Mismas reglas de acceso: `SELLER` solo ve
productos con producto/categoría/unidad `ACTIVE` (404 en otro caso).

```json
{
  "productId": "…",
  "sku": "SKU-1",
  "name": "Producto uno",
  "stockCurrent": "6.750",
  "unitAbbreviation": "un",
  "allowDecimal": true,
  "locations": [
    {
      "location": { "id": "…", "code": "DEFAULT", "name": "Ubicación por defecto",
                    "warehouse": { "id": "…", "code": "MAIN" } },
      "quantity": "3.500"
    },
    {
      "location": { "id": "…", "code": "A1", "name": "Estante A1",
                    "warehouse": { "id": "…", "code": "ALT" } },
      "quantity": "3.250"
    }
  ]
}
```

Reglas del contrato (estables):

- `stockCurrent` es el consolidado; **la suma de `locations[].quantity` es igual a `stockCurrent`**. Ambos se leen en una
  misma instantánea transaccional (`REPEATABLE READ`), así que no hay inconsistencias aunque haya movimientos concurrentes.
- **Solo se listan ubicaciones con cantidad > 0.** Las ubicaciones sin existencias (sin fila de saldo, o con saldo 0) se
  **omiten**; el cliente no debe esperar una fila por cada ubicación del catálogo. Un producto sin existencias devuelve
  `locations: []`.
- Orden: por código de almacén y luego por código de ubicación (estable).
- Es **solo lectura**: nunca crea saldos ni corrige `Product.stockCurrent`.
- Errores: `400` producto de tipo servicio o que no controla inventario, o id mal formado; `401`; `404` producto
  inexistente (o `SELLER` sin acceso).

---

## 6. Resumen de pantallas sugeridas

1. Selector de ubicación en entradas/salidas/ajustes/saldo inicial: poblar con las ubicaciones **activas** de almacenes
   **activos** (`GET /warehouses` + `GET /warehouses/:id/locations`). Predeterminado: `MAIN/DEFAULT`.
2. Para salidas y ajustes negativos, mostrar el stock por ubicación (sección 5) y limitar la cantidad al saldo de la
   ubicación elegida.
3. Kardex: columna **Ubicación** (`location.warehouse.code / location.code`, o "—" si `null`) y filtro por ubicación.
4. No ofrecer selección de ubicación en ventas ni recepciones todavía.
