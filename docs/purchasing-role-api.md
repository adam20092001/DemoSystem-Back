# Rol PURCHASING y recepción de almacén — contrato REST para el frontend (Angular)

> **Superado parcialmente por R3.** `PURCHASING` ahora también confirma/anula facturas, registra/anula recepciones, opera pagos a proveedores e
> Importaciones. La matriz vigente está en [purchasing-full-access-api.md](purchasing-full-access-api.md); este documento conserva el contrato de
> sesión/rol activo y las vistas de recepción de `WAREHOUSE`.

Integración de **R1**: rol `PURCHASING`, permisos de compras por acción, excepción de `MANAGEMENT` y vistas de
recepción para `WAREHOUSE` sin información financiera. Referencia de reglas: [CLAUDE.md](../CLAUDE.md) §5 y §11 (R1).
El cuerpo exacto de cada request/response está en Swagger (`/api/docs`).

Base: `/api/v1`. Autenticación: cookie HttpOnly de sesión (igual que el resto de la API). Los importes y cantidades
viajan siempre como **string** (`"10.000"`, `"118.00"`), nunca como número. Fechas `YYYY-MM-DD`.

> **El frontend solo oculta opciones.** La autorización real vive en el backend: ocultar un botón no es un control de
> acceso, y toda operación prohibida responde **403** aunque se invoque directamente.

---

## 1. Roles de sesión: rol asignado vs. rol activo

Un usuario puede tener **varios roles asignados** (`roles`), pero cada petición se autoriza únicamente con su
**rol activo** (`activeRole`). Tener `ADMIN` asignado **no** da permisos de ADMIN mientras el rol activo sea
`PURCHASING`; los permisos nunca se suman entre roles.

Respuesta de `POST /auth/login`, `POST /auth/switch-role` y `GET /auth/me` (campos relevantes):

```json
{
  "id": "11111111-1111-4111-8111-111111111111",
  "username": "compras.ejemplo",
  "roles": ["PURCHASING", "WAREHOUSE"],
  "activeRole": "WAREHOUSE",
  "mustChangePassword": false
}
```

- Al iniciar sesión, el rol activo por defecto es el **menos privilegiado** según este orden fijo:
  `SELLER` → `WAREHOUSE` → `PURCHASING` → `MANAGEMENT` → `ACCOUNTANT` → `ADMIN`. Un usuario **solo-PURCHASING**
  inicia sesión normalmente con `activeRole: "PURCHASING"`.
- Cambiar de rol: `POST /auth/switch-role` con `{ "role": "PURCHASING" }` (solo entre los roles asignados; otro rol
  responde 403). Tras el cambio, **volver a cargar menús y permisos** con el nuevo `activeRole`.
- `roles` se devuelve ordenado para presentación: `ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING, WAREHOUSE, SELLER`.
- Asignar el rol (solo ADMIN): `POST /users` o `PATCH /users/:id` con `roleNames` que incluya `"PURCHASING"`.
  `GET /roles` lista los roles disponibles (incluye `PURCHASING`).

## 2. Matriz de permisos y visibilidad de menús/acciones

| Funcionalidad / acción | ADMIN | MANAGEMENT | PURCHASING | WAREHOUSE | ACCOUNTANT | SELLER |
|---|---|---|---|---|---|---|
| **Proveedores** — listar / ver | ✔ | ✔ | ✔ | ✘ | ✔ | ✘ |
| Proveedores — crear / editar | ✔ | ✘ | ✔ | ✘ | ✘ | ✘ |
| Proveedores — activar / desactivar | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| **Facturas de compra** — listar / ver (completa) | ✔ | ✔ | ✔ | ✘ | ✔ | ✘ |
| Facturas — crear / editar (solo `DRAFT`) | ✔ | ✘ | ✔ | ✘ | ✘ | ✘ |
| Facturas — confirmar / anular | ✔ | ✔ | ✘ | ✘ | ✘ | ✘ |
| **Recepciones** — ver (`/purchase-invoices/:id/receipts`, `/purchase-receipts/:id`) | ✔ completa | ✔ completa | ✔ completa | ✔ **sin importes** | ✔ completa | ✘ |
| Recepciones — vistas de almacén (`/purchase-receiving/*`) | ✔ | ✔ | ✘ | ✔ | ✔ | ✘ |
| Recepciones — registrar (recepción física) | ✔ | ✘ | ✘ | ✔ | ✘ | ✘ |
| Recepciones — anular | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |
| **Cuentas por pagar** (`/accounts-payable*`, reportes y `.xlsx`) | ✔ | ✔ | ✔ | ✘ | ✔ | ✘ |
| **Pagos a proveedores** (`/supplier-payments*`) | ✔ (leer + escribir) | leer | ✘ (ni leer) | ✘ | leer | ✘ |
| Productos / categorías / unidades — leer | ✔ | ✔ | ✔ | ✔ | ✘ | ✔ |
| `GET /configuration/pos` (impuestos, solo lectura) | ✔ | ✔ | ✔ | ✘ | ✘ | ✔ |
| Inventario (movimientos y stock) | ✔ | leer | ✘ | ✔ | ✘ | ✘ |
| Usuarios / roles / configuración administrativa | ✔ | ✘ | ✘ | ✘ | ✘ | ✘ |

