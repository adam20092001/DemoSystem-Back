# Transferencias de stock entre ubicaciones (R2-C) — contrato REST para el frontend (Angular)

> **Estado: implementado en la rama `feat/r2-c-stock-transfers`. NO está integrado en `main` ni desplegado.**
> Requiere **R2-ACT** aplicado y la **migración 35** (`20261123011758_add_stock_transfers`), que **no se ha aplicado** a `pos_db` ni
> a `pos_db_test` (solo a PostgreSQL 16 descartables). Sin ella el backend no arranca correctamente.

Permite trasladar existencias de **un producto** de una ubicación a otra, dentro de un mismo almacén o entre almacenes distintos.
El stock consolidado del producto **no cambia**. El cuerpo exacto está en Swagger (`/api/docs`, etiqueta **Inventory**).

Base: `/api/v1`. Autenticación: cookie HttpOnly. Cantidades siempre como **string**.

---

## 1. Qué es (y qué no)

- Una transferencia es un **documento inmutable**: un EXIT en la ubicación de origen y un ENTRY en la de destino, creados en **una sola
  transacción** (si algo falla, no queda nada). Ambos movimientos aparecen en el kardex con `origin = "TRANSFER"` y el mismo `transferId`.
- **No se anula ni se elimina.** Para corregir una transferencia se registra **otra en sentido inverso** (con sus propias
  validaciones, movimientos y auditoría).
- **No es una venta ni una compra**: no genera ingresos, COGS, valorización, asientos contables ni cuentas por cobrar/pagar, y no
  cambia costos.
- No hay estado «en tránsito»: la transferencia entre almacenes es instantánea.
- No se reparte stock: el **origen debe tener saldo propio suficiente**; nunca se completa con otras ubicaciones.

Permisos: **crean** `ADMIN` y `WAREHOUSE`; **consultan** `ADMIN`, `WAREHOUSE` y `MANAGEMENT`. `SELLER`, `PURCHASING` y
`ACCOUNTANT` reciben 403. El usuario responsable (`createdBy`) es siempre el usuario autenticado.

---

## 2. Crear una transferencia

```http
POST /api/v1/inventory/transfers
{
  "productId": "…",
  "sourceLocationId": "…(DEFAULT)…",
  "destinationLocationId": "…(ESTANTE-A)…",
  "quantity": "10.000",
  "reason": "Reposición de estante",
  "notes": "opcional",
  "idempotencyKey": "opcional"
}
```

| Campo | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `productId` | UUID | Sí | Producto **inventariable y activo**. |
| `sourceLocationId` | UUID | Sí | Ubicación de origen. |
| `destinationLocationId` | UUID | Sí | Ubicación de destino (distinta del origen; puede ser de otro almacén). |
| `quantity` | string decimal | Sí | Positiva, hasta 11 enteros y 3 decimales. Respeta la unidad del producto (sin decimales si la unidad no los admite). |
| `reason` | string (≤ 200) | Sí | Motivo. |
| `notes` | string (≤ 500) | No | Observación. |
| `idempotencyKey` | string (≤ 100) | No | Ver sección 3. |

La fecha de la operación es la del servidor (`createdAt`); no se acepta ninguna fecha, `origin`, `movementType` ni `createdByUserId`
del cliente. Cualquier otro atributo produce 400.

**Respuesta 201:**

```json
{
  "id": "…",
  "product": { "id": "…", "sku": "SKU-1", "name": "Producto uno" },
  "sourceLocation": { "id": "…", "code": "DEFAULT", "name": "…", "warehouse": { "id": "…", "code": "MAIN" } },
  "destinationLocation": { "id": "…", "code": "ESTANTE-A", "name": "…", "warehouse": { "id": "…", "code": "MAIN" } },
  "quantity": "10.000",
  "reason": "Reposición de estante",
  "notes": null,
  "idempotencyKey": null,
  "createdBy": { "id": "…", "username": "ana", "firstName": "Ana", "lastName": "Pérez" },
  "exitMovementId": "…",
  "entryMovementId": "…",
  "createdAt": "2026-11-23T15:04:05.000Z"
}
```

Ejemplo de efecto: `DEFAULT: 20`, `ESTANTE-A: 5` (consolidado 25) → transferir 10 de `DEFAULT` a `ESTANTE-A` → `DEFAULT: 10`,
`ESTANTE-A: 15`, consolidado **25**.

