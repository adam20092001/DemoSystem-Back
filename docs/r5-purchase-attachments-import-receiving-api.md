# R5 — Documentos adjuntos de compras y recepción desde Importaciones

Contrato para el frontend Angular. Prefijo de todas las rutas: `/api/v1`. Autenticación: cookie HttpOnly de
sesión (la misma del resto de la API); toda petición `fetch`/`HttpClient` debe enviar `withCredentials: true`.
Errores: cuerpo estándar con `statusCode`, `message`, `error`, `kind` (`FORM` | `GENERAL`), `code` y, en errores de
campo, `errors[]` (`field`, `code`, `type` = `REQUIRED` | `FORMAT` | `BUSINESS`, `message`) — ver
`docs/r4-business-enhancements-api.md`.

Este documento cubre **dos funcionalidades independientes**:

1. [Documentos adjuntos de facturas de compra](#1-documentos-adjuntos-de-facturas-de-compra)
2. [Recepción de mercadería desde Importaciones](#2-recepción-de-mercadería-desde-importaciones)

---

## 1. Documentos adjuntos de facturas de compra

Se pueden adjuntar uno o varios archivos **PDF, JPG/JPEG o PNG** (máx. **10 MB** por archivo) a una factura de
compra. Adjuntar **no cambia** el estado, los importes ni la contabilización de la factura, y el sistema **no
interpreta** el contenido del archivo.

### 1.1 Endpoints

| Método | Ruta | Descripción |
|---|---|---|
| `POST` | `/purchase-invoices/:purchaseInvoiceId/attachments` | Adjuntar un documento (multipart) |
| `GET` | `/purchase-invoices/:purchaseInvoiceId/attachments` | Listar los documentos activos |
| `GET` | `/purchase-invoices/:purchaseInvoiceId/attachments/:attachmentId/preview` | Bytes originales, `inline` |
| `GET` | `/purchase-invoices/:purchaseInvoiceId/attachments/:attachmentId/download` | Bytes originales, `attachment` |
| `DELETE` | `/purchase-invoices/:purchaseInvoiceId/attachments/:attachmentId` | Eliminar (solo factura `DRAFT`), `204` |
| `GET` | `/import-operations/:importOperationId/documents` | Documentos de la factura vinculada a la importación |
| `GET` | `/import-operations/:importOperationId/documents/:attachmentId/preview` | Igual que arriba, desde Importaciones |
| `GET` | `/import-operations/:importOperationId/documents/:attachmentId/download` | Igual que arriba, desde Importaciones |

Los endpoints de Importaciones sirven **los mismos archivos** (no existe ninguna copia por importación) y exigen
los mismos permisos de lectura de la compra. Una operación histórica sin factura vinculada responde
`{ "purchaseInvoiceId": null, "documents": [] }`.

### 1.2 Subida (`multipart/form-data`)

```ts
const form = new FormData();
form.append('file', file);            // único campo: "file"
this.http.post<PurchaseInvoiceAttachment>(
  `/api/v1/purchase-invoices/${invoiceId}/attachments`,
  form,
  { withCredentials: true, headers: { 'Idempotency-Key': crypto.randomUUID() } },
);
// No fijar manualmente Content-Type: el navegador agrega el boundary.
```

* `Idempotency-Key` (opcional, 1–100 caracteres `A-Z a-z 0-9 . _ : -`): reenviar **la misma clave con el mismo
  archivo** devuelve el documento ya cargado (`idempotentReplay: true`) sin duplicarlo; **misma clave con otro
  contenido** responde `409` (`IDEMPOTENCY_KEY_CONFLICT`). Genere una clave nueva por cada archivo elegido por la
  persona usuaria y reutilícela solo en reintentos del mismo archivo. Sin cabecera no hay deduplicación.
* El `Content-Type` de la parte `file` debe coincidir con el contenido real (`application/pdf`, `image/jpeg`,
  `image/png`) y la extensión del nombre, si existe, con el formato (`.pdf`, `.jpg/.jpeg`, `.png`).

### 1.3 Respuesta (metadatos)

```json
{
  "id": "uuid",
  "purchaseInvoiceId": "uuid",
  "fileName": "Factura 01.pdf",
  "mimeType": "application/pdf",
  "fileSize": 90213,
  "sha256": "…64 hex…",
  "uploadedAt": "2026-11-23T18:36:43.054Z",
  "uploadedByUserId": "uuid",
  "status": "ACTIVE",
  "canDelete": true,
  "previewable": true,
  "idempotentReplay": false
}
```

* `fileName` es el nombre original **saneado** (solo informativo). Nunca se expone la clave ni la ruta de
  almacenamiento: **no hay URLs públicas**.
* `canDelete` es `true` solo mientras la factura está en `DRAFT`. El listado devuelve únicamente documentos
  `ACTIVE`, ordenados por fecha de carga.

### 1.4 Previsualizar y descargar

Los archivos solo se entregan por estos endpoints autenticados (cookie + rol + pertenencia a la factura). **No use
enlaces directos ni `<img src>`/`<iframe src>` apuntando a una URL sin sesión**: obtenga los bytes con `HttpClient`
(`responseType: 'blob'`, `withCredentials: true`) y muéstrelos con una URL de objeto:

```ts
this.http.get(`/api/v1/purchase-invoices/${id}/attachments/${attId}/preview`,
  { responseType: 'blob', withCredentials: true })
  .subscribe(blob => this.url = URL.createObjectURL(blob)); // revocar con URL.revokeObjectURL al destruir
```

* `preview` → `Content-Disposition: inline`; `download` → `attachment` con el nombre original (RFC 5987).
* Cabeceras de seguridad: `X-Content-Type-Options: nosniff`, `Content-Security-Policy: default-src 'none'; sandbox`,
  `Cache-Control: private, no-store`. Por la CSP, abrir la URL directamente en una pestaña puede no mostrar el visor
  de PDF del navegador: use la URL de objeto (blob) del ejemplo.
* Los PDF que contienen JavaScript o acciones de lanzamiento se rechazan al subirlos.

### 1.5 Estados de la factura y permisos

| Estado de la factura | Subir | Listar / previsualizar / descargar | Eliminar |
|---|---|---|---|
| `DRAFT` | sí | sí | sí (borrado lógico) |
| `CONFIRMED` | sí (documentos **complementarios**, auditado) | sí | **no** (`409 ATTACHMENT_DELETE_NOT_ALLOWED`) |
| `CANCELLED` | no (`409 PURCHASE_INVOICE_CANCELLED`) | sí | no |

| Acción | ADMIN | PURCHASING | MANAGEMENT | ACCOUNTANT | WAREHOUSE | SELLER |
|---|---|---|---|---|---|---|
| Subir / eliminar | sí | sí | no (403) | no (403) | no (403) | no (403) |
| Listar / previsualizar / descargar | sí | sí | sí | sí | no (403) | no (403) |

La autorización se resuelve siempre en el backend con el **rol activo** de la sesión. Un adjunto solo se entrega
bajo la factura a la que pertenece: un identificador ajeno, eliminado o inexistente responde el **mismo `404`**
(`ATTACHMENT_NOT_FOUND`), de modo que conocer un id no permite descargar ni revela su existencia.

### 1.6 Errores

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `ATTACHMENT_EMPTY` | Archivo vacío (`errors[0].field = "file"`) |
| 400 | `ATTACHMENT_UNSUPPORTED_TYPE` | No es PDF, JPEG ni PNG (por su contenido) |
| 400 | `ATTACHMENT_MIME_MISMATCH` | El `Content-Type` declarado no coincide con el contenido |
| 400 | `ATTACHMENT_EXTENSION_MISMATCH` | La extensión del nombre no coincide con el contenido |
| 400 | `ATTACHMENT_CORRUPT` | Firma/estructura inválida o archivo truncado |
| 400 | `ATTACHMENT_ACTIVE_CONTENT` | PDF con JavaScript o acciones de lanzamiento |
| 400 | `IDEMPOTENCY_KEY_INVALID` | Formato de `Idempotency-Key` inválido |
| 413 | — | Archivo mayor a 10 MB |
| 404 | `ATTACHMENT_NOT_FOUND` / `ATTACHMENT_FILE_MISSING` | Documento inexistente/ajeno/eliminado, o archivo físico no disponible |
| 409 | `PURCHASE_INVOICE_CANCELLED`, `ATTACHMENT_DELETE_NOT_ALLOWED`, `IDEMPOTENCY_KEY_CONFLICT` | Reglas de estado e idempotencia |

### 1.7 Persistencia, integridad y auditoría

* El archivo se escribe primero y el registro después; si el registro falla se retira el archivo (compensación), y
  si falla el almacenamiento no queda ningún registro: la factura permanece íntegra y la carga se puede reintentar.
* Auditoría: `PURCHASE_INVOICE_ATTACHMENT_UPLOADED` / `PURCHASE_INVOICE_ATTACHMENT_DELETED` con el usuario real,
  la factura y el identificador del adjunto. No se registra contenido binario ni el nombre del archivo.

---

## 2. Recepción de mercadería desde Importaciones

Desde una importación **vinculada a una factura de compra `CONFIRMED`** se registra la recepción física de la
mercadería de un embarque. **No existe un mecanismo de inventario paralelo**: cada recepción reutiliza la
recepción de compra existente (movimiento de stock, valorización, reclasificación contable según la
configuración vigente, multimoneda de R4) y la vincula al embarque, todo en **una sola transacción**.

La factura **nunca** se confirma automáticamente; recibir no confirma de nuevo la compra, no duplica la deuda con el
proveedor, no registra otra compra, no duplica valorización y **no capitaliza** gastos de importación. Marcar un
embarque `ARRIVED` o completar una importación **no mueven stock** por sí mismos.

### 2.1 Endpoints

| Método | Ruta | Descripción | Roles |
|---|---|---|---|
| `GET` | `/import-operations/:importOperationId/receiving` | Cantidades y pendientes (sin importes) | ADMIN, PURCHASING, MANAGEMENT, ACCOUNTANT |
| `POST` | `/import-operations/:importOperationId/shipments/:importShipmentId/receive` | Recibir mercadería (crea recepción + vínculo) | ADMIN, PURCHASING |
| `POST` | `/import-operations/:importOperationId/shipments/:importShipmentId/link-receipts` | Vincular recepciones **ya registradas** (p. ej. desde Compras) | ADMIN, PURCHASING |

Ambos `POST` exigen la cabecera **`Idempotency-Key`** (obligatoria; `400 IDEMPOTENCY_KEY_REQUIRED` si falta) y
responden `201`. El permiso se evalúa en dos capas: operar la importación **y** registrar recepciones de compra. El
rol activo `WAREHOUSE` (que sí registra recepciones desde Compras) **no** puede operar desde Importaciones; `MANAGEMENT`
y `ACCOUNTANT` solo consultan. La auditoría registra siempre al usuario real.

### 2.2 Cantidades: definiciones

El pendiente de una **importación** no es el pendiente de la **factura**. Cada línea de embarque expone:

| Campo | Significado |
|---|---|
| `invoicedQuantity` | Facturado en la línea de factura |
| `assignedToShipmentsQuantity` | Suma planificada de **todas** las líneas de embarque no canceladas (de cualquier importación) que usan esa línea de factura |
| `receivedQuantity` | Recibido físicamente en la factura (recepciones `ACTIVE` de **Compras o Importaciones**) |
| `shipmentLineQuantity` | Cantidad embarcada de **esta** línea |
| `linkedQuantity` | Parte de esta línea de embarque ya vinculada (vínculos `ACTIVE`) a mercadería recibida |
| `pendingQuantity` | **Pendiente de esta importación** = `shipmentLineQuantity − linkedQuantity` |
| `invoicePendingReceivableQuantity` | Pendiente de **toda la factura** = `invoicedQuantity − receivedQuantity` |
| `maxReceivableNow` | Máximo recibible hoy = `min(pendingQuantity, invoicePendingReceivableQuantity)` |

Las cantidades son decimales con **3 decimales**, como texto (`"10.000"`), y respetan la unidad de la línea.

### 2.3 `GET …/receiving` (resumen)

```json
{
  "importOperationId": "uuid", "reference": "IMP-2026-000001", "status": "IN_PROGRESS",
  "purchaseInvoiceId": "uuid", "purchaseInvoiceStatus": "CONFIRMED", "isLegacyUnlinked": false,
  "canReceive": true, "cannotReceiveReason": null,
  "pendingQuantityTotal": "6.000",
  "canComplete": false, "cannotCompleteReason": "Quedan cantidades pendientes de recibir",
  "shipments": [{
    "importShipmentId": "uuid", "status": "ARRIVED", "canReceive": true,
    "lines": [{
      "importShipmentLineId": "uuid", "productId": "uuid", "sku": "SKU-1", "description": "Carga",
      "unitCode": "UND", "purchaseInvoiceLineId": "uuid", "isReceivable": true,
      "invoicedQuantity": "10.000", "assignedToShipmentsQuantity": "10.000", "receivedQuantity": "4.000",
      "shipmentLineQuantity": "10.000", "linkedQuantity": "4.000", "pendingQuantity": "6.000",
      "invoicePendingReceivableQuantity": "6.000", "maxReceivableNow": "6.000",
      "candidateReceiptLines": [{
        "purchaseReceiptLineId": "uuid", "purchaseReceiptId": "uuid", "receivedDate": "2026-11-20",
        "receivedQuantity": "6.000", "linkedElsewhereQuantity": "0.000", "availableToLinkQuantity": "6.000"
      }]
    }]
  }]
}
```

* `canReceive` es `false` si la operación es histórica sin factura, no está `IN_PROGRESS` o la factura no está
  `CONFIRMED` (`cannotReceiveReason` explica la razón). Por embarque, `canReceive` exige además `status = ARRIVED`.
* `candidateReceiptLines` lista las líneas de recepciones `ACTIVE` **ya registradas** de esa línea de factura con
  cantidad aún no vinculada: son las elegibles para `link-receipts`.
* Líneas no recibibles (servicios, bienes no inventariables) llevan `isReceivable: false` y no cuentan como pendientes.

### 2.4 `POST …/receive`

```json
{
  "receivedDate": "2026-11-23",
  "notes": "Recepción en almacén central",
  "lines": [
    { "importShipmentLineId": "uuid", "quantity": "4.000", "locationId": "uuid" }
  ],
  "completeOperation": false
}
```

* `receivedDate`: opcional (por defecto hoy, zona Lima). `locationId`: opcional (por defecto el almacén principal
  `MAIN/DEFAULT`); el almacén y la ubicación deben estar activos. Una misma línea de factura con varias líneas de
  embarque debe usar la misma ubicación.
* Permite **recepciones parciales** y sucesivas hasta completar. No se puede recibir más que
  `pendingQuantity` de la línea de embarque **ni** más que lo disponible de la factura (considerando las recepciones
  registradas desde Compras).
* Requiere embarque `ARRIVED` y operación `IN_PROGRESS` con factura `CONFIRMED`; una importación vinculada a una
  factura `DRAFT` no puede recibir.

Respuesta (`ImportReceivingResult`):

```json
{
  "requestId": "uuid",
  "idempotentReplay": false,
  "mode": "RECEIVE",
  "receipt": { "id": "uuid", "status": "ACTIVE", "lines": [ { "id": "uuid", "purchaseInvoiceLineId": "uuid", "quantity": "4.000", "location": { … } } ], … },
  "links": [ { "id": "uuid", "importShipmentLineId": "uuid", "purchaseReceiptLineId": "uuid", "linkedQuantity": "4.000", "status": "ACTIVE", … } ],
  "operationCompleted": false,
  "operation": { "id": "uuid", "status": "IN_PROGRESS", … }
}
```

### 2.5 `POST …/link-receipts` (recepción ya registrada)

```json
{
  "links": [
    { "importShipmentLineId": "uuid", "purchaseReceiptLineId": "uuid", "linkedQuantity": "6.000" }
  ],
  "completeOperation": false
}
```

Vincula cantidades de recepciones `ACTIVE` ya existentes al embarque: **no** genera movimientos de stock, valorización
ni asientos. Se valida que la recepción corresponda a la misma línea de factura que la línea de embarque, que la
cantidad no exceda lo embarcado ni lo recibido **sin vincular** (una recepción nunca se atribuye dos veces, aunque la
factura participe en varias importaciones) y que no haya vínculos duplicados. `receipt` es `null` en la respuesta
(`mode: "LINK_EXISTING"`).

### 2.6 «Recibir mercadería y completar»

Con `completeOperation: true` (en `receive` o `link-receipts`) la operación se completa **en la misma transacción**
y solo si se cumple **todo**:

1. la operación está `IN_PROGRESS` y no queda ningún embarque `PLANNED` o `IN_TRANSIT`;
2. tras esta recepción/vinculación no queda cantidad pendiente recibible en ningún embarque no cancelado
   (`pendingQuantityTotal = 0`);
3. se cumplen las reglas de cierre existentes (`POST /import-operations/:id/complete`).

Si alguna condición falla responde `409` (`IMPORT_PENDING_QUANTITIES` u otro) y **no se registra nada**: ni
recepción, ni stock, ni valorización, ni vínculos, ni cambio de estado. El mismo comportamiento de todo o nada aplica
ante cualquier fallo interno. El endpoint existente `POST /import-operations/:id/complete` **no cambia** (sigue sin
exigir recepción; completar nunca mueve stock).

### 2.7 Idempotencia (`Idempotency-Key`)

* Obligatoria en ambos `POST`; única por operación de importación. Genere un UUID por intento de usuario y
  **reutilícelo en reintentos** (doble clic, reintento HTTP, recarga).
* Misma clave y **mismo contenido** → se devuelve el resultado original (`idempotentReplay: true`); no se duplican
  recepción, stock, valorización ni vínculos. Misma clave y contenido distinto → `409 IDEMPOTENCY_KEY_CONFLICT`.
* Solicitudes concurrentes con la misma clave producen un único efecto; con claves distintas que intenten consumir el
  mismo pendiente, solo una prospera (la otra recibe `409`). Lo mismo ocurre entre una recepción desde Compras y otra
  desde Importaciones sobre la misma factura.

### 2.8 Errores (principales)

| HTTP | `code` | Cuándo |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Campos inválidos (`errors[]` con rutas como `lines[0].quantity`) |
| 400 | `IDEMPOTENCY_KEY_REQUIRED` / `IDEMPOTENCY_KEY_INVALID` | Cabecera ausente o inválida |
| 400 | `DUPLICATE_SHIPMENT_LINE` / `DUPLICATE_LINK` / `QUANTITY_MUST_BE_POSITIVE` / `SHIPMENT_LINE_NOT_IN_SHIPMENT` / `LOCATION_CONFLICT` | Entrada inconsistente (con `field`) |
| 403 | — | Rol sin permiso |
| 404 | — | Operación, embarque, ubicación o recepción inexistentes |
| 409 | `IMPORT_NOT_LINKED_TO_INVOICE` | Operación histórica sin factura |
| 409 | `IMPORT_OPERATION_NOT_ACTIVE` | La operación no está `IN_PROGRESS` |
| 409 | `SHIPMENT_NOT_ARRIVED` | El embarque no está `ARRIVED` |
| 409 | `PURCHASE_INVOICE_NOT_CONFIRMED` | La factura no está `CONFIRMED` |
| 409 | `IMPORT_QUANTITY_EXCEEDS_PENDING` (`field: lines[i].quantity`) | Excede el pendiente de la línea de embarque |
| 409 | `INVOICE_QUANTITY_EXCEEDED` (`field: lines[i].quantity`) | Excede lo disponible de la factura |
| 409 | `SHIPMENT_LINE_NOT_RECEIVABLE` | Línea de servicio o no inventariable |
| 409 | `IMPORT_PENDING_QUANTITIES` | Cierre solicitado con cantidades pendientes |
| 409 | `IDEMPOTENCY_KEY_CONFLICT` | Misma clave con contenido distinto |
| 409 | (general) | Stock/ubicación inválidos o inactivos, vínculo excedido, recepción anulada |

Eventos de auditoría (usuario real): `IMPORT_RECEIVING_RECEIVED` / `IMPORT_RECEIVING_LINKED` (más los existentes
`PURCHASE_RECEIPT_CREATED`, `IMPORT_RECEIPT_LINK_CREATED` e `IMPORT_OPERATION_COMPLETED`).

---

## 3. Despliegue: almacenamiento persistente de documentos

| Variable | Descripción | Valor por defecto |
|---|---|---|
| `PURCHASE_DOCUMENTS_DIR` | Raíz del almacenamiento **privado** de documentos de compra | `uploads/purchase-documents` |

* **Persistencia:** en producción debe apuntar a un **volumen persistente** del contenedor/servidor (nunca a un
  directorio temporal ni a un sistema de archivos efímero), de lo contrario los archivos se pierden al reiniciar o
  desplegar mientras los registros siguen en PostgreSQL (la API respondería `404 ATTACHMENT_FILE_MISSING`).
* **Privacidad:** el directorio **no debe publicarse** por Nginx ni ningún servidor web ni montarse como ruta
  estática; los archivos solo se sirven por la API autenticada. Las claves físicas son aleatorias
  (`<2 hex>/<64 hex>.<ext>`) y nunca derivan del nombre original.
* **Permisos del proceso:** el usuario del proceso de la API necesita lectura/escritura sobre la raíz (se crean
  carpetas `0700` y archivos `0600`). Ningún otro usuario debería poder leerla.
* **Respaldo y recuperación:** los archivos y la base de datos forman **un solo conjunto de datos**: respalde el
  directorio junto con `pg_dump` en la misma ventana y restáurelos juntos. Un respaldo de la base sin el directorio
  deja registros que apuntan a archivos ausentes. Tras un fallo del proceso entre guardar el archivo y registrar la
  fila pueden quedar archivos huérfanos inaccesibles (no hay filas que los referencien): son inocuos y pueden
  depurarse comparando el directorio con `purchase_invoice_attachments.storage_key`.
* **Réplicas:** con varias instancias de la API todas deben compartir el mismo volumen. Un almacenamiento de objetos
  (S3 privado) solo requiere un nuevo proveedor del token `PURCHASE_DOCUMENT_STORAGE`.
* **Tamaño de petición:** si hay un proxy inverso delante de la API, permita cuerpos de al menos 10 MB (por ejemplo
  `client_max_body_size 11m;` en Nginx) para que el límite lo aplique la API (`413`).

## 4. Migración

`20261125000000_add_purchase_attachments_and_import_receiving` (aditiva; requiere las migraciones 1–39): tablas
`purchase_invoice_attachments` e `import_receiving_requests`, dos enums y la columna **nullable**
`import_receipt_links.receiving_request_id`. No modifica ni reescribe datos históricos (facturas, importaciones,
recepciones y vínculos existentes quedan intactos; no requiere backfill).
