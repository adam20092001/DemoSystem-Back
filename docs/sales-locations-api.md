# Ventas por ubicación de origen (R2-B3) — contrato REST para el frontend (Angular)

> **Estado: implementado en la rama `feat/r2-b3-sales-locations`. NO está integrado en `main` ni desplegado.**
> Depende de **R2-ACT** (la migración `20261031000000_activate_stock_by_location` debe estar aplicada antes de desplegar este
> backend). R2-B3 **no agrega migraciones**.

Permite elegir, por producto inventariable, la ubicación de la que sale el stock en una venta directa y en la conversión de una
cotización. El cuerpo exacto está en Swagger (`/api/docs`, etiqueta **Sales**).

Base: `/api/v1`. Autenticación: cookie HttpOnly. Cantidades siempre como **string**.

---

## 1. Qué cambia y qué NO

**Cambia (aditivo, compatible):**

- `locationId` **opcional** (UUID) en cada ítem de `POST /sales`.
- `locations` **opcional** en `POST /sales/from-quote/:quoteId`.
- Cada ítem de las respuestas de venta incluye `location` (objeto, o `null`).

**NO cambia:**

- Una solicitud **sin** `locationId` / `locations` se comporta como antes: el stock sale de `MAIN/DEFAULT`.
- Precios, descuentos, IGV, pagos, comprobantes, contabilidad, costos, valorización y COGS.
- **Una venta no puede repetir el mismo producto** (400, como siempre). Una venta puede usar varias ubicaciones **solo si
  corresponden a productos distintos**; una misma línea nunca se reparte entre ubicaciones.
- `POST /sales` y la conversión **confirman en el acto** (no existe venta pendiente ni reserva de stock): la ubicación se elige y
  se persiste en esa misma operación.
- Permisos: crear y convertir `ADMIN` y `SELLER`; anular solo `ADMIN`; leer `ADMIN`, `MANAGEMENT` y `SELLER` (este último solo
  lo propio). `WAREHOUSE`, `PURCHASING` y `ACCOUNTANT` no venden (403).

---

## 2. Venta directa con ubicación por línea

```http
POST /api/v1/sales
{
  "customerId": "…",
  "items": [
    { "productId": "…", "quantity": "2", "locationId": "…(estante A)…" },
    { "productId": "…", "quantity": "1" },
    { "productId": "…(servicio)…", "quantity": "1" }
  ]
}
```

| Campo de ítem | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `productId` | UUID | Sí | Producto (no repetible en la venta). |
| `quantity` | string decimal | Sí | Como antes. |
| `locationId` | UUID | No | Ubicación de **origen** de ese producto. Si se omite → `MAIN/DEFAULT`. |

Reglas:

- **Una ubicación por producto.** Los **servicios** no mueven stock: no tienen ubicación (`location: null`) y enviar `locationId`
  para un servicio responde **400**.
- `locationId` va **dentro de cada ítem**; cualquier otro atributo (por ejemplo `warehouseId`) produce 400.
- Todo es atómico: si algo falla no se crea venta, correlativo, pagos, asientos ni movimientos.
- **No se sustituye** una ubicación sin stock por otra: si no alcanza, la venta falla.

---

## 3. Conversión de cotización

```http
POST /api/v1/sales/from-quote/{quoteId}
{
  "locations": [
    { "productId": "…", "locationId": "…" }
  ],
  "payments": [ … ]
}
```

- `locations` es **opcional**; los productos inventariables que no aparezcan salen de `MAIN/DEFAULT`. Un cuerpo `{}` o solo con
  pagos sigue funcionando igual que antes.
- Solo puede referenciar **productos inventariables de la cotización**, sin repetidos. Un producto ajeno a la cotización, repetido,
  un servicio, un UUID inválido o un campo desconocido responden **400** y la cotización queda sin convertir.
- Precios, descuentos, IGV y pagos se siguen copiando/validando como antes (la cotización no cambia ni guarda ubicaciones).

---

## 4. Respuesta

Se **añade** `location` a cada ítem (todos los campos existentes se conservan):

```json
{
  "id": "…",
  "number": "NV-000123",
  "items": [
    {
      "id": "…",
      "productId": "…",
      "quantity": "2.000",
      "unitPrice": "10.00",
      "lineTotal": "20.00",
      "location": {
        "id": "…", "code": "ESTANTE-A", "name": "Estante A",
        "warehouse": { "id": "…", "code": "MAIN" }
      }
    }
  ]
}
```

- `location` es **`null`** en servicios y en ventas históricas (anteriores a R2-ACT). Angular debe tratarlo como **nullable**.
- No contiene importes. Aplica a creación, detalle, conversión y anulación. El listado `GET /sales` no incluye ítems.
- El impreso de la venta no cambia (no muestra la ubicación).

---

## 5. Errores

| HTTP | Cuándo |
|---|---|
| 400 | `locationId` mal formado; atributo no permitido; producto repetido; `locationId` en un servicio; `locations` con producto ajeno, repetido o no inventariable. |
| 401 | Sin sesión. |
| 403 | Rol sin permiso de venta. |
| 404 | Cliente, producto, cotización o **ubicación** inexistente (una cotización ajena de otro vendedor responde 404). |
| 409 | **Ubicación o almacén inactivos**; **stock insuficiente** en la ubicación (o consolidado); cotización no convertible; demás reglas comerciales existentes. |

El 409 por stock en una ubicación indica producto y ubicación, por ejemplo:
`Stock insuficiente para el producto SKU-1 en la ubicación MAIN/ESTANTE-A`.

---

## 6. Anulación

`POST /sales/:id/cancel` (solo `ADMIN`) devuelve **cada producto a la ubicación de la que salió**:

- Venta nueva: a la ubicación de cada movimiento original (una venta con varios productos en ubicaciones distintas repone cada
  uno en la suya).
- Venta histórica (movimiento sin ubicación): a `MAIN/DEFAULT`.
- Revierte también valorización y COGS, igual que antes; la doble anulación responde 409 y todo es atómico.

---

## 7. Cómo elegir ubicación y consultar stock

- **Ubicaciones seleccionables:** `GET /warehouses` y `GET /warehouses/:warehouseId/locations` (R2-A1; ver
  `docs/warehouses-locations-api.md`). Los roles que venden (`ADMIN`, `SELLER`) pueden leerlas. Ofrezca solo ubicaciones `ACTIVE`
  de almacenes `ACTIVE`. Predeterminado: `MAIN/DEFAULT`.
- **Stock por ubicación:** `GET /inventory/products/:productId/stock-by-location` (R2-B1b; ver `docs/inventory-locations-api.md`)
  para limitar la cantidad al saldo de la ubicación elegida. `SELLER` solo consulta productos operativos.

---

## 8. Limitaciones

- **Un producto aparece una sola vez por venta**: para vender el mismo producto desde dos ubicaciones hay que registrar **dos
  ventas** (o consolidar el stock con una salida y una entrada manuales).
- **No hay transferencias** entre ubicaciones (R2-C).
- Una ubicación con ventas o movimientos **no puede desactivarse** (reglas de R2-A1, sin cambios).
- La cotización no guarda ubicaciones ni descuenta stock: la ubicación se elige al convertir.