### Errores

| HTTP | Cuándo |
|---|---|
| 400 | Datos inválidos: UUID mal formado, atributo no permitido, **origen igual a destino**, cantidad ≤ 0 o con más de 3 decimales, cantidad incompatible con la unidad, producto de tipo servicio / no inventariable. |
| 401 | Sin sesión. |
| 403 | Rol sin permiso (crear: no `ADMIN`/`WAREHOUSE`). |
| 404 | Producto o ubicación inexistente. |
| 409 | **Ubicación o almacén inactivos** (origen o destino); **stock insuficiente en el origen**; producto inactivo; **clave de idempotencia reutilizada con otro contenido**. |

Todo es atómico: ante cualquier error no cambia ningún saldo, no se crean movimientos ni documento y no se audita el éxito.

---

## 3. Idempotencia

`idempotencyKey` es **opcional**. Si la envía (genérela una vez por intento lógico y reenvíela tal cual en un reintento o doble clic):

- **Misma clave + mismo usuario + mismo contenido** (producto, origen, destino, cantidad, motivo y notas, comparados de forma
  canónica): devuelve **la transferencia original** (201), sin repetir movimientos ni descontar dos veces.
- **Misma clave + mismo usuario + contenido distinto**: **409**.
- **Solicitudes simultáneas con la misma clave**: se procesa como máximo una; las demás devuelven la misma transferencia.
- La clave es **por usuario**: otro usuario con la misma clave crea su propia transferencia.
- **Sin clave no existe garantía de deduplicación**: dos solicitudes iguales crean dos transferencias.

---

## 4. Consultar

```http
GET /api/v1/inventory/transfers?productId=…&sourceLocationId=…&destinationLocationId=…&warehouseId=…&dateFrom=…&dateTo=…&page=1&limit=20
GET /api/v1/inventory/transfers/{id}
```

- Filtros combinados con **AND**. `warehouseId` coincide si el almacén es el del **origen o el del destino**. `dateFrom`/`dateTo`: fecha
  ISO 8601, límites inclusivos (`dateFrom > dateTo` → 400).
- Orden fijo `createdAt DESC, id DESC`; paginación `page`, `limit` (máx. 100), `total`, `totalPages`.
- Detalle inexistente → 404.

---

## 5. Kardex

Los movimientos de una transferencia ya salen en `GET /inventory/movements` y `GET /inventory/products/:id/movements`, con
`origin: "TRANSFER"`, su `location` y el campo aditivo **`transferId`** (id de la transferencia; `null` en cualquier otro movimiento).
`GET /inventory/movements?origin=TRANSFER` lista solo los de transferencias. `previousStock`/`newStock` siguen siendo del **consolidado**
(el EXIT lo baja y el ENTRY lo vuelve a subir).

Angular debe tratar `transferId` como **nullable** y admitir el nuevo valor `TRANSFER` en `origin`.

---

## 6. Cómo armar la pantalla

1. Seleccionar el producto y consultar `GET /inventory/products/:id/stock-by-location` (R2-B1b) para mostrar el stock disponible por
   ubicación y limitar la cantidad al saldo del origen.
2. Origen y destino: `GET /warehouses` y `GET /warehouses/:id/locations` (R2-A1); ofrezca solo ubicaciones `ACTIVE` de almacenes
   `ACTIVE`, y excluya en el destino la ubicación elegida como origen.
3. Cantidad, motivo y observación; generar una `idempotencyKey` por intento y reenviarla en los reintentos.
4. Tras el 201, mostrar la transferencia y enlazar al historial (`GET /inventory/transfers?productId=…`).
5. Mensajes: 409 por stock insuficiente («el origen no tiene saldo suficiente»), 409 por ubicación/almacén inactivo, 409 por clave
   reutilizada.

---

## 7. Limitaciones

- Un producto por transferencia.
- Las transferencias son **irreversibles**; la corrección es una transferencia inversa (que puede fallar con 409 si el destino ya
  consumió el stock).
- Una ubicación con transferencias o movimientos no puede desactivarse (reglas de R2-A1, sin cambios).
- Requiere la migración 35 y R2-ACT aplicados antes de desplegar.
