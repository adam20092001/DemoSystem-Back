# PURCHASING — Compras e Importaciones completas (R3) — contrato REST y matriz de permisos para Angular

> **Estado: implementado en la rama `feat/r3-purchasing-full-access`. NO está integrado en `main` ni desplegado.**
> Sin migraciones nuevas. **Reemplaza** la matriz de compras de R1 ([purchasing-role-api.md](purchasing-role-api.md)) en lo que
> respecta a `PURCHASING`; el resto de roles conserva exactamente su matriz anterior.

El rol `PURCHASING` opera ahora el proceso completo de **Compras e Importaciones**: proveedores, facturas de compra, recepciones,
cuentas y pagos a proveedores, operaciones de importación, embarques, gastos, distribución de gastos, vínculos importación–recepción y
reportes/exportaciones de importaciones. **No** obtiene permisos de ADMIN: usuarios, roles, configuración, contabilidad, ventas,
clientes, inventario manual y transferencias siguen cerrados (403).

Base: `/api/v1`. Autenticación: cookie HttpOnly. Importes y cantidades siempre como **string**. Fechas `YYYY-MM-DD`.
Cuerpos exactos en Swagger (`/api/docs`).

> **El frontend solo oculta opciones.** La autorización vive en el backend: cada ruta se autoriza únicamente con el **rol activo** de la
> sesión (`activeRole`). Tener `ADMIN` asignado no da permisos de ADMIN mientras el rol activo sea `PURCHASING`.

Todas las reglas de negocio se mantienen **idénticas** para `PURCHASING`: estados de cada documento, límites de cantidades, saldos,
idempotencia, vínculos y anulaciones. Un 409 por estado inválido no deja de serlo porque cambie el rol. La auditoría registra siempre al
usuario real que ejecuta la acción (`PURCHASING`), nunca a un administrador.

---

## 1. Matriz de permisos (rol activo `PURCHASING`)

Leyenda: ✅ habilitado · 🔒 siempre 403 · «Estados» = estados del documento en los que la acción procede (en cualquier otro responde 409).

### 1.1 Proveedores — `/suppliers`

| Acción | Método y ruta | PURCHASING | Estados | Campos obligatorios | Errores relevantes |
|---|---|---|---|---|---|
| Listar / ver | `GET /suppliers`, `GET /suppliers/:id` | ✅ | — | — | 404 inexistente |
| Crear | `POST /suppliers` | ✅ | — | `documentType`, `documentNumber`, `legalName` | 409 documento duplicado, 400 validación |
| Editar | `PATCH /suppliers/:id` | ✅ | proveedor existente | al menos un campo editable | 404, 409 duplicado |
| Activar / desactivar | `POST /suppliers/:id/activate`, `.../deactivate` | 🔒 solo ADMIN | — | — | 403 |

### 1.2 Facturas de compra — `/purchase-invoices`

| Acción | Método y ruta | PURCHASING | Estados | Campos obligatorios | Errores relevantes |
|---|---|---|---|---|---|
| Listar / ver | `GET /purchase-invoices`, `GET /purchase-invoices/:id` | ✅ | — | — | 404 |
| Crear (nace `DRAFT`) | `POST /purchase-invoices` | ✅ | — | `supplierId`, `documentType`, `documentNumber`, `issueDate`, `lines[]` | 400, 404 proveedor, 409 documento duplicado |
| Editar | `PATCH /purchase-invoices/:id` | ✅ | solo `DRAFT` | campos a cambiar (`lines` reemplaza el arreglo completo) | 409 si `CONFIRMED`/`CANCELLED` |
| Confirmar | `POST /purchase-invoices/:id/confirm` | ✅ **(nuevo en R3)** | `DRAFT` → `CONFIRMED` | — | 409 estado inválido o mapeos contables sin configurar |
| Anular | `POST /purchase-invoices/:id/cancel` | ✅ **(nuevo en R3)** | `CONFIRMED` → `CANCELLED` (y las que ya permite el negocio) | `reason` | 409 estado/recepciones activas |

### 1.3 Recepciones de mercadería

| Acción | Método y ruta | PURCHASING | Estados | Campos obligatorios | Errores relevantes |
|---|---|---|---|---|---|
| Vistas de recepción pendiente | `GET /purchase-receiving/invoices`, `GET /purchase-receiving/invoices/:id` | ✅ **(nuevo)** | facturas `CONFIRMED` con líneas elegibles pendientes | — | 404, 409 si no está `CONFIRMED` (detalle) |
| Listar recepciones de una factura | `GET /purchase-invoices/:id/receipts` | ✅ (vista completa, con importes) | — | — | 404 |
| Ver recepción | `GET /purchase-receipts/:id` | ✅ (vista completa) | — | — | 404 |
| Registrar recepción | `POST /purchase-invoices/:id/receipts` | ✅ **(nuevo)** | factura `CONFIRMED` | `lines[{ purchaseInvoiceLineId, quantity, locationId? }]`; `idempotencyKey?` | 409 excede lo facturado/factura no `CONFIRMED`, 404 ubicación inexistente, 409 ubicación/almacén inactivos |
| Anular recepción | `POST /purchase-receipts/:id/cancel` | ✅ **(nuevo)** | `ACTIVE` → `CANCELLED` | `reason` | 409 si hay vínculo de importación ACTIVO o el saldo de la ubicación original no alcanza |