Reglas de UI derivadas:

- **Menú "Compras"**: visible para `ADMIN`, `MANAGEMENT`, `PURCHASING`, `ACCOUNTANT`. Para `WAREHOUSE` **no** se muestra
  Compras: se muestra **"Recepción de mercadería"** (sección 5).
- **Botón "Confirmar"/"Anular" factura**: solo `ADMIN` y `MANAGEMENT`. `PURCHASING` **no** los ve (recibiría 403).
- **Botón "Nueva factura" / "Editar"**: solo `ADMIN` y `PURCHASING`, y "Editar" solo con `status = "DRAFT"`.
- **Activar/Desactivar proveedor**: solo `ADMIN`. `PURCHASING` ve "Nuevo" y "Editar" pero no el interruptor de estado.
- **Pagos a proveedor**: `PURCHASING` no ve la sección (ni siquiera como lectura). El detalle de saldo sí está en
  Cuentas por pagar.
- Ante un `403` inesperado, mostrar un mensaje genérico y refrescar la sesión (`GET /auth/me`): el rol activo pudo
  haber cambiado.

## 3. Proveedores — `/suppliers`

| Método y ruta | Roles | Notas |
|---|---|---|
| `GET /suppliers` | ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING | Paginado (`page`, `limit ≤ 100`) y filtros |
| `GET /suppliers/:id` | ídem | 404 si no existe |
| `POST /suppliers` | ADMIN, PURCHASING | Nace `ACTIVE`. 409 si el documento ya existe |
| `PATCH /suppliers/:id` | ADMIN, PURCHASING | **No admite `status`**: enviarlo (u otro campo no permitido) responde **400** y no cambia nada |
| `POST /suppliers/:id/activate` · `/deactivate` | **solo ADMIN** | 403 para PURCHASING |

Request de ejemplo (`POST /suppliers`):

```json
{
  "documentType": "RUC",
  "documentNumber": "20000000001",
  "legalName": "Distribuidora Ejemplo S.A.C.",
  "tradeName": "Ejemplo",
  "email": "ventas@ejemplo.test"
}
```

Response `201` (resumen):

```json
{
  "id": "22222222-2222-4222-8222-222222222222",
  "documentType": "RUC",
  "documentNumber": "20000000001",
  "countryCode": "PE",
  "legalName": "Distribuidora Ejemplo S.A.C.",
  "tradeName": "Ejemplo",
  "status": "ACTIVE",
  "createdAt": "2026-11-20T15:00:00.000Z",
  "updatedAt": "2026-11-20T15:00:00.000Z"
}
```

Error 400 al intentar cambiar el estado por `PATCH`:

```json
{ "statusCode": 400, "error": "Bad Request", "message": ["property status should not exist"] }
```

## 4. Facturas de compra — `/purchase-invoices`

Ciclo de estados (sin cambios): `DRAFT → CONFIRMED → CANCELLED`.

| Método y ruta | Roles | Notas |
|---|---|---|
| `GET /purchase-invoices` · `GET /purchase-invoices/:id` | ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING | **No** abiertas a WAREHOUSE (403) |
| `POST /purchase-invoices` | ADMIN, PURCHASING | Nace `DRAFT` |
| `PATCH /purchase-invoices/:id` | ADMIN, PURCHASING | Solo `DRAFT`; una factura ya `CONFIRMED`/`CANCELLED` responde **409** |
| `POST /purchase-invoices/:id/confirm` | **ADMIN, MANAGEMENT** | Contabiliza. 409 si falta un mapeo contable (comportamiento existente) |
| `POST /purchase-invoices/:id/cancel` | **ADMIN, MANAGEMENT** | Body `{ "reason": "…" }`; revierte el asiento |

