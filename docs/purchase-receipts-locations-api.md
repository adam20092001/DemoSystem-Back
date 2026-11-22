# Recepciones de compra por ubicación (R2-B2) — contrato REST para el frontend (Angular)

> **Estado: implementado en la rama `feat/r2-b2-purchase-receipts-locations`. NO está integrado en `main` ni desplegado.**
> Depende de **R2-ACT** (la migración `20261031000000_activate_stock_by_location` debe estar aplicada antes de desplegar este
> backend). R2-B2 **no agrega migraciones**.

Permite indicar, **por línea**, la ubicación física donde ingresa la mercadería de una recepción de compra. El cuerpo exacto
está en Swagger (`/api/docs`, etiqueta **Purchase Receipts**).

Base: `/api/v1`. Autenticación: cookie HttpOnly. Cantidades siempre como **string** con 3 decimales.

---

## 1. Qué cambia y qué NO

**Cambia (aditivo, compatible):**

- `locationId` **opcional** (UUID) dentro de **cada línea** de `POST /purchase-invoices/:id/receipts`.
- Cada línea de las respuestas de recepción incluye `location` (objeto, o `null` en recepciones históricas).

**NO cambia:**

- Una solicitud **sin** `locationId` se comporta como antes: ingresa a `MAIN/DEFAULT`.
- Cantidades, recepciones parciales, idempotencia, contabilidad (reclasificación), valorización, costos, facturas, cuentas por
  pagar y pagos.
- Permisos: crear `ADMIN` y `WAREHOUSE`; anular solo `ADMIN`; leer `ADMIN`, `MANAGEMENT`, `ACCOUNTANT`, `PURCHASING` y
  `WAREHOUSE` (este último **sin importes**). `SELLER` sin acceso.

---

## 2. Crear una recepción con ubicación por línea

```http
POST /api/v1/purchase-invoices/{invoiceId}/receipts
{
  "receivedDate": "2026-11-22",
  "notes": "Recepción en dos estantes",
  "idempotencyKey": "recepcion-0001",
  "lines": [
    { "purchaseInvoiceLineId": "…", "quantity": "12.000", "locationId": "…(estante A)…" },
    { "purchaseInvoiceLineId": "…", "quantity": "8.000",  "locationId": "…(estante B)…" }
  ]
}
```

| Campo de línea | Tipo | Obligatorio | Descripción |
|---|---|---|---|
| `purchaseInvoiceLineId` | UUID | Sí | Línea de la factura CONFIRMED. |
| `quantity` | string decimal | Sí | Positiva, máximo 3 decimales. |
| `locationId` | UUID | No | Ubicación de destino **de esa línea**. Si se omite → `MAIN/DEFAULT`. |

Reglas:

- **Una ubicación por línea.** Una línea de factura no puede repetirse dentro de la misma recepción (400) y nunca se reparte
  automáticamente entre ubicaciones. Para repartir una línea use **recepciones sucesivas**.
- `locationId` va **dentro de cada línea**, no en la cabecera. Cualquier otro atributo (por ejemplo `warehouseId`) produce 400.
- Todo ocurre en una sola transacción: si una línea falla, no se registra nada (ni recepción, ni stock, ni asientos).

### Recepciones parciales y varias ubicaciones

- Una factura admite varias recepciones; la suma de lo recibido (recepciones `ACTIVE`) no puede superar lo facturado (409).
- Cada recepción puede usar ubicaciones distintas, y la **misma línea de factura** puede recibirse en ubicaciones diferentes
  mediante recepciones distintas. Ejemplo: factura de 15 unidades → recepción 1: 10 en `MAIN/ESTANTE-A`; recepción 2: 5 en
  `MAIN/DEFAULT`. El consolidado del producto aumenta 15.

### Idempotencia

Con `idempotencyKey` repetida se devuelve **la misma recepción ya creada**, tal como quedó: no se redirige a otra ubicación ni
se duplica stock, movimientos ni valorizaciones, aunque el reintento indique un `locationId` distinto.

---

## 3. Respuesta

Se **añade** `location` a cada línea (todos los campos existentes se conservan):

```json
{
  "id": "…",
  "purchaseInvoiceId": "…",
  "status": "ACTIVE",
  "lines": [
    {
      "id": "…",
      "purchaseInvoiceLineId": "…",
      "quantity": "12.000",
      "location": {
        "id": "…", "code": "ESTANTE-A", "name": "Estante A",
        "warehouse": { "id": "…", "code": "MAIN" }
      },
      "reclassifiedAmount": null
    }
  ]
}
```

- `location` es **`null`** en recepciones históricas (anteriores a R2-ACT); su anulación retira de `MAIN/DEFAULT`.
- `location` **no contiene importes** y lo ven todos los roles lectores, incluido `WAREHOUSE`.
- `WAREHOUSE` sigue sin recibir `reclassifiedAmount` ni `reclassificationEntryId` (las claves no existen).
- Aplica a `POST …/receipts`, `GET /purchase-invoices/:id/receipts`, `GET /purchase-receipts/:id` y
  `POST /purchase-receipts/:id/cancel`. Angular debe tratar `location` como **nullable**.

---

## 4. Anulación

`POST /purchase-receipts/:id/cancel` (solo `ADMIN`) genera un EXIT **desde la ubicación original de cada línea**:

- Recepción nueva: sale de la ubicación registrada en la línea.
- Recepción histórica (`location: null`): sale de `MAIN/DEFAULT`.
- Si el saldo **de esa ubicación** no alcanza → **409**; **nunca** se descuenta de otra ubicación. Sin efectos parciales.
- Los movimientos y la recepción originales no se editan: la anulación agrega movimientos de salida.

---

## 5. Errores

| HTTP | Cuándo |
|---|---|
| 400 | `locationId` mal formado; atributo no permitido; línea de factura repetida, inexistente o no elegible; cantidad inválida. |
| 401 | Sin sesión. |
| 403 | Rol sin permiso (crear: no `ADMIN`/`WAREHOUSE`; anular: no `ADMIN`). |
| 404 | Factura o **ubicación** inexistente. |
| 409 | Factura no `CONFIRMED`; cantidad que excede lo facturado; **ubicación o almacén inactivos**; anulación con saldo insuficiente en la ubicación original; vínculos de importación activos. |

---

## 6. Cómo elegir ubicación y consultar stock

- **Ubicaciones seleccionables:** `GET /warehouses` y `GET /warehouses/:warehouseId/locations` (R2-A1; ver
  `docs/warehouses-locations-api.md`). Ofrezca solo ubicaciones `ACTIVE` de almacenes `ACTIVE`. Predeterminado: `MAIN/DEFAULT`.
- **Stock por ubicación:** `GET /inventory/products/:productId/stock-by-location` (R2-B1b; ver
  `docs/inventory-locations-api.md`), útil para comprobar el resultado de una recepción o antes de anularla.

---

## 7. Limitaciones vigentes

- **Las ventas siguen tomando stock de `MAIN/DEFAULT`** (selección de ubicación en ventas: R2-B3). El stock recibido en otras
  ubicaciones no se puede vender directamente hasta entonces.
- **No hay transferencias** entre ubicaciones (R2-C).
- Una ubicación con recepciones o movimientos **no puede desactivarse** (reglas de R2-A1, sin cambios).