### 1.4 Cuentas por pagar y pagos a proveedores

| Acción | Método y ruta | PURCHASING | Estados | Campos obligatorios | Errores relevantes |
|---|---|---|---|---|---|
| Listado, detalle, resumen, antigüedad, conciliación | `GET /accounts-payable`, `/accounts-payable/:purchaseInvoiceId`, `/summary`, `/aging`, `/reconciliation` | ✅ | — | — | 404 |
| Exportaciones Excel | `GET /accounts-payable/export.xlsx`, `/summary/export.xlsx`, `/aging/export.xlsx`, `/reconciliation/export.xlsx` | ✅ | — | — | 400 si excede el máximo de filas |
| Listar / ver pagos | `GET /supplier-payments`, `GET /supplier-payments/:id` | ✅ **(nuevo)** | — | — | 404 |
| Registrar pago | `POST /supplier-payments` | ✅ **(nuevo)** | facturas `CONFIRMED` con saldo | `supplierId`, `amount`, `method`, `allocations[{ purchaseInvoiceId, amount }]`; `paymentDate?`, `reference?`, `idempotencyKey?` | 409 supera el saldo/factura no pagable, 404 método inexistente, 409 método inactivo o referencia exigida |
| Anular pago | `POST /supplier-payments/:id/cancel` | ✅ **(nuevo)** | `ACTIVE` → `CANCELLED` | `reason` | 409 ya anulado |

### 1.5 Importaciones — operaciones, embarques, gastos, distribución y vínculos

Todas las rutas de lectura **y** escritura estaban solo para ADMIN (lectura también MANAGEMENT/ACCOUNTANT); ahora `PURCHASING` las opera.

| Acción | Método y ruta | Estados |
|---|---|---|
| Listar / ver operación | `GET /import-operations`, `GET /import-operations/:id` | — |
| Crear operación | `POST /import-operations` (`reference`, `originCountry`, `destinationCountry`) | nace `DRAFT` |
| Editar operación | `PATCH /import-operations/:id` | cualquiera salvo `COMPLETED`/`CANCELLED` (409) |
| Completar operación | `POST /import-operations/:id/complete` | `IN_PROGRESS` → `COMPLETED`; 409 si quedan embarques `PLANNED`/`IN_TRANSIT` |
| Anular operación | `POST /import-operations/:id/cancel` (`reason`) | `DRAFT`/`IN_PROGRESS`; 409 si tiene un embarque `ARRIVED` |
| Listar / crear embarque | `GET`/`POST /import-operations/:id/shipments` (`transportMode`, `lines[]`) | operación no terminal |
| Ver / editar embarque | `GET`/`PATCH /import-shipments/:id` | `PLANNED` (edición) |
| Zarpar / arribar | `POST /import-shipments/:id/depart`, `/arrive` | `PLANNED` → `IN_TRANSIT` → `ARRIVED` |
| Anular embarque | `POST /import-shipments/:id/cancel` (`reason`) | 409 si ya `ARRIVED`/`CANCELLED` |
| Listar / crear gasto | `GET`/`POST /import-operations/:id/expenses` (`category`, `expenseDate`, `currencyCode`, `amount`) | nace `DRAFT` |
| Ver / editar gasto | `GET`/`PATCH /import-expenses/:id` | `DRAFT` (edición); 409 si `FINALIZED` |
| Finalizar gasto | `POST /import-expenses/:id/finalize` | `DRAFT` → `FINALIZED` |
| Anular gasto | `POST /import-expenses/:id/cancel` (`reason`) | 409 si ya `CANCELLED` |
| Previsualizar distribución | `POST /import-expenses/:id/allocate/preview` → **200** | sin efectos persistentes |
| Distribuir gasto | `POST /import-expenses/:id/allocate` → **201** (`method`, `amountToAllocate`, `manualAllocations?`/`shipmentLineIds?`, `idempotencyKey?`) | gasto `DRAFT` o `FINALIZED` |
| Ver distribuciones | `GET /import-expenses/:id/allocations` | — |
| Previsualizar atribución de costo | `GET /import-expense-allocations/:id/cost-attribution-preview` | — |
| Listar / crear vínculo con recepción | `GET`/`POST /import-shipment-lines/:id/receipt-links` (`purchaseReceiptLineId`, `linkedQuantity`, `idempotencyKey?`) | embarque `ARRIVED`; recepción `ACTIVE`; mismas facturas; cantidades dentro de lo embarcado/recibido |
| Desvincular | `POST /import-receipt-links/:id/cancel` (`reason`) | `ACTIVE` → `CANCELLED` |

### 1.6 Reportes y exportaciones de importaciones (solo lectura, todas ✅)