Request de ejemplo (`POST /purchase-invoices`):

```json
{
  "supplierId": "22222222-2222-4222-8222-222222222222",
  "documentType": "FACTURA",
  "documentSeries": "F001",
  "documentNumber": "0001234",
  "issueDate": "2026-11-20",
  "lines": [
    {
      "productId": "33333333-3333-4333-8333-333333333333",
      "acquisitionKind": "GOOD",
      "purchasePurpose": "RESALE_INVENTORY",
      "quantity": "10.000",
      "unitCost": "12.50",
      "taxCategory": "UNAFFECTED"
    }
  ]
}
```

Response `201` (resumen): `{ "id": "…", "status": "DRAFT", "supplierId": "…", "totalAmount": "125.00",
"postedEntryId": null, "lines": [ { "id": "…", "isReceiptEligible": null, … } ], … }`. Tras `confirm`,
`status` pasa a `"CONFIRMED"`, `postedEntryId` se completa y cada línea congela `isReceiptEligible`.

> `confirm`/`cancel` por `MANAGEMENT` quedan auditados con el **usuario real** que ejecutó la acción.

## 5. Recepción de almacén (WAREHOUSE) — sin información financiera

`WAREHOUSE` **nunca** recibe precios, costos, bases imponibles, impuestos, totales, importes de reclasificación ni
ids de asientos contables, en ninguna de las respuestas que puede consultar.

### 5.1 Facturas pendientes de recepción

`GET /purchase-receiving/invoices?page=1&limit=20` — roles: ADMIN, WAREHOUSE, MANAGEMENT, ACCOUNTANT.
Solo facturas `CONFIRMED` con al menos una línea elegible con cantidad pendiente (se descuentan **solo** las recepciones
`ACTIVE`; anular una recepción vuelve a dejar pendiente su cantidad). Orden fijo: `issueDate` desc.

```json
{
  "data": [
    {
      "id": "44444444-4444-4444-8444-444444444444",
      "documentType": "FACTURA",
      "documentSeries": "F001",
      "documentNumber": "0001234",
      "issueDate": "2026-11-20",
      "supplier": {
        "id": "22222222-2222-4222-8222-222222222222",
        "legalName": "Distribuidora Ejemplo S.A.C.",
        "tradeName": "Ejemplo"
      },
      "pendingLinesCount": 1
    }
  ],
  "page": 1,
  "limit": 20,
  "total": 1,
  "totalPages": 1
}
```

### 5.2 Detalle para recibir

`GET /purchase-receiving/invoices/:id` — mismos roles. `404` si la factura no existe; `409` si no está `CONFIRMED`.
Solo líneas **elegibles** para recepción física (bienes de catálogo inventariables).

```json
{
  "id": "44444444-4444-4444-8444-444444444444",
  "status": "CONFIRMED",
  "documentType": "FACTURA",
  "documentSeries": "F001",
  "documentNumber": "0001234",
  "issueDate": "2026-11-20",
  "supplier": { "id": "22222222-2222-4222-8222-222222222222", "legalName": "Distribuidora Ejemplo S.A.C.", "tradeName": "Ejemplo" },
  "pendingLinesCount": 1,
  "lines": [
    {
      "purchaseInvoiceLineId": "55555555-5555-4555-8555-555555555555",
      "productId": "33333333-3333-4333-8333-333333333333",
      "productSku": "SKU-001",
      "productName": "Producto de ejemplo",
      "unitCode": "UND",
      "unitName": "Unidad",
      "invoicedQuantity": "10.000",
      "receivedQuantity": "4.000",
      "pendingQuantity": "6.000",
      "status": "PARTIAL"
    }
  ]
}
```

`status` por línea: `PENDING` (nada recibido) · `PARTIAL` · `COMPLETE`. `pendingLinesCount` cuenta las líneas que no
están `COMPLETE`.

### 5.3 Registrar la recepción

`POST /purchase-invoices/:id/receipts` — roles: **ADMIN, WAREHOUSE** (ruta ya existente; no cambia su contrato).