`GET /import-reports/operations`, `/shipments`, `/expenses`, `/reconciliation` y cada una con `…/export.xlsx`.

### 1.7 Lecturas auxiliares habilitadas (solo lo estrictamente necesario)

| Para qué | Ruta | PURCHASING |
|---|---|---|
| Elegir `locationId` de una recepción | `GET /warehouses`, `GET /warehouses/:id`, `GET /warehouses/:id/locations`, `GET /warehouses/:id/locations/:locationId` | ✅ **(nuevo, solo lectura)** |
| Elegir `method` de un pago | `GET /payment-methods` (solo métodos activos) | ✅ **(nuevo, solo lectura)** |
| Productos, categorías, unidades, impuestos (R1) | `GET /products*`, `/categories`, `/units`, `GET /configuration/pos` | ✅ (sin cambios) |

### 1.8 Lo que sigue prohibido (siempre 403) para `PURCHASING`

- Usuarios y roles: `/users*`, `/roles`. Credenciales y sesiones ajenas.
- Configuración: `GET`/`PATCH /configuration` (solo `GET /configuration/pos` de solo lectura).
- Auditoría (`/audit`), contabilidad (`/accounting/*`, `/chart-of-accounts*`), ventas, cotizaciones, clientes, cobros, dashboard, reportes comerciales.
- Inventario manual y transferencias: `POST /inventory/*`, `GET /inventory/movements*`, `GET /inventory/products/:id/stock*`, `/inventory/transfers*`.
- Administración de catálogos: crear/editar productos, categorías, unidades, almacenes, ubicaciones y métodos de pago; `GET /payment-methods?includeInactive=true`.
- Activar/desactivar proveedores.

### 1.9 Matriz por rol, después de R3 (compras e importaciones)

| Acción | ADMIN | MANAGEMENT | PURCHASING | WAREHOUSE | ACCOUNTANT | SELLER |
|---|---|---|---|---|---|---|
| Leer facturas de compra / cuentas por pagar | sí | sí | sí | no | sí | no |
| Crear / editar DRAFT | sí | no | sí | no | no | no |
| Confirmar / anular factura | sí | sí | **sí** | no | no | no |
| Registrar recepción | sí | no | **sí** | sí (sin importes) | no | no |
| Anular recepción | sí | no | **sí** | no | no | no |
| Pagos a proveedores: leer | sí | sí | **sí** | no | sí | no |
| Pagos a proveedores: registrar / anular | sí | no | **sí** | no | no | no |
| Importaciones: leer (operaciones, embarques, gastos, vínculos, reportes) | sí | sí | **sí** | no | sí | no |
| Importaciones: escribir | sí | no | **sí** | no | no | no |
| Crear/editar proveedor | sí | no | sí | no | no | no |
| Activar/desactivar proveedor | sí | no | no | no | no | no |

---

## 2. Cómo armar el flujo en Angular

1. **Sesión.** `GET /auth/me` → `role`/`activeRole = "PURCHASING"`. Cargar menús de Compras e Importaciones solo con ese rol activo.
2. **Compra.** Proveedor → factura (`DRAFT`, editable) → **confirmar** → recepción (elegir ubicación con `GET /warehouses` y
   `GET /warehouses/:id/locations`; si se omite `locationId`, el backend usa `MAIN/DEFAULT`) → cuenta por pagar → pago (`GET /payment-methods`
   para el selector) → anulaciones en orden inverso (pago → recepción → factura).
3. **Importación.** Operación → embarque (con líneas, opcionalmente atadas a una línea de factura) → `depart` → `arrive` → gasto →
   `allocate/preview` → `allocate` → `finalize` → recepción real → vínculo → (desvincular si corresponde) → `complete`.
4. **Idempotencia.** Recepciones, pagos, distribuciones y vínculos aceptan `idempotencyKey`: reenviar la misma clave devuelve el documento
   original sin duplicar; la misma clave con contenido distinto responde 409.
5. **Errores.** 400 validación; 401 sin sesión; **403 solo para rutas fuera del alcance de la sección 1.8**; 404 inexistente; 409 estado,
   saldo, cantidad o regla de negocio.

## 3. Acciones que siguen dependiendo de otro rol o sin endpoint

- **Activar/desactivar proveedor:** solo `ADMIN`.
- **Consultar stock por ubicación antes de recibir:** `GET /inventory/products/:id/stock*` no está habilitado para `PURCHASING`
  (no es necesario para recibir; la recepción suma stock). Si el frontend lo necesita, requiere una decisión adicional.
- **Mapeos contables** (`PATCH /chart-of-accounts/system-keys/:key`) siguen siendo de `ADMIN`: mientras un mapeo requerido no esté
  configurado, **confirmar** una factura responde 409 también para `PURCHASING`.
- **Crear productos, categorías, unidades, almacenes y ubicaciones:** solo `ADMIN` (`WAREHOUSE`/`ADMIN` según el catálogo).
- No existe un endpoint para **eliminar** documentos de compra o importación (nada se borra; se anula).