```json
{
  "receivedDate": "2026-11-20",
  "idempotencyKey": "recepcion-0001234-1",
  "lines": [
    { "purchaseInvoiceLineId": "55555555-5555-4555-8555-555555555555", "quantity": "4.000" }
  ]
}
```

- `lines[].purchaseInvoiceLineId` es el mismo valor que devuelve el detalle (5.2).
- Admite recepciones parciales; recibir más de lo pendiente responde **409** (el stock no cambia).
- Reenviar la misma `idempotencyKey` devuelve la misma recepción sin duplicar efectos.

Response `201` **para WAREHOUSE** (observe que **no existen** `reclassificationEntryId` ni `reclassifiedAmount`):

```json
{
  "id": "66666666-6666-4666-8666-666666666666",
  "purchaseInvoiceId": "44444444-4444-4444-8444-444444444444",
  "receivedDate": "2026-11-20",
  "status": "ACTIVE",
  "idempotencyKey": "recepcion-0001234-1",
  "notes": null,
  "createdByUserId": "77777777-7777-4777-8777-777777777777",
  "cancelledAt": null,
  "cancelledByUserId": null,
  "cancellationReason": null,
  "createdAt": "2026-11-20T15:10:00.000Z",
  "updatedAt": "2026-11-20T15:10:00.000Z",
  "lines": [
    { "id": "88888888-8888-4888-8888-888888888888", "purchaseInvoiceLineId": "55555555-5555-4555-8555-555555555555", "quantity": "4.000" }
  ]
}
```

Para `ADMIN`, `MANAGEMENT`, `ACCOUNTANT` y `PURCHASING` la misma respuesta conserva los campos financieros de siempre:
`reclassificationEntryId` (en la recepción) y `reclassifiedAmount` (en cada línea), ambos `null` cuando no hubo
reclasificación contable. **Los clientes deben tratar ambos campos como opcionales** (`undefined` para WAREHOUSE).

Lecturas con la misma regla de visibilidad: `GET /purchase-invoices/:id/receipts` (historial + resumen por línea) y
`GET /purchase-receipts/:id`.

`POST /purchase-receipts/:id/cancel` es **solo ADMIN** (WAREHOUSE recibe 403): no mostrar "Anular recepción" a otros roles.

## 6. Cuentas por pagar — `/accounts-payable`

`PURCHASING` tiene **solo lectura** de todos los `GET` (listado, detalle por factura, `summary`, `aging`,
`reconciliation` y sus exportaciones `.xlsx`). No existe ninguna acción de pago en este módulo; los pagos
(`/supplier-payments*`) **no** están disponibles para `PURCHASING`.

## 7. Pantallas sugeridas por rol

| Pantalla | Roles que la ven | Acciones visibles |
|---|---|---|
| Proveedores | ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING | Nuevo/Editar: ADMIN, PURCHASING · Activar/Desactivar: ADMIN |
| Facturas de compra | ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING | Nueva/Editar DRAFT: ADMIN, PURCHASING · Confirmar/Anular: ADMIN, MANAGEMENT |
| Recepciones (historial por factura) | ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING, WAREHOUSE | Anular: solo ADMIN. Importes: no mostrar columnas financieras a WAREHOUSE |
| Recepción de mercadería (almacén) | ADMIN, WAREHOUSE (operan) · MANAGEMENT, ACCOUNTANT (lectura) | Registrar recepción: ADMIN, WAREHOUSE |
| Cuentas por pagar | ADMIN, MANAGEMENT, ACCOUNTANT, PURCHASING | Solo lectura y exportación |
| Pagos a proveedores | ADMIN (operar), MANAGEMENT/ACCOUNTANT (lectura) | **No** PURCHASING ni WAREHOUSE |

## 8. Errores comunes

Formato global: `{ "statusCode": 403, "error": "Forbidden", "message": "No tiene permisos para …" }` (`message` puede
ser un arreglo en errores de validación 400).

| HTTP | Cuándo |
|---|---|
| 400 | Validación (propiedad no permitida, formato inválido) |
| 401 | Sin sesión válida |
| 403 | Rol activo sin permiso para la acción |
| 404 | Recurso inexistente |
| 409 | Estado incompatible (editar una factura no `DRAFT`, recibir más de lo pendiente, factura no `CONFIRMED`, mapeo contable faltante al confirmar) |
